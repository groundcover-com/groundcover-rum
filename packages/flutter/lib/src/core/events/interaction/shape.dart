// Interaction shaping, as the React Native SDK does it: the label, hint and
// value text are masked under mask-all / maskInteractionLabels or inside
// GroundcoverPrivate; the role, state flags and component path are
// structural, and always kept.
import '../../privacy/privacy_config.dart';
import '../captures.dart';
import '../event_enricher.dart';

const _masked = '***';

/// A tap, a gesture or a finished edit, as an `interaction` event.
EnrichInput shapeInteractionEvent(
  InteractionCapture capture,
  EffectivePrivacy privacy,
) {
  final t = capture.target;
  final mask = privacy.maskInteractionLabels || t.masked;
  final valueText = t.valueText;
  final gesture = capture.gesture;
  return EnrichInput(
    type: 'interaction',
    timestamp: capture.timestampNs,
    attributes: {
      'interaction_type': capture.kind.wireName,
      if (capture.x != null && capture.y != null)
        'interaction_coordinates': {'x': capture.x, 'y': capture.y},
      'interaction_target': {
        'component': t.component,
        'label': mask ? _masked : t.label,
        'role': t.role,
        'hint': mask && t.hint.isNotEmpty ? _masked : t.hint,
        'state': ?t.state,
        'value': ?(valueText == null
            ? null
            : {'text': mask ? _masked : valueText}),
      },
      'interaction_component_path': t.componentPath,
      if (gesture != null)
        'interaction_gesture': {
          'direction': ?gesture.direction?.name,
          'distance_dp': gesture.distanceDp,
          'velocity_dp_s': gesture.velocityDpS,
          'duration_ms': gesture.durationMs,
          'pointer_count': gesture.pointerCount,
          if (gesture.partial) 'partial': true,
          // Native trackers don't see Flutter's surface.
          'capture_source': 'dart',
        },
    },
  );
}
