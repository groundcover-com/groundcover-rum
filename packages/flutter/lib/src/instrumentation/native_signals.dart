// The engine's signals as captures.
//
// A signal that breaks the contract is DROPPED rather than repaired. The app
// and the engine can't drift apart here as RN's bundle and binary can, but a
// payload that lost a field is still no measurement: a zero-filled one would
// assert something that never happened.
import '../core/common/json.dart';
import '../core/events/native/stack_frames.dart';
import '../core/pipeline/rum_pipeline.dart';
import '../platform/rum_api.g.dart';
import 'app_start.dart';

/// The capture [signal] carries, or null for one that carries none (`ping`
/// marks the stream live; `app_start` goes to the app-start tracker, see
/// [appStartOfSignal]) or one that breaks the contract.
Capture? captureOfSignal(NativeSignal signal) {
  final payload = decodeJsonObject(signal.payloadJson);
  if (payload == null) return null;
  switch (signal.kind) {
    case 'hang':
      final startedAtMs = finiteNum(payload['startedAtMs']);
      final durationMs = finiteNum(payload['durationMs']);
      if (startedAtMs == null || durationMs == null) return null;
      return HangCapture(
        kind: payload['kind'] == 'anr' ? HangKind.anr : HangKind.appHang,
        startedAtMs: startedAtMs,
        durationMs: durationMs,
        frames: stackFramesOf(payload['mainThreadStack']),
      );
    default:
      return null;
  }
}

/// The launch [signal] reports, when it is a valid `app_start`.
AppStartSignal? appStartOfSignal(NativeSignal signal) {
  if (signal.kind != 'app_start') return null;
  final payload = decodeJsonObject(signal.payloadJson);
  if (payload == null) return null;
  final type = payload['type'];
  final startMs = finiteNum(payload['startMs']);
  final firstFrameMs = finiteNum(payload['firstFrameMs']);
  if (type is! String || startMs == null || firstFrameMs == null) return null;
  return (type: type, startMs: startMs, firstFrameMs: firstFrameMs);
}
