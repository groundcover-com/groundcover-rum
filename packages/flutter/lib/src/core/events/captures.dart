// What capture hands the pipeline: typed records, so value sets that are
// closed are enums, never open strings.

import '../common/time.dart';

/// One captured signal.
sealed class Capture {
  const Capture({this.timestampNs});

  /// When it happened, in nanoseconds since the epoch. Null means "now".
  final int? timestampNs;
}

/// `GroundcoverRum.sendCustomEvent`. Not auto-redacted, by contract: scrub it
/// in `enrichEvent` if it can carry personal data.
final class CustomEventCapture extends Capture {
  const CustomEventCapture(this.name, this.attributes, {super.timestampNs});

  final String name;
  final Map<String, Object?> attributes;
}

/// A log event's level: `GroundcoverRum.logger`'s methods, and `log` for a
/// line captured from the platform's own logging.
enum LogLevel { log, info, warn, error, debug, trace }

/// A log line, from `GroundcoverRum.logger` or captured from the platform's
/// own logging. Redacted under the log privacy rules.
final class LogCapture extends Capture {
  const LogCapture(
    this.message,
    this.level, {
    this.attributes,
    super.timestampNs,
  });

  final String message;
  final LogLevel level;
  final Map<String, Object?>? attributes;
}

/// Why a request failed before a response.
enum NetworkErrorType {
  networkFailure('ERR_NETWORK_FAILURE'),
  timeout('ERR_TIMEOUT');

  const NetworkErrorType(this.wireName);

  /// The `error_type` the other SDKs send.
  final String wireName;
}

/// One request, as an interceptor saw it. Headers and bodies are raw; the
/// pipeline redacts, truncates and shapes them.
final class NetworkCapture extends Capture {
  const NetworkCapture({
    required this.method,
    required this.url,
    required this.startMs,
    required this.endMs,
    this.status,
    this.requestHeaders = const {},
    this.requestBody = '',
    this.responseHeaders = const {},
    this.responseBody = '',
    this.errorType,
  });

  /// As sent: dart:io upper-cases it.
  final String method;
  final String url;

  /// When the request started, and when its response headers (or its
  /// failure) arrived: before the body is read, so reading never inflates
  /// the duration. Milliseconds since the epoch.
  final int startMs;
  final int endMs;

  /// 0 for a request that failed before a response.
  final int? status;
  final Map<String, String> requestHeaders;

  /// The text, or a placeholder from `BodyPlaceholder`.
  final String requestBody;
  final Map<String, String> responseHeaders;
  final String responseBody;

  /// Set only for a request that failed before a response.
  final NetworkErrorType? errorType;
}

/// One stack frame, as the wire's `error_stacktrace` carries it.
final class ErrorFrame {
  const ErrorFrame({
    required this.filename,
    required this.function,
    required this.lineno,
    required this.colno,
  });

  final String filename;
  final String function;
  final int lineno;
  final int colno;

  Map<String, Object?> toJson() => {
    'filename': filename,
    'function': function,
    'lineno': lineno,
    'colno': colno,
  };
}

/// An error, reported by the app (`captureException`) or caught by the SDK.
final class ErrorCapture extends Capture {
  const ErrorCapture({
    required this.type,
    required this.message,
    this.frames = const [],
    this.handled = false,
    this.metadata,
    super.timestampNs,
  });

  /// The error's type name (`StateError`), the grouping key with [message].
  final String type;
  final String message;

  /// Parsed by the capture layer. Diagnostic, and never redacted.
  final List<ErrorFrame> frames;

  /// Reported by the app rather than caught by the SDK's handlers.
  final bool handled;

  final Map<String, Object?>? metadata;
}

/// Which watchdog saw a stall: each platform's own name for it, which is
/// what an engineer searching for one types.
enum HangKind {
  /// Android's: an Application Not Responding.
  anr('ANR'),

  /// iOS's: an app hang.
  appHang('AppHang');

  const HangKind(this.wireName);

  /// The `error_type` the other SDKs send.
  final String wireName;
}

/// A main-thread stall the app recovered from, from the native engine's
/// watchdog. Dart runs on that thread, so a long stall in Dart is one too. One
/// that killed the process arrives with the next launch's crash records
/// instead.
final class HangCapture extends Capture {
  HangCapture({
    required this.kind,
    required this.startedAtMs,
    required this.durationMs,
    this.frames = const [],
  }) : super(timestampNs: fractionalMsToNs(startedAtMs));

  final HangKind kind;

  /// When the stall began, in epoch milliseconds: the event is placed there,
  /// before the taps and navigations it blocked, not at the recovery that
  /// reported it.
  final num startedAtMs;
  final num durationMs;

  /// The main thread's stack, which only Android captures.
  final List<ErrorFrame> frames;
}

/// The launch metrics, by the name each ships under.
enum AppStartMetric {
  cold('app_start_cold'),
  warm('app_start_warm'),
  hot('app_start_hot'),
  tti('app_start_tti');

  const AppStartMetric(this.wireName);

  /// The `performance_metric_name` the other SDKs send.
  final String wireName;
}

/// One launch metric, measured by the native engine (start) and the app
/// (time to interactive).
final class AppStartCapture extends Capture {
  const AppStartCapture({
    required this.metric,
    required this.valueMs,
    required this.navigationType,
  });

  final AppStartMetric metric;

