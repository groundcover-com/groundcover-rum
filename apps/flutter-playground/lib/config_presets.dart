// Every SDK config the e2e suite needs, keyed by preset name: the counterpart
// of apps/rn-playground/src/config-presets.ts. One preset per behaviour that
// can only be chosen at init (sampling, privacy levels, the callbacks,
// enabledEvents). Each preset states the block it replaces outright, because a
// deep merge would hide a mistyped key behind the default.
import 'dart:convert';
import 'dart:io';

import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:path_provider/path_provider.dart';

import 'config_env.dart' as env;

/// The label an event must carry for the `callbacks` preset to drop it.
const dropMarker = 'DROPME';

/// The attribute the `callbacks` preset's enrichEvent stamps on every event.
const enrichKey = 'e2e_enriched';
const enrichValue = 'by-enrich-event';

/// What the `custom-redact` preset's hook puts in place of an `email` leaf.
const customRedaction = 'e2e-custom-redaction';

/// The file the harness writes into the app's documents directory to pick a
/// preset: `{"preset": "<name>"}`. Flutter has no hot bundle to rewrite, and
/// Mobilewright cannot pass launch arguments, so this is how a spec boots the
/// app with a different init-time config.
const presetFileName = 'e2e-preset.json';

/// The preset name in [presetFileName], or null when there is none.
Future<String?> readPresetFile() async {
  final dir = await getApplicationDocumentsDirectory();
  final file = File('${dir.path}/$presetFileName');
  if (!await file.exists()) return null;
  final decoded = jsonDecode(await file.readAsString());
  return decoded is Map ? decoded['preset'] as String? : null;
}

GroundcoverOptions _baseOptions({
  double? sessionSampleRate,
  List<RumEventName>? enabledEvents,
  BeforeSend? beforeSend,
  EnrichEvent? enrichEvent,
  PrivacyOptions? privacy,
  TransportOptions? transport,
  NativeOptions? native,
}) {
  return GroundcoverOptions(
    debug: true,
    sessionSampleRate: sessionSampleRate,
    enabledEvents: enabledEvents,
    beforeSend: beforeSend,
    enrichEvent: enrichEvent,
    privacy: privacy,
    // Flush fast so the specs don't wait out the 10 s default. Compression
    // stays on, unlike RN: dart:io sends the Content-Encoding header that
    // OkHttp strips, and the mock ingest decodes gzip, so the device run
    // exercises the shipping default.
    transport: transport ?? const TransportOptions(batchTimeout: _flushFast),
    // Trace headers on everything, so the echo replays them back.
    tracing: const TracingOptions(propagationUrls: ['*']),
    native: native ?? _baseNative,
  );
}

const _flushFast = Duration(milliseconds: 500);

/// rn-playground's native block, restated per preset like RN's, so a preset
/// replaces it outright rather than merging into it.
const _baseNative = NativeOptions(
  // Well below Android's 5 s default, so the hang specs can drive one with
  // their 3 s stall without waiting out a real ANR (or the system killing
  // the app first).
  hangThreshold: _hangThreshold,
  // The production default, restated so it can't drift out from under the
  // vitals specs: a segment must close only on a navigation or on
  // backgrounding during a test. `vitals-fast` is where a short cap is
  // wanted.
  vitalsMaxSegment: _vitalsMaxSegment,
);
const _hangThreshold = HangThreshold(Duration(seconds: 1));
const _vitalsMaxSegment = Duration(seconds: 60);

