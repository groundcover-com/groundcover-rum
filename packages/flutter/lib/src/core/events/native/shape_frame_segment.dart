// One closed segment as one `frames_delay_total` metric.
import '../../common/time.dart';
import '../captures.dart';
import '../event_enricher.dart';

double _round2(double value) => (value * 100).round() / 100;

/// The `performance` event for [segment], with a fresh metric id.
EnrichInput shapeFrameSegmentEvent(
  FrameSegmentCapture segment, {
  required String metricId,
}) {
  final budget = segment.budgetMs;
  return EnrichInput(
    type: 'performance',
    // The segment's END, not now: it describes a past interval, and stamping
    // it at emit time would place a screen's jank after the navigation that
    // ended it.
    timestamp: msToNs(segment.endMs),
    attributes: {
      'performance_metric_name': 'frames_delay_total',
      // Two decimals: whole milliseconds would round one marginally slow
      // frame's delay (0.28 ms at 60 Hz) down to a smooth screen's zero.
      'performance_metric_value': _round2(segment.delayMs),
      'performance_metric_id': metricId,
      // Launch context means nothing for a steady-state metric; the screen
      // stamp is what attributes it.
      'performance_metric_navigation_type': '',
      'performance_refresh_rate_hz': segment.refreshRate,
      if (budget.isFinite && budget > 0)
        'performance_frame_budget_ms': _round2(budget),
      'performance_segment_reason': segment.reason.wireName,
      // Nanoseconds, as navigation events ship under these names, so a
      // segment intersects the navigations around it with no conversion.
      'start_timestamp': msToNs(segment.startMs),
      'end_timestamp': msToNs(segment.endMs),
      // Absolute counts a consumer sums across segments. No total and no
      // rate: a frame count is not the same quantity on every platform.
      'performance_frames_slow': segment.slow,
      'performance_frames_frozen': segment.frozen,
    },
  );
}
