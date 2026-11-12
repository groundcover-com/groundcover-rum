package com.groundcover.rum.core.events

// What capture hands the pipeline: typed records, so value sets that are closed are enums, never
// open strings.

/** One captured signal, as the pipeline takes it. */
internal sealed class Capture

/**
 * `Groundcover.sendCustomEvent`. Not auto-redacted, by contract: scrub it in `enrichEvent` if it
 * can carry personal data.
 */
internal class CustomEventCapture(
    val name: String,
    val attributes: Map<String, Any?>,
    /** When it happened, in nanoseconds since the epoch. Null means "now". */
    val timestampNs: Long? = null
) : Capture()

/**
 * A log event's level: `Groundcover.logger`'s methods, and `log` for a line captured from the
 * platform's own logging.
 */
internal enum class LogLevel {
    LOG,
    INFO,
    WARN,
    ERROR,
    DEBUG,
    TRACE;

    /** The `level` the other SDKs send. */
    val wireName: String get() = name.lowercase()
}

/** A log line, from `Groundcover.logger` or the platform's own logging. Redacted as a log. */
internal class LogCapture(
    val message: String,
    val level: LogLevel,
    val attributes: Map<String, Any?>? = null,
    val timestampNs: Long? = null
) : Capture()

/** Why a request failed before a response. */
internal enum class NetworkErrorType(
    /** The `error_type` the other SDKs send. */
    val wireName: String
) {
    NETWORK_FAILURE("ERR_NETWORK_FAILURE"),
    TIMEOUT("ERR_TIMEOUT")
}

/**
 * One request, as an interceptor saw it. Headers and bodies are raw; the pipeline redacts,
 * truncates and shapes them.
 */
internal class NetworkCapture(
    val method: String,
    val url: String,
    /**
     * When the request started, epoch milliseconds. [endMs] is when its response headers (or its
     * failure) arrived: before the body is read, so reading never inflates the duration.
     */
    val startMs: Long,
    val endMs: Long,
    /** 0 for a request that failed before a response. */
    val status: Int? = null,
    val requestHeaders: Map<String, String> = emptyMap(),
    /** The text, or a placeholder from [com.groundcover.rum.core.events.network.BodyPlaceholder]. */
    val requestBody: String = "",
    val responseHeaders: Map<String, String> = emptyMap(),
    val responseBody: String = "",
    /** Set only for a request that failed before a response. */
    val errorType: NetworkErrorType? = null
) : Capture()

/** One stack frame, as the wire's `error_stacktrace` carries it. */
internal class ErrorFrame(
    val filename: String,
    val function: String,
    val lineno: Int,
    val colno: Int
) {
    fun toJson(): Map<String, Any?> =
        mapOf("filename" to filename, "function" to function, "lineno" to lineno, "colno" to colno)
}

/** An error, reported by the app (`captureException`) or caught by the SDK. */
internal class ErrorCapture(
    /** The error's type name, the grouping key with [message]. */
    val type: String,
    val message: String,
    /** Diagnostic, and never redacted. */
    val frames: List<ErrorFrame> = emptyList(),
    /** Reported by the app rather than caught by the SDK. */
    val handled: Boolean = false,
    val metadata: Map<String, Any?>? = null,
    val timestampNs: Long? = null
) : Capture()

/** Which stall a hang is: iOS's app hang or Android's ANR, each under its platform's own name. */
internal enum class HangKind(val wireName: String) {
    APP_HANG("AppHang"),
    ANR("ANR")
}

/**
 * A main-thread stall the app recovered from, from the native engine's watchdog. One that killed
 * the process arrives with the next launch's crash records instead.
 */
internal class HangCapture(
    val kind: HangKind,
    /**
     * When the stall began, in epoch milliseconds: the event is placed there, before the taps and
     * navigations it blocked, not at the recovery that reported it.
     */
    val startedAtMs: Double,
    val durationMs: Double,
    /** The main thread's stack, which only Android captures. */
    val frames: List<ErrorFrame> = emptyList()
) : Capture()

