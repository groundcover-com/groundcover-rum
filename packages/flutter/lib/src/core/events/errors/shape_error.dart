// Capture and stack parsing are the platform's; every source hands its
// error here, so web and mobile exceptions group identically.
import '../../common/text.dart';
import '../../config/types.dart';
import '../../privacy/privacy_config.dart';
import '../../privacy/redaction.dart';
import '../captures.dart';
import '../event_enricher.dart';

/// The `exception` event for [error].
EnrichInput shapeErrorEvent(ErrorCapture error, EffectivePrivacy privacy) {
  final opts = privacy.redactOptions(RedactKind.error);
  final shouldMask = privacy.shouldMaskErrors;
  final message = error.message.isEmpty ? 'Unknown error' : error.message;
  final safeMessage = shouldMask ? redactText(message, opts) : message;
  final metadata = error.metadata;
  final safeMetadata = shouldMask && metadata != null
      ? redactObject(metadata, opts)
      : metadata;
  final type = error.type.isEmpty ? 'Error' : error.type;

  return EnrichInput(
    type: 'exception',
    timestamp: error.timestampNs,
    attributes: {
      'error_type': type,
      'error_message': safeMessage,
      'error_stacktrace': [for (final frame in error.frames) frame.toJson()],
      'error_fingerprint': '$type:${truncate(safeMessage, maxLength: 400)}',
      'error_handled': error.handled,
      // Omitted rather than null when there is none, as JSON.stringify drops
      // an undefined field.
      'error_metadata': ?safeMetadata,
    },
  );
}
