// A frozen app is an error the user experienced, so a hang is an
// `exception` event rather than a type of its own: it lands in the same view,
// under the same fingerprint rules.
import 'dart:math';

import '../captures.dart';
import '../event_enricher.dart';

/// Groups by duration BUCKET, not exact milliseconds; otherwise every hang is
/// its own issue and the pattern (this screen freezes for about 5 s) never
/// surfaces.
String _bucket(int durationMs) {
  if (durationMs < 1000) return '<1s';
  if (durationMs >= 30000) return '30s+';
  return '${durationMs ~/ 1000}s';
}

/// The `exception` event for [hang].
EnrichInput shapeHangEvent(HangCapture hang) {
  final durationMs = max(0, hang.durationMs.round());
  final type = hang.kind.wireName;
  return EnrichInput(
    type: 'exception',
    // When the stall began, not now: it is reported only on recovery, after
    // the taps and navigations it blocked.
    timestamp: hang.timestampNs,
    attributes: {
      'error_type': type,
      'error_message': 'Main thread blocked for ${durationMs}ms',
      'error_stacktrace': [for (final frame in hang.frames) frame.toJson()],
      'error_fingerprint': '$type:${_bucket(durationMs)}',
      // The user couldn't use the app: nobody handled it.
      'error_handled': false,
      'error_metadata': {
        'native': true,
        'hang_duration_ms': durationMs,
        'hang_started_at': hang.startedAtMs,
        // Tells it apart from the post-mortem ANR record, a stall the
        // process never came back from.
        'recovered': true,
      },
    },
  );
}
