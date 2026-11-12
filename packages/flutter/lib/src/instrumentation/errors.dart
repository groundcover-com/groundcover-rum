// Uncaught errors, from Flutter's two global hooks, and the shaping every
// error source shares: the counterpart of the RN SDK's ErrorUtils handler and
// its stack parser. No zones: PlatformDispatcher.onError covers async errors,
// and zones cause "Zone mismatch" since Flutter 3.10.
import 'dart:ui';

import 'package:flutter/foundation.dart';

import '../core/common/hooks.dart';
import '../core/common/logger.dart';
import '../core/common/patch.dart';
import '../core/pipeline/rum_pipeline.dart';

/// The error's message as its own field reads it, without the `Type: `
/// prefix `toString` adds, so it groups like the RN SDK's `error.message`.
String errorMessage(Object error) {
  final message = switch (error) {
    StateError(:final message) => message,
    FormatException(:final message) => message,
    UnsupportedError(:final message) => message,
    ArgumentError(:final message) when message != null => '$message',
    FlutterError(:final message) => message,
    String() => error,
    _ => null,
  };
  if (message != null) return message;
  final text = '$error';
  return text.startsWith('Exception: ') ? text.substring(11) : text;
}

/// [error] as an [ErrorCapture], its frames parsed from [stackTrace].
ErrorCapture errorCapture(
  Object error,
  StackTrace? stackTrace, {
  required bool handled,
  Map<String, Object?>? metadata,
}) => ErrorCapture(
  type: error.runtimeType.toString(),
  message: errorMessage(error),
  frames: parseStackTrace(
    stackTrace ?? (error is Error ? error.stackTrace : null),
  ),
  handled: handled,
  metadata: metadata,
);

// `#3      HomeScreen.build.<anonymous closure> (package:app/home.dart:52:34)`
final _frame = RegExp(r'^#\d+\s+(.+?) \((.+?)(?::(\d+))?(?::(\d+))?\)$');

const _sdkPackage = 'package:groundcover_rum/';

// An obfuscated release build prints raw addresses under a header:
//   build_id: '61f1b8...'
//   #00 abs 000000706e44fc27 virt 00000000001efc27 _kDartIsolateSnapshotInstructions+0x1e9e07
final _buildId = RegExp(r"build_id: '([0-9a-f]+)'");
final _absFrame = RegExp(
  r'^#\d+\s+abs\s+([0-9a-f]+)(?:\s+virt\s+([0-9a-f]+))?\s*(.*)$',
);

/// Frames, innermost first. A readable trace gives function, file, line and
/// column. An obfuscated one keeps each frame's raw addresses as its
/// function, under the build id as its file, so it can be symbolicated with
/// that build's symbols; the SDK doesn't symbolicate. Anything unparseable
/// is skipped, and so are the SDK's own frames on top of a trace it took
/// itself: the first frame is the app's.
List<ErrorFrame> parseStackTrace(StackTrace? stackTrace) {
  if (stackTrace == null) return const [];
  try {
    final text = '$stackTrace';
    final buildId = _buildId.firstMatch(text)?.group(1);
    final frames = <ErrorFrame>[];
    for (final line in text.split('\n')) {
      final trimmed = line.trim();
      final abs = _absFrame.firstMatch(trimmed);
      if (abs != null) {
        frames.add(
          ErrorFrame(
            filename: buildId == null ? 'unknown' : 'build_id:$buildId',
            function: [
              'abs ${abs[1]}',
              if (abs[2] != null) 'virt ${abs[2]}',
              if ((abs[3] ?? '').isNotEmpty) abs[3]!,
            ].join(' '),
            lineno: 0,
            colno: 0,
          ),
        );
        continue;
      }
      final m = _frame.firstMatch(trimmed);
      if (m == null) continue;
      if (frames.isEmpty && m[2]!.startsWith(_sdkPackage)) continue;
      frames.add(
        ErrorFrame(
          filename: m[2]!,
          function: m[1]!,
          lineno: int.tryParse(m[3] ?? '') ?? 0,
          colno: int.tryParse(m[4] ?? '') ?? 0,
        ),
      );
    }
    return frames;
  } catch (error) {
    handleError(error);
    return const [];
  }
}

/// Reports uncaught errors and passes each on to the handler that was there
/// before, whose result it returns: the app's own crash handling is
/// untouched. The previous handler runs as one of the app's hooks, so what it
/// prints (the default presenter dumps the error through debugPrint) isn't
/// sent again as a log. A null one is how an app silences framework errors,
/// so it stays null.
void installErrorHooks(
  PatchSet patches,
  void Function(ErrorCapture capture) submit,
) {
  void report(Object error, StackTrace? stack) {
    try {
      submit(errorCapture(error, stack, handled: false));
    } catch (e) {
      handleError(e);
    }
  }

  patches
    ..install(
      PatchSpec<FlutterExceptionHandler?>(
        get: () => FlutterError.onError,
        set: (handler) => FlutterError.onError = handler,
        wrap: (previous) => (details) {
          // A silent error is one the framework itself treats as noise.
          if (!details.silent) report(details.exception, details.stack);
          if (previous != null) runUserHook(() => previous(details));
        },
      ),
    )
    ..install(
      PatchSpec<ErrorCallback?>(
        get: () => PlatformDispatcher.instance.onError,
        set: (handler) => PlatformDispatcher.instance.onError = handler,
        wrap: (previous) => (error, stack) {
          report(error, stack);
          if (previous == null) return false;
          return runUserHook(() => previous(error, stack));
        },
      ),
    );
}
