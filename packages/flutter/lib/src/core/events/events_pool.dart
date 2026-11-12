import 'dart:async';

import '../common/hooks.dart';
import '../common/json.dart';
import '../common/logger.dart';
import '../config/config_manager.dart';
import '../config/constants.dart';
import '../session/session_state.dart';
import '../transport/transporter.dart';
import 'event_time.dart';
import 'rum_event.dart';

/// Events held while the send gate is closed (no presence yet), or while
/// there is no cluster to send under. Bounds a never-confirmed session (real
/// sessions confirm in seconds) and a cluster that never arrives (a missing
/// build define). On overflow the newest is dropped, keeping the earliest.
const maxGatedBufferEvents = 500;

/// An explicit 0 is honoured (every event flushes); anything negative falls
/// back to the default, so a bad value can't switch size flushing off.
int _resolveBatchSize(int? value) =>
    value != null && value >= 0 ? value : defaultBatchSize;

/// Zero is not honoured: a 0 ms timer would busy-flush.
Duration _resolveBatchTimeout(Duration? value) =>
    value != null && value > Duration.zero ? value : defaultBatchTimeout;

/// Host device metadata stamped on every batch envelope.
typedef DeviceAttributesProvider = Map<String, Object?> Function();

/// Buffers events, runs the `beforeSend` / `enrichEvent` hooks, and ships
/// batches on size, on a timer, or on demand.
final class EventsPool {
  EventsPool({
    required this._config,
    required this._session,
    required this._transporter,
    required this._deviceAttributes,
    required this._eventsToSkipFlush,
  });

  final ConfigManager _config;
  final SessionState _session;
  final Transporter _transporter;
  final DeviceAttributesProvider _deviceAttributes;

  /// Types that never trigger a size flush; they ride along with the next one.
  final Set<String> _eventsToSkipFlush;

  List<RumEvent> _events = [];
  Timer? _timer;
  bool _initialized = false;
  bool _noClusterWarned = false;
  void Function(RumEvent event)? _onBeforeEnqueue;
  bool Function()? _flushGate;

  void initialize() {
    if (_initialized) return;
    _scheduleFlush();
    _initialized = true;
  }

  void destroy() {
    _timer?.cancel();
    _timer = null;
    _events = [];
    _initialized = false;
  }

  /// Called with each accepted event just before it is buffered.
  void setBeforeEnqueueHook(void Function(RumEvent event)? hook) =>
      _onBeforeEnqueue = hook;

  /// While this returns false, sends hold instead of shipping.
  void setFlushGate(bool Function()? gate) => _flushGate = gate;

  /// Drops the buffer without sending: a rotating session that never saw a
  /// user must neither ship its events nor leak them into the next session.
  void discardBuffer() => _events = [];

  /// The earliest trusted time still buffered, for a rotation to start the
  /// new session no later than events that will ship under it.
  int? getEarliestEventTimestamp(int nowNs, int maxAgeNs) =>
      earliestTrustedEventTime(_events, nowNs, maxAgeNs);

  // A throwing gate fails open: silently dropping a real session forever is
  // worse than a rare ghost.
  bool _isFlushAllowed() {
    final gate = _flushGate;
    if (gate == null) return true;
    try {
      return gate();
    } catch (error) {
      handleError(error);
      return true;
    }
  }

