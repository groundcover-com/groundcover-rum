// Flutter's frames are counted in Dart, the way the engine's Android
// aggregator counts them, because native frame hooks don't see Flutter's
// surface.
//
// The Kotlin aggregator, not the Swift one, because the inputs match: Android
// feeds it FrameMetrics' TOTAL_DURATION, a drawn frame's work time, and
// Flutter's FrameTiming.totalSpan is the same quantity for a frame Flutter
// produced. Neither has an idle-frame stream to misclassify, so neither needs
// iOS's cadence estimation. The thresholds are the native engine's, shared by
// iOS and Android, so a frame is judged identically everywhere.

/// Why a segment ended. On the wire, so a consumer can sum consecutive
/// [safety] segments up to a [navigation] or [background] one and recover a
/// whole screen's total.
enum SegmentReason {
  /// The screen changed.
  navigation,

  /// The app left the foreground.
  background,

  /// The segment ran past its cap: a screen has no upper bound on how long a
  /// user stays, and unflushed counters are data nobody can see.
  safety,
}

/// One closed segment: everything drawn on one screen between two
/// boundaries.
final class FrameSegment {
  const FrameSegment({
    required this.startMs,
    required this.endMs,
    required this.total,
    required this.slow,
    required this.frozen,
    required this.refreshRate,
    required this.delayMs,
    required this.budgetMs,
    required this.reason,
  });

  final int startMs;
  final int endMs;
  final int total;
  final int slow;
  final int frozen;
  final double refreshRate;

  /// Milliseconds lost across every slow frame, each one's duration beyond
  /// the frame budget, summed: the frames delay. Absolute on purpose: a rate
  /// needs a frame count, and platforms don't count the same frames.
  final double delayMs;

  /// The budget [slow] and [delayMs] were judged against.
  final double budgetMs;
  final SegmentReason reason;
}

/// Past this the user perceives a freeze, not a stutter.
const frozenThresholdMs = 700.0;

/// One frame's worth of time: the budget a frame is late relative to.
double expectedFrameMs(double refreshRateHz) =>
    refreshRateHz > 0 ? 1000 / refreshRateHz : 1000 / 60;

/// How late a frame must be to count as slow: one frame interval plus a
/// vsync's tolerance, `1000 / (rate - 1)`, so a frame landing a hair after
/// its deadline isn't called slow. Relative to the display, since a fixed
/// 16.7 ms bar would call a stuttering 120 Hz app healthy.
double slowThresholdMs(double refreshRateHz) =>
    refreshRateHz > 1 ? 1000 / (refreshRateHz - 1) : 1000 / refreshRateHz;

/// Accumulates frame durations into ONE open segment and hands it back when
/// something closes it. Per screen, not per interval. Pure, so it is tested
/// without a device.
final class FrameAggregator {
  FrameAggregator({required this.maxSegmentMs, this.refreshRateHz = 60});

  final int maxSegmentMs;

  /// The display's rate, which judges each frame as it is recorded.
  double refreshRateHz;

  // Nullable rather than a 0 sentinel: 0 is a valid timestamp.
  int? _startMs;
  int _total = 0;
  int _slow = 0;
  int _frozen = 0;
  double _delayMs = 0;

  /// Whether the open segment has any frames.
  bool get isEmpty => _total == 0;

  /// When the open segment started: its first frame, or the last reset.
  int? get startMs => _startMs;

  /// Adds a frame that took [frameDurationMs], at [nowMs]. Returns the
  /// segment it closed when it pushed the segment past [maxSegmentMs];
  /// otherwise null.
  FrameSegment? record(double frameDurationMs, int nowMs) {
    final startMs = _startMs ??= nowMs;
    _total++;
    if (frameDurationMs > slowThresholdMs(refreshRateHz)) {
      _slow++;
      // Past the BUDGET, not the slow bar: the bar carries a vsync's
      // tolerance, but the time the user lost is everything past the budget.
      _delayMs += frameDurationMs - expectedFrameMs(refreshRateHz);
    }
    if (frameDurationMs > frozenThresholdMs) _frozen++;
    // After counting, so the frame that closes a segment belongs to it.
    if (nowMs - startMs < maxSegmentMs) return null;
    return _close(nowMs, SegmentReason.safety);
  }

  /// Closes the open segment. Null when no frames were recorded: an empty
  /// segment isn't news, and "0 frames" would read as "0 slow".
  FrameSegment? flush(int endMs, SegmentReason reason) {
    if (_total <= 0) return null;
    return _close(endMs, reason);
  }

  /// Drops the in-flight segment without reporting it, and re-anchors at
  /// [nowMs]: returning from the background, the gap is no frame time, and
  /// must not count toward the cap either.
  void reset(int nowMs) {
    _startMs = nowMs;
    _total = 0;
    _slow = 0;
    _frozen = 0;
    _delayMs = 0;
  }

  // Reopens at the same instant, so coverage is contiguous.
  FrameSegment _close(int endMs, SegmentReason reason) {
    final segment = FrameSegment(
      startMs: _startMs ?? endMs,
      endMs: endMs,
      total: _total,
      slow: _slow,
      frozen: _frozen,
      refreshRate: refreshRateHz,
      delayMs: _delayMs,
      budgetMs: expectedFrameMs(refreshRateHz),
      reason: reason,
    );
    reset(endMs);
    return segment;
  }
}
