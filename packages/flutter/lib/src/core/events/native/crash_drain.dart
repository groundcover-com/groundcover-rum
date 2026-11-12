// Reports crashes that killed a PREVIOUS run. A crashed session is over, and
// its envelope isn't the one this run would stamp, so the drain bypasses the
// events pool and sends each record as a batch of its own, under the snapshot
// the engine filed at crash time. The current session never touches these.
//
// At least once: the engine keeps a record until its batch is delivered, and
// `crash_report_id` is stable across redeliveries, so a duplicate can be
// recognised. Losing a fatal is far worse than reporting it twice.
import 'dart:convert';

import '../../common/hooks.dart';
import '../../common/ids.dart';
import '../../common/json.dart';
import '../../common/logger.dart';
import '../../common/text.dart';
import '../../common/time.dart';
import '../../config/config_manager.dart';
import '../../config/types.dart';
import '../../privacy/privacy_config.dart';
import '../../privacy/redaction.dart';
import '../../pipeline/rum_pipeline.dart' show NativeCrashStore;
import '../../transport/transporter.dart';
import '../captures.dart';
import '../event_enricher.dart';
import '../rum_event.dart';
import 'stack_frames.dart';

/// A crash record as the engine filed it, coerced at the trust boundary: the
/// JSON comes off the device's disk, possibly written by another SDK
/// version. Coerced, never dropped, apart from the ack key: each fallback is
/// what the drain uses for an absent field.
final class CrashRecord {
  const CrashRecord({
    required this.id,
    this.crashEpochMs,
    this.errorType = '',
    this.errorMessage = '',
    this.frames = const [],
    this.metadata = const {},
    this.sessionSnapshotJson,
    this.screen,
  });

  /// The ack key, and the `crash_report_id` a duplicate is recognised by.
  final String id;

  /// When it crashed, or null when the record lost it (the event then takes
  /// the time it is sent).
  final num? crashEpochMs;
  final String errorType;
  final String errorMessage;
  final List<ErrorFrame> frames;
  final Map<String, Object?> metadata;

  /// The session the engine filed it under.
  final String? sessionSnapshotJson;

  /// The crash-time screen, when the engine could read one.
  final ({String name, String key})? screen;
}

/// The cause chain a record may carry, above the producers' own cap
/// (Kotlin's 5; iOS writes none): a resource guard against a corrupt record,
/// not a restatement of their contract.
const _maxCauseEntries = 20;

/// The records in the engine's JSON array. Only one without an id is
/// dropped: it could never be acked, so it would be redelivered forever.
List<CrashRecord> parseCrashRecords(String json) {
  final Object? decoded;
  try {
    decoded = jsonDecode(json);
  } catch (error) {
    handleError(error);
    return const [];
  }
  if (decoded is! List) return const [];
  return [
    for (final raw in decoded)
      if (raw is Map && raw['id'] is String && (raw['id'] as String).isNotEmpty)
        _toRecord(raw),
  ];
}

CrashRecord _toRecord(Map<Object?, Object?> raw) {
  final epoch = raw['crashEpochMs'];
  final metadata = raw['metadata'];
  final snapshot = raw['sessionSnapshotJson'];
  return CrashRecord(
    id: raw['id'] as String,
    crashEpochMs: finiteNum(epoch),
    errorType: raw['errorType'] is String ? raw['errorType'] as String : '',
    errorMessage: raw['errorMessage'] is String
        ? raw['errorMessage'] as String
        : '',
    frames: stackFramesOf(raw['stacktrace']),
    metadata: metadata is Map
        ? _capCauses(metadata.cast<String, Object?>())
        : const {},
    sessionSnapshotJson: snapshot is String ? snapshot : null,
    screen: _screenOf(raw['screen']),
  );
}

Map<String, Object?> _capCauses(Map<String, Object?> metadata) {
  final causes = metadata['causes'];
  if (causes is! List || causes.length <= _maxCauseEntries) return metadata;
  return {...metadata, 'causes': causes.sublist(0, _maxCauseEntries)};
}

/// Both members strings, and not the engines' "couldn't read one" sentinel
/// (`{name: "", key: ""}`), so the snapshot's screen still applies then.
({String name, String key})? _screenOf(Object? value) {
  if (value is! Map) return null;
  final name = value['name'];
  final key = value['key'];
  if (name is! String || key is! String) return null;
  if (name.isEmpty && key.isEmpty) return null;
  return (name: name, key: key);
}

/// One drain per process. A second init while the first's requests are in
/// flight would read the same un-acked records and send them twice.
Future<void>? _inFlight;

/// Delivers every pending crash record, then acks each one delivered or
/// unsalvageable. Never throws.
Future<void> drainCrashReports({
  required NativeCrashStore store,
  required ConfigManager config,
  required IdGenerator ids,
  required Clock clock,
  required BatchSender sendBatch,
  Compressor? compressor,
}) {
  final running = _inFlight;
  if (running != null) return running;
  final pass = _drain(
    store: store,
    config: config,
    ids: ids,
    clock: clock,
    transporter: Transporter(
      config: config,
      sendBatch: sendBatch,
      compressor: compressor,
    ),
  ).catchError(handleError).whenComplete(() => _inFlight = null);
  return _inFlight = pass;
}

