import '../common/ids.dart';
import '../common/logger.dart';
import '../common/time.dart';
import '../config/constants.dart';
import '../events/event_time.dart';
import '../events/events_pool.dart';
import '../events/rum_event.dart';
import 'session_state.dart';

/// The session lifecycle policy: reconciliation (gap and cap expiry),
/// rotation, the ghost-session send gate, and the enqueue hook that drives
/// them from events. Presence signals belong to the platform and arrive
/// through [reconcile]; what they mean is decided here. Lazy by design: a
/// dormant app produces no signals, so nothing here runs.
final class SessionLifecycle {
  SessionLifecycle({
    required this._session,
    required this._pool,
    required IdGenerator idGenerator,
    required this._clock,
    required this._activityEventTypes,
    required this._ignoredEventTypes,
  }) : _ids = idGenerator;

  final SessionState _session;
  final EventsPool _pool;
  final IdGenerator _ids;
  final Clock _clock;

  /// Which event types prove a human is present.
  final Set<String> _activityEventTypes;

  /// Heartbeat-style types that never drive reconciliation.
  final Set<String> _ignoredEventTypes;

  bool _rotating = false;

  bool get isRotating => _rotating;

  /// Arms the enqueue hook and the send gate. Before any listener arms, so
  /// the gate is in place before the first event.
  void install() {
    _pool.setBeforeEnqueueHook(_reconcileOnEnqueue);
    _pool.setFlushGate(_session.hasUserActivity);
  }

  /// The hook clears first (a teardown enqueue must not rotate), then the
  /// host's teardown runs, and the gate clears last, so an unconfirmed
  /// session's final batch stays held.
  void uninstall([void Function()? hostTeardown]) {
    _pool.setBeforeEnqueueHook(null);
    try {
      hostTeardown?.call();
    } catch (error) {
      handleError(error);
    }
    _pool.setFlushGate(null);
  }

  /// The reconciliation core, shared by every presence source, in order:
  /// expiry checks (an inactivity gap only for presence, then the cap for any
  /// signal), then presence stamps the activity clock and confirms the
  /// session, after the checks so it can't erase a gap it just found.
  ///
  /// [triggeringEvent] is the event that drove this, when there is one; a
  /// rotation starts the new session from it rather than from a second clock
  /// read.
  void reconcile(int nowMs, bool userPresent, [RumEvent? triggeringEvent]) {
    if (_rotating) return;
    if (userPresent && _session.isSessionInactive(nowMs)) {
      rotate('inactivity gap', triggeringEvent);
    }
    // After a gap rotation the start is fresh, so this can't rotate twice.
    final elapsedMs = _session.getSessionElapsedMs(nowMs);
    final maxMs = _session.getSessionMaxDuration().inMilliseconds;
    RumDiagnostics.instance.log('[session-lifecycle] session reconcile', {
      'userPresent': userPresent,
      'elapsedMs': elapsedMs,
      'maxDurationMs': maxMs,
    });
    if (elapsedMs >= maxMs) rotate('max session duration', triggeringEvent);
    if (userPresent) _session.setLastActivityMs(nowMs);
  }

  void _reconcileOnEnqueue(RumEvent event) {
    if (_rotating || _ignoredEventTypes.contains(event.type)) return;
    reconcile(_clock(), _activityEventTypes.contains(event.type), event);
  }

  /// Rotates only when the session is stale, before an operation that must
  /// run under a current one.
  void rotateIfStale(int nowMs, String reason) {
    if (_session.isSessionInactive(nowMs) || _session.isSessionExpired(nowMs)) {
      rotate(reason);
    }
  }

  /// The single rotation primitive. A confirmed session flushes its
  /// stragglers under the old id; an unconfirmed (ghost) session's buffer is
  /// discarded, so it can't leak into the new id. Each step is isolated, so
  /// one failure doesn't abort the rest.
  void rotate(String reason, [RumEvent? triggeringEvent]) {
    if (_rotating) return;
    _rotating = true;
    void step(String label, void Function() run) {
      try {
        run();
      } catch (error) {
        handleError(error);
        RumDiagnostics.instance.log(
          '[session-lifecycle] failed to $label during rotation:',
          error,
        );
      }
    }

    try {
      final previousId = _session.getSessionId();
      // Before the id flip, which resets it.
      final wasConfirmed = _session.hasUserActivity();
      RumDiagnostics.instance.log(
        '[session-lifecycle] session rotation start',
        {
          'reason': reason,
          'previousId': previousId,
          'wasConfirmed': wasConfirmed,
        },
      );
      step(
        wasConfirmed ? 'flush events' : 'discard unconfirmed events',
        wasConfirmed ? _pool.flush : _pool.discardBuffer,
      );
      step('rotate session ids', () {
        final newId = _ids.generateId();
        // Resolved before either write, so a failure can't pair the new id
        // with the old start.
        final startNs = _resolveNewSessionStartTime(triggeringEvent);
        _session.setSessionId(newId);
        _session.setSessionStartTime(startNs);
        _session.clearSamplingDecision();
        RumDiagnostics.instance.log('[session-lifecycle] session id rotated', {
          'from': previousId,
          'to': newId,
        });
      });
    } finally {
      _rotating = false;
    }
  }

  // A session must never start after an event that belongs to it:
  // consumers derive session duration from (last event - session_start_time).
  // So the start is the earliest trusted time among the clock, the triggering
  // event (not in the pool yet), and whatever the drain left in the pool.
  // Candidates are trusted only within the tighter of the cap and the idle
  // window, so a bogus-old time can't open a session that is born already
  // stale.
  int _resolveNewSessionStartTime(RumEvent? triggeringEvent) {
    final nowNs = msToNs(_clock());
    var earliest = nowNs;
    try {
      final maxAgeMs =
          _session.getSessionMaxDuration() < sessionInactivityTimeout
          ? _session.getSessionMaxDuration().inMilliseconds
          : sessionInactivityTimeout.inMilliseconds;
      final maxAgeNs = msToNs(maxAgeMs);
      for (final candidate in [
        earliestTrustedEventTime([triggeringEvent], nowNs, maxAgeNs),
        _pool.getEarliestEventTimestamp(nowNs, maxAgeNs),
      ]) {
        if (isTrustedEventTime(candidate, nowNs, maxAgeNs) &&
            candidate! < earliest) {
          earliest = candidate;
        }
      }
    } catch (error) {
      handleError(error);
    }
    return earliest;
  }
}
