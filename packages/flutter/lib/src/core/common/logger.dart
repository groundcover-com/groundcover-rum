/// Where SDK diagnostics go. `print`, never `debugPrint`: the SDK captures
/// debugPrint as log events, and its own diagnostics must not feed back into
/// what it reports. Replaceable for tests.
typedef DiagnosticSink = void Function(String line);

// ignore: avoid_print
void _defaultSink(String line) => print(line);

/// The SDK's debug log. Silent unless `debug` is on. One instance per isolate:
/// diagnostics have no owner to inject them through.
final class RumDiagnostics {
  RumDiagnostics._();

  static final RumDiagnostics instance = RumDiagnostics._();

  bool _debug = false;
  String _prefix = '';
  DiagnosticSink sink = _defaultSink;
  var _emitting = 0;

  /// Whether a diagnostic line is being written. An app zone that forwards
  /// print to the SDK's logger calls back in from here; that call is dropped
  /// (runtime.dart), or each line would write another, without end.
  bool get emitting => _emitting > 0;

  void configure({bool? debug, String? prefix}) {
    _debug = debug ?? _debug;
    _prefix = prefix ?? _prefix;
  }

  /// Logs [message] when debug is on. Never throws.
  void log(String message, [Object? detail]) {
    if (!_debug) return;
    try {
      final time = DateTime.now().toUtc().toIso8601String();
      final suffix = detail == null ? '' : ' $detail';
      _emit('[$time] $_prefix $message$suffix');
    } catch (_) {
      // A failing sink must never reach the host app.
    }
  }

  /// Logs [message] whatever the debug setting: for misconfiguration the
  /// developer has to see. Carries the `groundcoverIgnore` marker the log
  /// capture skips. Never throws.
  void warn(String message) {
    try {
      _emit('$message (groundcoverIgnore)');
    } catch (_) {
      // As above.
    }
  }

  /// Writes [line], unless one is being written: a line can only arrive
  /// from inside the sink through the app's own print handling.
  void _emit(String line) {
    if (_emitting > 0) return;
    _emitting++;
    try {
      sink(line);
    } finally {
      _emitting--;
    }
  }
}

/// Swallows [error] after logging it in debug. Every SDK boundary that must
/// not throw into the host ends here.
void handleError(Object? error, [StackTrace? stackTrace]) {
  RumDiagnostics.instance.log('[error-handler.handleError] called', error);
}

/// A warning the developer sees even with debug off.
void safeWarn(String message) => RumDiagnostics.instance.warn(message);
