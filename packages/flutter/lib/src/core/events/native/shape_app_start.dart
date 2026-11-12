// A launch metric as a `performance` event, the shape the browser SDK uses
// for web vitals.
import '../captures.dart';
import '../event_enricher.dart';

/// The `performance` event for [start], with a fresh metric id. Stamped
/// when it is sent, as RN's: it describes the launch, which has no single
/// moment of its own.
EnrichInput shapeAppStartEvent(
  AppStartCapture start, {
  required String metricId,
}) => EnrichInput(
  type: 'performance',
  attributes: {
    'performance_metric_name': start.metric.wireName,
    'performance_metric_value': start.valueMs,
    'performance_metric_id': metricId,
    'performance_metric_navigation_type': start.navigationType,
  },
);