  /// Milliseconds from the launch's start.
  final int valueMs;

  /// The engine's start type (`cold`, `cold_prewarmed`, `warm`, `hot`).
  final String navigationType;
}

/// Why a frame segment ended.
enum FrameSegmentReason {
  /// The screen changed.
  navigation('navigation'),

  /// The app left the foreground.
  background('background'),

  /// It ran past the segment cap (`NativeOptions.vitalsMaxSegment`).
  safety('safety');

  const FrameSegmentReason(this.wireName);

  /// The `performance_segment_reason` the other SDKs send.
  final String wireName;
}

/// The frames drawn on one screen between two boundaries: a navigation, a
/// trip to the background, or the cap. Carries the screen it was drawn on,
/// which on a navigation is the one being left, not the current one.
final class FrameSegmentCapture extends Capture {
  const FrameSegmentCapture({
    required this.startMs,
    required this.endMs,
    required this.total,
    required this.slow,
    required this.frozen,
    required this.refreshRate,
    required this.delayMs,
    required this.budgetMs,
    required this.reason,
    required this.screenName,
    required this.screenKey,
  });

  /// The segment's bounds, in epoch milliseconds.
  final int startMs;
  final int endMs;

  /// Frames drawn; never sent (counts differ between platforms), only used
  /// to drop an empty segment.
  final int total;
  final int slow;
  final int frozen;
  final double refreshRate;

  /// Milliseconds lost beyond the frame budget, summed over slow frames.
  final double delayMs;
  final double budgetMs;
  final FrameSegmentReason reason;
  final String screenName;
  final String screenKey;
}

/// What a tap or a gesture landed on, as the capture layer found it. The
/// pipeline masks [label], [hint] and [valueText] when the privacy rules or
/// [masked] say so.
final class InteractionTarget {
  const InteractionTarget({
    this.component = '',
    this.label = '',
    this.role = '',
    this.hint = '',
    this.state,
    this.valueText,
    this.componentPath = '',
    this.masked = false,
  });

  /// The innermost of the app's own widgets (`Button`).
  final String component;
  final String label;
  final String role;
  final String hint;

  /// Accessibility flags (`selected`, `checked`, `expanded`, `disabled`),
  /// each a bool, except a mixed checkbox's `checked: 'mixed'`, as in RN.
  final Map<String, Object>? state;

  /// The accessibility value. Flutter's is text only; RN's numeric
  /// `min`/`max`/`now` have no counterpart.
  final String? valueText;

  /// The app's widgets from the outside in (`HomeScreen > Card > Button`).
  final String componentPath;

  /// Inside a `GroundcoverPrivate`.
  final bool masked;
}

/// What kind of interaction: a tap, a gesture, or a finished text edit.
enum InteractionKind {
  tap('tap'),
  longPress('long_press'),
  swipe('swipe'),
  scroll('scroll'),
  pinch('pinch'),
  input('input');

  const InteractionKind(this.wireName);

  /// The `interaction_type` the other SDKs send.
  final String wireName;
}

/// Which way a swipe or scroll moved.
enum GestureDirection { up, down, left, right }

/// How a non-tap gesture moved. Classified in Dart: native trackers don't see
/// Flutter's surface.
final class GestureMeasure {
  const GestureMeasure({
    this.direction,
    required this.distanceDp,
    required this.velocityDpS,
    required this.durationMs,
    required this.pointerCount,
    this.partial = false,
  });

  /// None for a long press or a pinch.
  final GestureDirection? direction;
  final int distanceDp;
  final int velocityDpS;
  final int durationMs;
  final int pointerCount;

  /// Cut short (the gesture was cancelled).
  final bool partial;
}

/// A tap, a gesture or a finished text edit (`input`, which carries no
/// coordinates and never the text).
final class InteractionCapture extends Capture {
  const InteractionCapture({
    required this.kind,
    required this.target,
    this.x,
    this.y,
    this.gesture,
    super.timestampNs,
  });

  final InteractionKind kind;
  final InteractionTarget target;

  /// Logical pixels: where a tap lifted, or where a gesture started.
  final double? x;
  final double? y;

  /// For gestures only.
  final GestureMeasure? gesture;
}

/// A screen change: from a navigator observer, or the manual navigation API.
sealed class NavigationCapture extends Capture {
  const NavigationCapture({super.timestampNs});
}

/// A screen became current, as a navigator observer saw it. The pipeline
/// stamps it on every later event and reports the navigation, with the screen
/// it left and how long that one was shown.
final class ScreenCapture extends NavigationCapture {
  const ScreenCapture(this.name, this.key, {super.timestampNs});

  /// The route name; a capture with an empty one is ignored.
  final String name;

  /// This route instance's key, so two visits to one screen are told apart.
  final String key;
}

/// `GroundcoverRum.startNavigation`. A blank [screen] is dropped at its end.
final class NavigationStartCapture extends NavigationCapture {
  const NavigationStartCapture(
    this.screen, {
    this.key = '',
    this.metadata,
    super.timestampNs,
  });

  final String screen;
  final String key;
  final Map<String, Object?>? metadata;
}

/// `GroundcoverRum.endNavigation`: reports the navigation started last, with
/// both calls' metadata merged.
final class NavigationEndCapture extends NavigationCapture {
  const NavigationEndCapture([this.metadata]) : super();

  final Map<String, Object?>? metadata;
}
