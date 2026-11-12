package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.events.AppStartCapture
import com.groundcover.rum.core.events.AppStartMetric
import com.groundcover.rum.core.events.Capture
import com.groundcover.rum.core.pipeline.CoreExecutor
import com.groundcover.rum.core.pipeline.ScheduledWork
import kotlin.math.roundToLong

// App start and time to interactive. The native engine measures how long the launch took to its
// first frame; the app adds the interactive mark, because only it knows when a screen is usable.

/**
 * When the app became usable: the "I" in TTI. Process state rather than the pipeline's, as RN's
 * and the Flutter SDK's: a mark can come before start, and it records when it was called. Each is
 * set once, since the first screen a user reaches is the one TTI is about.
 */
internal class InteractiveMarks {
    private var autoMs: Long? = null
    private var manualMs: Long? = null

    /**
     * The automatic anchor: the first screen landing. A floor rather than a promise: it comes
     * before that screen's own data loads. Says whether this call set it.
     */
    @Synchronized
    fun markAuto(nowMs: Long): Boolean {
        if (autoMs != null) return false
        autoMs = nowMs
        return true
    }

    /** The app's own word that the first screen is usable. Says whether this call set it. */
    @Synchronized
    fun markManual(nowMs: Long): Boolean {
        if (manualMs != null) return false
        manualMs = nowMs
        return true
    }

    /** The mark [manual] or automatic TTI is measured to, once it has landed. */
    @Synchronized
    fun mark(manual: Boolean): Long? = if (manual) manualMs else autoMs

    /** The testing reset, whose next start begins afresh. */
    @Synchronized
    fun reset() {
        autoMs = null
        manualMs = null
    }

    companion object {
        val shared = InteractiveMarks()
    }
}

/** One `app_start` signal from the engine, in epoch milliseconds. */
internal class AppStartSignal(val type: String, val startMs: Double, val firstFrameMs: Double)

/**
 * How long a launch metric waits for the screen it landed on: far more useful attributed to it,
 * but a screenless app must not lose the metric.
 */
internal const val APP_START_SCREEN_WAIT_MS = 5_000L

private class AppStartType(val metric: AppStartMetric, val anchorsTti: Boolean)

/**
 * Which metric each engine start type ships under, and whether it anchors TTI. Cold starts only:
 * TTI is measured from the cold start's origin, and a foreground return hours into the process is
 * no such origin. An unknown type is rejected rather than guessed, since the type picks the series.
 */
private val APP_START_TYPES = mapOf(
    "cold" to AppStartType(AppStartMetric.COLD, anchorsTti = true),
    "cold_prewarmed" to AppStartType(AppStartMetric.COLD, anchorsTti = true),
    "warm" to AppStartType(AppStartMetric.WARM, anchorsTti = false),
    "hot" to AppStartType(AppStartMetric.HOT, anchorsTti = false)
)

/**
 * Holds each launch metric for the first screen, and reports TTI once, from the cold start's
 * origin. Confined to the core thread.
 */
internal class AppStartTracker(
    private val submit: (Capture) -> Unit,
    private val manualTti: Boolean,
    private val marks: InteractiveMarks,
    private val executor: CoreExecutor,
    private val diagnostics: RumDiagnostics
) {
    private var screenIsKnown = false
    private val waiting = mutableListOf<() -> Unit>()
    private var screenTimer: ScheduledWork? = null
    private var disposed = false

    /** The cold start's origin and value, which TTI is measured from and clamped to. */
    private var coldStartMs: Double? = null
    private var coldDurationMs: Long? = null

    /**
     * Whether the cold start went out: TTI follows it, never precedes it, even when the mark lands
     * while the cold start waits for its screen.
     */
    private var coldSent = false
    private var reportedTti = false

    fun onAppStart(start: AppStartSignal) {
        if (disposed) return
        val elapsed = start.firstFrameMs - start.startMs
        if (elapsed.isNaN() || elapsed < 0 || elapsed >= Long.MAX_VALUE.toDouble()) return
        val durationMs = elapsed.roundToLong()
        val known = APP_START_TYPES[start.type]
        if (known == null) {
            diagnostics.log("[app-start] dropped an app start of unknown type ${start.type}")
            return
        }
        if (known.anchorsTti) {
            coldStartMs = start.startMs
            coldDurationMs = durationMs
        }
        whenScreenKnown {
            submit(AppStartCapture(known.metric, durationMs, start.type))
            // The mark may have landed while this waited for the screen.
            if (known.anchorsTti) coldSent = true
            reportTtiIfReady()
        }
    }

    /** A screen landed: launch metrics held for one go out under it. */
    fun screenKnown() {
        if (screenIsKnown) return
        screenIsKnown = true
        screenTimer?.cancel()
        screenTimer = null
        release()
    }

    /**
     * TTI, once the cold start went out and the mark this mode waits for has landed, measured from
     * the cold start's origin.
     */
    fun reportTtiIfReady() {
        if (disposed || reportedTti || !coldSent) return
        val startMs = coldStartMs ?: return
        val coldMs = coldDurationMs ?: return
        val markMs = marks.mark(manualTti) ?: return
        reportedTti = true
        // Clamped to the first frame: an app holding a splash screen can mark itself interactive
        // before anything was visible.
        val ttiMs = (markMs - startMs).roundToLong()
        submit(AppStartCapture(AppStartMetric.TTI, maxOf(ttiMs, coldMs), "cold"))
    }

    fun dispose() {
        disposed = true
        screenTimer?.cancel()
        screenTimer = null
        waiting.clear()
    }

    private fun whenScreenKnown(emit: () -> Unit) {
        if (screenIsKnown) return emit()
        waiting.add(emit)
        if (screenTimer == null) {
            screenTimer = executor.schedule(APP_START_SCREEN_WAIT_MS) {
                screenTimer = null
                release()
            }
        }
    }

    private fun release() {
        val released = waiting.toList()
        waiting.clear()
        for (emit in released) emit()
    }
}
