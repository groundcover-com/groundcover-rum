// The events the app sends itself: custom events and logs.
import '../common/text.dart';
import '../privacy/privacy_config.dart';
import '../privacy/redaction.dart';
import 'captures.dart';
import 'event_enricher.dart';

/// `GroundcoverRum.sendCustomEvent`, sent as given: custom events are not
/// auto-redacted.
EnrichInput shapeCustomEvent(CustomEventCapture capture) => EnrichInput(
  type: 'custom',
  timestamp: capture.timestampNs,
  attributes: {
    'custom_event_name': capture.name,
    'custom_event_attributes': capture.attributes,
  },
);

/// A log line. The keys the event stamps itself (`message`, `level`, and the
/// enricher's [reservedKeys]) are stripped from the user's attributes, so they
/// can't be shadowed; then the log privacy rules apply to the message and the
/// attributes alike.
EnrichInput shapeLogEvent(
  LogCapture capture,
  EffectivePrivacy privacy, {
  List<String> reservedKeys = const [],
}) {
  final userAttributes = {...?capture.attributes}
    ..remove('message')
    ..remove('level');
  for (final key in reservedKeys) {
    userAttributes.remove(key);
  }
  final safe = redactLogFields(privacy, capture.message, userAttributes);
  return EnrichInput(
    type: 'log',
    timestamp: capture.timestampNs,
    attributes: {
      ...?safe.attributes,
      'message': truncate(safe.message),
      'level': capture.level.name,
    },
  );
}
