// Native stack frames, as the engine reports them in a hang or a crash record.
import '../../common/json.dart';
import '../captures.dart';

/// RN's normalizeStackFrames: a frame without a filename symbolicates to
/// nothing and is dropped; the other fields fall back to their documented
/// values (no symbol is `''`; a native frame carries no line, so it is 0).
List<ErrorFrame> stackFramesOf(Object? frames) {
  if (frames is! List) return const [];
  return [
    for (final frame in frames)
      if (frame is Map && frame['filename'] is String)
        ErrorFrame(
          filename: frame['filename'] as String,
          function: frame['function'] is String
              ? frame['function'] as String
              : '',
          lineno: finiteNum(frame['lineno'])?.toInt() ?? 0,
          colno: finiteNum(frame['colno'])?.toInt() ?? 0,
        ),
  ];
}