Future<void> _drain({
  required NativeCrashStore store,
  required ConfigManager config,
  required IdGenerator ids,
  required Clock clock,
  required Transporter transporter,
}) async {
  final records = parseCrashRecords(await store.pendingCrashReports());
  for (final record in records) {
    try {
      final ack = await _reportOne(record, config, ids, clock, transporter);
      if (ack) await store.clearPendingCrashReports([record.id]);
    } catch (error) {
      // Left un-acked: the next launch gets another attempt. Caught per
      // record, so one failure doesn't abandon the records behind it.
      handleError(error);
    }
  }
}

/// Whether to ack [record]: delivered, or unsalvageable.
Future<bool> _reportOne(
  CrashRecord record,
  ConfigManager config,
  IdGenerator ids,
  Clock clock,
  Transporter transporter,
) async {
  final snapshot = _snapshotOf(record.sessionSnapshotJson);
  // No envelope means no session to file it under. Sending it under the
  // current session would be worse than dropping it: it would put another
  // session's fatal into an unrelated one.
  if (snapshot == null) return true;
  final snapshotScreen = _screenOf(snapshot.remove('screen'));
  final screen = record.screen ?? snapshotScreen ?? (name: '', key: '');

  final enricher = EventEnricher(
    idGenerator: ids,
    clock: clock,
    platformAttributes: () => {
      'screen': {'name': screen.name, 'key': screen.key},
    },
  );
  var event = enricher.enrich(
    EnrichInput(
      type: 'exception',
      // When it crashed, not when it was reported.
      timestamp: record.crashEpochMs == null
          ? null
          : fractionalMsToNs(record.crashEpochMs!),
      attributes: _attributes(record, config.privacy),
    ),
  );

  // The pool runs these on addEvent; this path bypasses the pool, so it runs
  // them itself. Both are contained, with different answers. A throwing
  // beforeSend is unsalvageable: whether the app wanted the event is unknown,
  // and the live path drops it too, so it is acked rather than retried
  // forever. A false one is the app's choice, acked too. A throwing
  // enrichEvent costs only what it would have added: the built event is
  // already redacted and is sent as it is. The hook gets a copy, so a throw
  // after changing it leaves the report as built: the record is acked after
  // the send, and a half-changed report would be the only one left.
  final options = config.config.options;
  final beforeSend = options.beforeSend;
  if (beforeSend != null) {
    final bool keep;
    try {
      keep = runUserHook(() => beforeSend(event));
    } catch (error) {
      handleError(error);
      return true;
    }
    if (!keep) return true;
  }
  final enrichEvent = options.enrichEvent;
  if (enrichEvent != null) {
    final built = event;
    try {
      event = runUserHook(() => enrichEvent(copyRumEvent(built)));
    } catch (error) {
      handleError(error);
      event = built;
    }
  }

  return transporter.deliver((
    // The crashed session's envelope, verbatim: never the current one's.
    sessionAttributes: snapshot,
    events: [event.toJson()],
  ));
}

/// The snapshot's envelope, or null without a session id to file under.
Map<String, Object?>? _snapshotOf(String? json) {
  if (json == null || json.isEmpty) return null;
  final decoded = decodeJsonObject(json);
  final sessionId = decoded?['session_id'];
  if (sessionId is! String || sessionId.isEmpty) return null;
  return Map.of(decoded!);
}

Map<String, Object?> _attributes(CrashRecord record, EffectivePrivacy privacy) {
  final type = record.errorType.isEmpty ? 'NativeCrash' : record.errorType;
  // Masked exactly as a Dart error is: a crash message routinely carries
  // request context (a URL, an Authorization header), and maskErrors is on by
  // default.
  final opts = privacy.redactOptions(RedactKind.error);
  final mask = privacy.shouldMaskErrors;
  final rawMessage = record.errorMessage.isEmpty
      ? 'Native crash'
      : record.errorMessage;
  final message = mask ? redactText(rawMessage, opts) : rawMessage;
  // The engine's own metadata only; the markers after it are ours, and
  // crash_report_id must not be at the mercy of a key-name heuristic.
  final metadata = mask
      ? _redactCauseMessages(redactObject(record.metadata, opts), opts)
      : record.metadata;
  return {
    'error_type': type,
    'error_message': message,
    'error_stacktrace': [for (final frame in record.frames) frame.toJson()],
    // As a Dart error's, so native and Dart fatals group the same way; from
    // the masked message, or it would leak what the message just redacted.
    'error_fingerprint': '$type:${truncate(message, maxLength: 400)}',
    'error_handled': false,
    'error_metadata': {
      ...metadata,
      'native': true,
      'fatal': true,
      // Stable across redeliveries, so a duplicate can be recognised.
      'crash_report_id': record.id,
    },
  };
}

/// Scans the cause chain's messages as text. Metadata redaction is by key,
/// and `causes[].message` is free text the Android engine copied in, under a
/// key no heuristic calls sensitive; the `caused by` message is usually
/// where the real failure is described, so it is scrubbed, not blanked.
Map<String, Object?> _redactCauseMessages(
  Map<String, Object?> metadata,
  RedactOptions opts,
) {
  final causes = metadata['causes'];
  if (causes is! List) return metadata;
  return {
    ...metadata,
    'causes': [
      for (final cause in causes)
        if (cause is Map && cause['message'] is String)
          {...cause, 'message': redactText(cause['message'] as String, opts)}
        else
          cause,
    ],
  };
}

/// For tests: the in-flight guard is process state.
void debugResetCrashDrain() => _inFlight = null;
