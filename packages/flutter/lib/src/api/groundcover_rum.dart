import '../core/config/types.dart';
import '../core/pipeline/rum_pipeline.dart';
import '../core/common/logger.dart';
import '../instrumentation/errors.dart';
import '../instrumentation/interactive_mark.dart';
import 'init_exception.dart';
import 'runtime.dart';

/// The SDK's entry point. Await [init] before using it: calls made before
/// init has completed are dropped with a warning. None of its calls throws
/// into the app, except [init] when the SDK can't start.
abstract final class GroundcoverRum {
  /// Starts the SDK, and completes once it runs (a session not sampled
  /// included). Throws [GroundcoverInitException] if it can't start: a blank
  /// [GroundcoverConfig.appId], a call off the root isolate, or a start that
  /// failed. A call while one is starting, or after one started, gets that
  /// one's result; after a failure, a new call starts again.
  static Future<void> init(GroundcoverConfig config) =>
      RumRuntime.instance.init(config);

  /// Stamps [user] on every batch from now on, merged into any identity set
  /// before.
  static void identifyUser(RumUser user) =>
      RumRuntime.instance.dispatch('identifyUser', (p) => p.identifyUser(user));

  /// Changes the configuration after [init]. What is fixed at init isn't
  /// part of [GroundcoverConfigUpdate].
  static void updateConfig(GroundcoverConfigUpdate update) => RumRuntime
      .instance
      .dispatch('updateConfig', (p) => p.updateConfig(update));

  /// Sends a custom event named [name]. Its [attributes] are sent as given:
  /// custom events are not auto-redacted, so scrub them in `enrichEvent` if
  /// they can carry personal data.
  static void sendCustomEvent(
    String name, [
    Map<String, Object?> attributes = const {},
  ]) => RumRuntime.instance.dispatch(
    'sendCustomEvent',
    (p) => p.submit(CustomEventCapture(name, attributes)),
  );

  /// Reports a handled [error], with the [stackTrace] it was caught with
  /// (or, without one, the error's own or the call's) and optional
  /// [metadata].
  static void captureException(
    Object error, {
    StackTrace? stackTrace,
    Map<String, Object?>? metadata,
  }) {
    // Without one of its own, the error is placed by this call's trace.
    final trace =
        stackTrace ??
        (error is Error ? error.stackTrace : null) ??
        StackTrace.current;
    RumRuntime.instance.dispatch(
      'captureException',
      (p) => p.submit(
        errorCapture(error, trace, handled: true, metadata: metadata),
      ),
    );
  }

  /// Sends log events.
  static const RumLogger logger = RumLogger._();

  /// The current session id, or `''` before the SDK has started or when this
  /// session isn't sampled.
  static String getSessionId() {
    final runtime = RumRuntime.instance;
    final pipeline = runtime.pipeline;
    if (pipeline == null) {
      runtime.warnNotReady('getSessionId');
      return '';
    }
    return pipeline.sessionId;
  }

  /// Starts a new session, with [id] or a generated one. Whatever the old
  /// session buffered is sent under it first.
  static Future<void> setSessionId([String? id]) => RumRuntime.instance
      .dispatchAsync('setSessionId', (p) => p.setSessionId(id));

  /// Starts a manual navigation to [screen], with an optional [key] telling
  /// two visits to it apart. It is stamped on events from now on; a blank
  /// [screen] is never reported. [metadata] travels with the navigation.
  static void startNavigation(
    String screen, {
    String key = '',
    Map<String, Object?>? metadata,
  }) => RumRuntime.instance.dispatch('startNavigation', (p) {
    // Submitted first, so the screen is current when the launch metrics it
    // may release go out.
    p.submit(NavigationStartCapture(screen, key: key, metadata: metadata));
    if (screen.trim().isNotEmpty) {
      RumRuntime.instance.screenChanged(screen, key);
    }
  });

  /// Ends the manual navigation [startNavigation] began and reports it, with
  /// both calls' [metadata] merged.
  static void endNavigation([Map<String, Object?>? metadata]) =>
      RumRuntime.instance.dispatch(
        'endNavigation',
        (p) => p.submit(NavigationEndCapture(metadata)),
      );

  /// Stops `GroundcoverNavigatorObserver` from reporting navigations. Manual
  /// navigations still report.
  static void stopNavigationTracking() =>
      RumRuntime.instance.stopNavigationTracking();

  /// Marks the moment the app became usable, for time to interactive when
  /// `NativeOptions.tti` is [TtiMode.manual]. Call it once, when the first
  /// screen is genuinely ready: after its data has loaded, not merely when
  /// it is built. Only the first call counts.
  ///
  /// Unlike the other calls it also counts before [init] completes: it
  /// records when it was called, as in RN, so an early mark is a real one.
  static void markAppInteractive() {
    try {
      markManualInteractive(RumRuntime.instance.now());
    } catch (error) {
      handleError(error);
    }
  }
}

/// Log events, one method per level. [attributes] travel with the message.
final class RumLogger {
  const RumLogger._();

  void _emit(
    LogLevel level,
    String message,
    Map<String, Object?>? attributes,
  ) => RumRuntime.instance.dispatch(
    'logger.${level.name}',
    (p) => p.submit(LogCapture(message, level, attributes: attributes)),
  );

  void log(String message, [Map<String, Object?>? attributes]) =>
      _emit(LogLevel.log, message, attributes);
  void info(String message, [Map<String, Object?>? attributes]) =>
      _emit(LogLevel.info, message, attributes);
  void warn(String message, [Map<String, Object?>? attributes]) =>
      _emit(LogLevel.warn, message, attributes);
  void error(String message, [Map<String, Object?>? attributes]) =>
      _emit(LogLevel.error, message, attributes);
  void debug(String message, [Map<String, Object?>? attributes]) =>
      _emit(LogLevel.debug, message, attributes);
  void trace(String message, [Map<String, Object?>? attributes]) =>
      _emit(LogLevel.trace, message, attributes);
}