/// The presets rn-playground defines. One table, so a name can't be accepted
/// and then boot the default config instead.
final Map<String, GroundcoverOptions Function()> _presets = {
  'default': _baseOptions,
  // The only preset for a real device against a real cluster
  // (apps/DEVICE_TESTING.md). Every other preset is tuned for
  // the mock ingest in ways that are wrong there: a flush every 500 ms, a
  // `traceparent` on third-party hosts, 1 s stalls reported as hangs, and a
  // debug line per event on the isolate being measured. It states no native
  // block on purpose, so the run exercises the SDK's shipping defaults
  // (Android's 5 s hang threshold, the 60 s segment cap). Compression stays
  // on, the default: dart:io keeps the Content-Encoding header that OkHttp
  // strips on RN.
  'device': () => GroundcoverOptions(
    debug: env.debugRequested,
    tracing: const TracingOptions(propagationUrls: env.devicePropagationUrls),
  ),
  // An explicit 0, not null: null means "sample everything".
  'unsampled': () => _baseOptions(sessionSampleRate: 0),
  'mask-all': () =>
      _baseOptions(privacy: const PrivacyOptions(level: PrivacyLevel.maskAll)),
  'allow': () =>
      _baseOptions(privacy: const PrivacyOptions(level: PrivacyLevel.allow)),
  'no-body-mask': () =>
      _baseOptions(privacy: const PrivacyOptions(maskNetworkBodies: false)),
  'custom-redact': () => _baseOptions(
    privacy: PrivacyOptions(
      // Benign to the built-in rules; naming it proves the extra keys are
      // consulted at all.
      sensitiveKeys: const ['order_id'],
      // Overrides one leaf and defers everywhere else by returning null,
      // the contract that stops a hook from disabling masking wholesale.
      redact: (field) => field.key == 'email' ? customRedaction : null,
    ),
  ),
  'callbacks': () => _baseOptions(
    // Attributes arrive dot-flattened, so the label is one flat key.
    beforeSend: (event) =>
        !'${event.attributes['interaction_target.label'] ?? ''}'.contains(
          dropMarker,
        ),
    enrichEvent: (event) => event..attributes[enrichKey] = enrichValue,
  ),
  // A host callback that throws must not take the event stream down.
  'callbacks-throw': () => _baseOptions(
    beforeSend: (_) => throw StateError('e2e beforeSend throws on purpose'),
  ),
  'crashes-only': () =>
      _baseOptions(enabledEvents: const [RumEventName.crashes]),
  // At the base 500 ms timeout everything flushes on its own before a spec can
  // press HOME, so only a long timer proves the background flush.
  'slow-flush': () => _baseOptions(
    transport: const TransportOptions(batchTimeout: Duration(seconds: 60)),
  ),
  'tti-manual': () => _baseOptions(
    native: const NativeOptions(
      hangThreshold: _hangThreshold,
      vitalsMaxSegment: _vitalsMaxSegment,
      tti: TtiMode.manual,
    ),
  ),
  // A 2 s threshold against the specs' 3 s stall: the margin that makes a
  // watchdog which samples for stalls, rather than measuring them, miss some
  // of five identical ones. rn-playground's reasoning, in its config-presets.
  // Don't raise it without recomputing that margin.
  'hang-sampling': () => _baseOptions(
    native: const NativeOptions(
      hangThreshold: HangThreshold(Duration(seconds: 2)),
      vitalsMaxSegment: _vitalsMaxSegment,
    ),
  ),
  // The only preset with a short segment cap: at the 60 s default a spec
  // would have to dwell on one screen for a minute to see a `safety` close.
  'vitals-fast': () => _baseOptions(
    native: const NativeOptions(
      hangThreshold: _hangThreshold,
      vitalsMaxSegment: Duration(seconds: 2),
    ),
  ),
};

/// The preset to boot with: a compiled-in `GC_PRESET` wins, as RN's
/// `EXPO_PUBLIC_GC_PRESET` does, then the one the harness wrote into the app's
/// data ([fromFile]), then `default`. An unknown name fails the launch loudly,
/// because booting the default instead would let a preset spec pass on the
/// wrong config.
String resolvePreset(String? fromFile) {
  final requested = env.compiledPreset.isNotEmpty
      ? env.compiledPreset
      : (fromFile ?? '').trim();
  if (requested.isEmpty) return 'default';
  if (!_presets.containsKey(requested)) {
    throw ArgumentError.value(
      requested,
      'preset',
      'not a known preset; known presets: ${_presets.keys.join(', ')}',
    );
  }
  return requested;
}

GroundcoverConfig configFor(String preset) {
  final options = _presets[preset]!();

  return GroundcoverConfig(
    dsn: env.dsn,
    apiKey: env.apiKey,
    appId: 'flutter-playground',
    cluster: 'playground',
    // Fixed per preset rather than compiled in, so a device session lands
    // under a known identity.
    environment: preset == 'device' ? 'device-test' : 'dev',
    releaseId: env.releaseId,
    options: options,
  );
}