/** The launch metrics, by the name each ships under. */
internal enum class AppStartMetric(val wireName: String) {
    COLD("app_start_cold"),
    WARM("app_start_warm"),
    HOT("app_start_hot"),
    TTI("app_start_tti")
}

/** One launch metric, measured by the native engine (the start) and the app (time to interactive). */
internal class AppStartCapture(
    val metric: AppStartMetric,
    /** Milliseconds from the launch's start. */
    val valueMs: Long,
    /** The engine's start type (`cold`, `cold_prewarmed`, `warm`, `hot`). */
    val navigationType: String
) : Capture()

/** Why a frame segment ended. */
internal enum class FrameSegmentReason(val wireName: String) {
    /** The screen changed. */
    NAVIGATION("navigation"),

    /** The app left the foreground. */
    BACKGROUND("background"),

    /** It ran past the segment cap ([NativeOptions.vitalsMaxSegmentMs][com.groundcover.rum.NativeOptions]). */
    SAFETY("safety")
}

/**
 * The frames drawn on one screen between two boundaries: a screen change, a trip to the background,
 * or the cap. Carries the screen it was drawn on, which on a screen change is the one being left,
 * not the current one.
 */
internal class FrameSegmentCapture(
    /** The segment's bounds, in epoch milliseconds. */
    val startMs: Long,
    val endMs: Long,
    /**
     * Frames drawn; never sent (platforms don't count the same frames), only used to drop an empty
     * segment.
     */
    val total: Int,
    val slow: Int,
    val frozen: Int,
    val refreshRate: Double,
    /** Milliseconds lost beyond the frame budget, summed over slow frames. */
    val delayMs: Double,
    /** The frame budget, 0 when the engine had none to report. */
    val budgetMs: Double,
    val reason: FrameSegmentReason,
    val screenName: String,
    val screenKey: String
) : Capture()

/**
 * What a tap or a gesture landed on, as the capture layer found it. The pipeline masks [label],
 * [hint] and [valueText] when the privacy rules or [masked] say so.
 */
internal class InteractionTarget(
    /** The touched view's class (`Button`); empty for a Compose element, which has none. */
    val component: String = "",
    /** The accessible name: the content description, else the visible text. */
    val label: String = "",
    val role: String = "",
    val hint: String = "",
    /** Accessibility flags (`selected`, `checked`, `disabled`, …). */
    val state: Map<String, Any>? = null,
    /** The accessibility value. Never a text field's, which is what the user typed. */
    val valueText: String? = null,
    /** The views from the outside in (`DecorView > LinearLayout > Button`). */
    val componentPath: String = "",
    /** Marked private, itself or an ancestor. */
    val masked: Boolean = false
)

/** What kind of interaction: a tap, a gesture, or a finished text edit. */
internal enum class InteractionKind(val wireName: String) {
    TAP("tap"),
    LONG_PRESS("long_press"),
    SWIPE("swipe"),
    SCROLL("scroll"),
    PINCH("pinch"),
    INPUT("input")
}

/** Which way a swipe or scroll moved. */
internal enum class GestureDirection(val wireName: String) {
    UP("up"),
    DOWN("down"),
    LEFT("left"),
    RIGHT("right")
}

/** How a gesture other than a tap moved. */
internal class GestureMeasure(
    /** None for a long press or a pinch. */
    val direction: GestureDirection? = null,
    val distanceDp: Int,
    val velocityDpS: Int,
    val durationMs: Int,
    val pointerCount: Int,
    /** Cut short (the gesture was cancelled). */
    val partial: Boolean = false
)

/**
 * A tap, a gesture or a finished text edit (`input`, which carries no coordinates and never the
 * text).
 */
internal class InteractionCapture(
    val kind: InteractionKind,
    val target: InteractionTarget,
    /** dp: where a tap lifted, or where a gesture started. */
    val x: Double? = null,
    val y: Double? = null,
    /** For gestures only. */
    val gesture: GestureMeasure? = null,
    val timestampNs: Long? = null
) : Capture()
