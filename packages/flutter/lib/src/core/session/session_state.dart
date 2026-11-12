import '../common/storage.dart';
import '../common/time.dart';
import '../config/constants.dart';

/// The persisted keys. Shared with the RN and browser SDKs' storage, so a
/// device migrating between them reads one vocabulary.
abstract final class SessionKeys {
  static const id = 'gcId';

  /// Nanoseconds since the epoch.
  static const startTime = 'gcStartTime';

  /// Milliseconds since the epoch.
  static const lastActivity = 'gcLastActivity';

  static const sampling = samplingStorageKey;
}

/// Per-session identity and activity: the id, its start time, the activity
/// clock, their persistence, and the gap and cap rules over them.
final class SessionState {
  SessionState({required this._storage, this._maxDuration});

  final SafeStorage _storage;
  final Duration? Function()? _maxDuration;
  String? _sessionId;
  int? _startTimeNs;
  int? _lastActivityMs;
  int _lastPersistedActivityMs = 0;

  String getSessionId() => _sessionId ?? _storage.getItem(SessionKeys.id) ?? '';

  void setSessionId(String id) {
    _sessionId = id;
    _storage.setItem(SessionKeys.id, id);
  }

  /// Nanoseconds, or 0 when none is recorded.
  int getSessionStartTime() {
    final cached = _startTimeNs;
    if (cached != null && cached != 0) return cached;
    return _storage.getNumericItem(SessionKeys.startTime).toInt();
  }

  /// Starts the session at [startTimeNs]. A session is born unconfirmed: the
  /// activity clock is cleared, in memory and in storage, so a restart cannot
  /// read a stale value and confirm it falsely.
  void setSessionStartTime(int startTimeNs) {
    _startTimeNs = startTimeNs;
    _storage.setItem(SessionKeys.startTime, '$startTimeNs');
    _lastActivityMs = null;
    _lastPersistedActivityMs = 0;
    _storage.removeItem(SessionKeys.lastActivity);
  }

  /// The last genuine activity, epoch milliseconds; 0 when none this session.
  int getLastActivityMs() =>
      _lastActivityMs ??
      _storage.getNumericItem(SessionKeys.lastActivity).toInt();

  /// On every user interaction: exact in memory, throttled to storage.
  void setLastActivityMs(int nowMs) {
    _lastActivityMs = nowMs;
    if (nowMs - _lastPersistedActivityMs >=
        activityPersistThrottle.inMilliseconds) {
      persistLastActivity();
    }
  }

  /// Writes the exact activity clock, for the host's suspend path, so a
  /// restart does not read a value a throttle window stale.
  void persistLastActivity() {
    final last = _lastActivityMs;
    if (last == null) return;
    _lastPersistedActivityMs = last;
    _storage.setItem(SessionKeys.lastActivity, '$last');
  }

  /// The inactivity rule. Before any activity the gap is measured from birth.
  bool isSessionInactive(int nowMs) {
    final last = getLastActivityMs();
    final baseline = last > 0 ? last : nsToMs(getSessionStartTime());
    return baseline > 0 &&
        nowMs - baseline >= sessionInactivityTimeout.inMilliseconds;
  }

  /// Whether the session has seen genuine interaction: the ghost-session send
  /// gate. A stamped activity clock is the confirmation.
  bool hasUserActivity() => getLastActivityMs() > 0;

  /// Drops the persisted sampling verdict, so the next session re-rolls it.
  void clearSamplingDecision() => _storage.removeItem(SessionKeys.sampling);

  /// Clears every session key and its in-memory mirror.
  void clearSessionState() {
    _sessionId = null;
    _startTimeNs = null;
    _lastActivityMs = null;
    _lastPersistedActivityMs = 0;
    _storage.removeItem(SessionKeys.id);
    _storage.removeItem(SessionKeys.startTime);
    _storage.removeItem(SessionKeys.lastActivity);
    clearSamplingDecision();
  }

  Duration getSessionMaxDuration() =>
      _maxDuration?.call() ?? defaultSessionMaxDuration;

  /// Milliseconds since the session started; 0 without a recorded start.
  int getSessionElapsedMs(int nowMs) {
    final startNs = getSessionStartTime();
    return startNs != 0 ? nowMs - nsToMs(startNs) : 0;
  }

  /// The cap rule. False without a recorded start.
  bool isSessionExpired(int nowMs) =>
      getSessionElapsedMs(nowMs) >= getSessionMaxDuration().inMilliseconds;
}