  void addEvent(RumEvent? event) {
    if (event == null || !_initialized) return;
    try {
      final options = _config.config.options;
      var outgoing = event;

      final beforeSend = options.beforeSend;
      if (beforeSend != null && !runUserHook(() => beforeSend(outgoing))) {
        return;
      }

      // A throwing hook drops the event (the outer catch): nothing is
      // enqueued and nothing reconciles for an event that was never accepted.
      // The hook's type guarantees a RumEvent; what the event carries is made
      // JSON data below.
      final enrichEvent = options.enrichEvent;
      if (enrichEvent != null) {
        final enriched = outgoing;
        outgoing = runUserHook(() => enrichEvent(enriched));
      }

      // What a hook put in is the app's own: made JSON data now, so the batch
      // neither copies an app object to its encoding isolate nor fails on a
      // cycle. Without a hook, the attributes were shaped by the SDK.
      if (beforeSend != null || enrichEvent != null) {
        outgoing.attributes = toJsonMap(outgoing.attributes);
      }

      // After both hooks, still before enqueue: the observer drives session
      // reconciliation, and a rotation takes the new session's start from this
      // event, so it must see the event as it will ship (an enrichEvent may
      // have moved its timestamp).
      final hook = _onBeforeEnqueue;
      if (hook != null) {
        try {
          hook(outgoing);
        } catch (error) {
          handleError(error);
        }
      }

      // After the observer, so an event that just opened the gate is not capped.
      if ((!_isFlushAllowed() || _config.config.cluster.isEmpty) &&
          _events.length >= maxGatedBufferEvents) {
        return;
      }

      _events.add(outgoing);

      final batchSize = _resolveBatchSize(options.transport.batchSize);
      if (_events.length >= batchSize &&
          !_eventsToSkipFlush.contains(outgoing.type)) {
        flush();
      }
    } catch (error) {
      handleError(error);
    }
  }

  void flush({bool lifecycle = false}) {
    try {
      if (!_initialized) return;
      // Held (no presence yet): keep the buffer and the timer.
      if (!_isFlushAllowed()) {
        _scheduleFlush();
        return;
      }
      if (_events.isEmpty) {
        _scheduleFlush();
        return;
      }
      if (_config.config.cluster.isEmpty) {
        // The cluster can arrive by updateConfig, so keep the timer; warn once.
        if (!_noClusterWarned) {
          _noClusterWarned = true;
          RumDiagnostics.instance.log(
            '[events-pool.flush] skipping flush: no cluster',
          );
        }
        _scheduleFlush();
        return;
      }
      _noClusterWarned = false;
      final batch = (
        sessionAttributes: getSessionAttributes(),
        events: _events.map((e) => e.toJson()).toList(),
      );
      unawaited(_transporter.send(batch, lifecycle: lifecycle));
      _events = [];
      _scheduleFlush();
    } catch (error) {
      handleError(error);
    }
  }

  /// Sends the buffer now and waits for it to be handed over, before a
  /// session id is replaced. An unconfirmed session's events are discarded
  /// instead: they must not survive the id change.
  Future<void> flushSync() async {
    try {
      if (_events.isEmpty || !_initialized) return;
      if (!_isFlushAllowed()) {
        discardBuffer();
        return;
      }
      if (_config.config.cluster.isEmpty) {
        RumDiagnostics.instance.log(
          '[events-pool.flush] skipping flush: no cluster',
        );
        return;
      }
      final batch = (
        sessionAttributes: getSessionAttributes(),
        events: _events.map((e) => e.toJson()).toList(),
      );
      _events = [];
      await _transporter.send(batch);
    } catch (error) {
      handleError(error);
    }
  }

  void _scheduleFlush() {
    _timer?.cancel();
    final timeout = _resolveBatchTimeout(
      _config.config.options.transport.batchTimeout,
    );
    _timer = Timer(timeout, () {
      _timer = null;
      flush();
    });
  }

  /// The envelope a batch sent now would carry.
  Map<String, Object?> getSessionAttributes() {
    final config = _config.config;
    // Only the platform's part can fail, and only it is worth losing.
    var device = const <String, Object?>{};
    try {
      device = _deviceAttributes();
    } catch (error) {
      handleError(error);
    }
    return {
      // Device metadata first, so a provider can never shadow session identity.
      ...device,
      'cluster': config.cluster,
      'env': config.environment,
      'namespace': config.namespace,
      'releaseId': config.releaseId ?? '',
      'session_id': _session.getSessionId(),
      'session_start_time': _session.getSessionStartTime(),
      'user': config.user?.toJson() ?? const <String, Object?>{},
      'service.name': config.appId,
    };
  }
}
