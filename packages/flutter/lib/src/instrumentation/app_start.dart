// App start and time to interactive. The native engine measures how long the
// launch took to its first frame; the app adds the interactive mark, because
// only it knows when a screen is usable.
import 'dart:async';

import '../core/common/logger.dart';
import '../core/pipeline/rum_pipeline.dart';
import 'interactive_mark.dart';

/// How long a launch metric waits for the screen it landed on: far more
/// useful attributed to it, but a screenless app must not lose the metric.
const screenWait = Duration(seconds: 5);

/// Which metric each engine start type ships under, and whether it anchors
/// TTI. Cold starts only: TTI is measured from the cold start's origin, and a
/// foreground return hours into the process is no such origin. An unknown
/// type is rejected rather than guessed: the type chooses the series.
const _types = {
  'cold': (metric: AppStartMetric.cold, anchorsTti: true),
  'cold_prewarmed': (metric: AppStartMetric.cold, anchorsTti: true),
  'warm': (metric: AppStartMetric.warm, anchorsTti: false),
  'hot': (metric: AppStartMetric.hot, anchorsTti: false),
};

/// One `app_start` signal from the engine, in epoch milliseconds.
typedef AppStartSignal = ({String type, num startMs, num firstFrameMs});

final class AppStartTracker {
  AppStartTracker({required this._submit, required this._manualTti}) {
    _unsubscribe = onInteractiveMark(_maybeReportTti);
  }

  final void Function(Capture capture) _submit;

  /// Whether TTI waits for `markAppInteractive` rather than the first screen.
  final bool _manualTti;
  late final void Function() _unsubscribe;

  bool _screenKnown = false;
  final _waiting = <void Function()>[];
  Timer? _screenTimer;
  bool _disposed = false;

  /// The cold start's origin and value, which TTI is measured from and
  /// clamped to.
  num? _coldStartMs;
  int? _coldDurationMs;

  /// Whether the cold start went out: TTI follows it, never precedes it,
  /// even when the mark lands while the cold start waits for its screen.
  bool _coldSent = false;
  bool _reportedTti = false;

  void onAppStart(AppStartSignal start) {
    if (_disposed) return;
    try {
      final duration = (start.firstFrameMs - start.startMs).round();
      if (duration < 0) return;
      final known = _types[start.type];
      if (known == null) {
        RumDiagnostics.instance.log(
          '[app-start] dropped an app start of unknown type ${start.type}',
        );
        return;
      }
      if (known.anchorsTti) {
        _coldStartMs = start.startMs;
        _coldDurationMs = duration;
      }
      _whenScreenKnown(() {
        try {
          _submit(
            AppStartCapture(
              metric: known.metric,
              valueMs: duration,
              navigationType: start.type,
            ),
          );
        } finally {
          // The mark may have landed while this waited for the screen. In a
          // finally, so a start metric that failed doesn't take TTI with it.
          if (known.anchorsTti) _coldSent = true;
          _maybeReportTti();
        }
      });
    } catch (error) {
      handleError(error);
    }
  }

  /// A screen landed: launch metrics held for one go out under it.
  void screenKnown() {
    if (_screenKnown) return;
    _screenKnown = true;
    _screenTimer?.cancel();
    _screenTimer = null;
    _release();
  }

  void dispose() {
    _disposed = true;
    _unsubscribe();
    _screenTimer?.cancel();
    _screenTimer = null;
    _waiting.clear();
  }

  /// TTI: the interactive mark, measured from the cold start's origin.
  void _maybeReportTti() {
    if (_disposed || _reportedTti || !_coldSent) return;
    final startMs = _coldStartMs;
    final coldMs = _coldDurationMs;
    if (startMs == null || coldMs == null) return;
    final markMs = interactiveMark(manual: _manualTti);
    if (markMs == null) return;
    _reportedTti = true;
    // Clamped to the first frame: an app holding a splash screen can mark
    // itself interactive before anything was visible.
    final ttiMs = (markMs - startMs).round();
    try {
      _submit(
        AppStartCapture(
          metric: AppStartMetric.tti,
          valueMs: ttiMs > coldMs ? ttiMs : coldMs,
          navigationType: 'cold',
        ),
      );
    } catch (error) {
      handleError(error);
    }
  }

  void _whenScreenKnown(void Function() emit) {
    if (_screenKnown) {
      emit();
      return;
    }
    _waiting.add(emit);
    _screenTimer ??= Timer(screenWait, () {
      _screenTimer = null;
      _release();
    });
  }

  // Each on its own: one launch metric failing must not drop the others.
  void _release() {
    final waiting = List.of(_waiting);
    _waiting.clear();
    for (final emit in waiting) {
      try {
        emit();
      } catch (error) {
        handleError(error);
      }
    }
  }
}
