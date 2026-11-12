package com.groundcover.rum.engine.appstart

/** Beyond this a "launch" is not a launch — the device slept, the app was
 *  suspended mid-start, a debugger was attached. Reporting it would poison
 *  the metric with values no user experienced. */
private const val SANITY_CAP_MS = 60_000L

/** A fresh activity created well after the process began is a warm start,
 *  not a cold one. */
private const val COLD_START_WINDOW_MS = 10_000L

// The wire values. The host SDK validates them on its side of the bridge — an unknown one
// is DROPPED rather than guessed, since this string selects which metric series a value
// lands in.
private const val TYPE_COLD = "cold"
private const val TYPE_WARM = "warm"
private const val TYPE_HOT = "hot"

/**
 * Which start a launch or a return is, from the provider's lifecycle callbacks. Pure on purpose,
 * no clock and no android.*, so the JVM unit suite can drive it; [GcRumAppStartTracker] holds the
 * one instance under its lock and passes the time in.
 */
internal class GcRumAppStartState {
    var processStartMs: Long = 0
    private var activityCreateMs: Long = 0
    private var isFreshLaunch = false
    private var reportedColdStart = false
    private var foregroundedAtMs: Long = 0

    /**
     * Started activities, so an app-level foreground edge is observable at all. Android has no
     * app-level callback — the count going 0 -> 1 IS the edge, the same derivation
     * [com.groundcover.rum.engine.lifecycle.GcRumForegroundMonitor] makes for its own purposes.
     */
    private var startedActivities = 0

    /**
     * Whether the stop that last took the count to zero was a configuration change (a rotation,
     * dark mode, a locale change). The Activity is destroyed and recreated on the same screen at
     * once: neither the recreation nor the start that follows is a start the user waited for.
     */
    private var stoppedForConfigChange = false

    /**
     * What the next [firstFrame] should report: [TYPE_HOT] for a plain foreground return,
     * upgraded to [TYPE_WARM] if an Activity is created before the frame lands.
     *
     * The two are DIFFERENT POPULATIONS and must not share a metric. A hot start is the one a user
     * produces dozens of times a day; a warm start needs the system to have torn the Activity down.
     */
    private var pendingStartType: String? = null

    /**
     * The app came back to the foreground. Only the 0 -> 1 edge counts: an Activity started on top
     * of another (a dialog activity, a task switch inside the app) is not a foreground return, and
     * neither is the start that follows a configuration change.
     *
     * Never before the cold start is out — during launch this edge fires too, and that launch is
     * already being measured from the process anchor.
     */
    fun activityStarted(nowMs: Long) {
        val wasBackground = startedActivities == 0
        startedActivities++
        if (!wasBackground) return
        val configChange = stoppedForConfigChange
        stoppedForConfigChange = false
        if (configChange || !reportedColdStart) return
        foregroundedAtMs = nowMs
        // Not overwritten if a create already claimed this transition as a warm start.
        if (pendingStartType == null) pendingStartType = TYPE_HOT
    }

    fun activityStopped(isChangingConfigurations: Boolean) {
        if (startedActivities > 0) startedActivities--
        if (startedActivities == 0) stoppedForConfigChange = isChangingConfigurations
    }

    fun activityCreated(isFreshLaunch: Boolean, nowMs: Long) {
        if (activityCreateMs != 0L) {
            // A later activity in a live process. Only one created while nothing is on screen
            // means the system tore the UI down and the user came back to it: a WARM start, which
            // outranks the hot start the foreground edge will claim. One opened on top of a
            // running Activity is in-app navigation, and one recreated after a configuration
            // change is the same screen redrawn.
            if (startedActivities == 0 && !stoppedForConfigChange) {
                foregroundedAtMs = nowMs
                pendingStartType = TYPE_WARM
            }
            return
        }
        activityCreateMs = nowMs
        this.isFreshLaunch = isFreshLaunch
    }

    /** The first frame after a resume: the start it ends, if one is open. */
    fun firstFrame(nowMs: Long): GcRumAppStartTracker.AppStart? = if (!reportedColdStart) {
        reportedColdStart = true
        val cold = isFreshLaunch &&
            processStartMs != 0L &&
            activityCreateMs - processStartMs <= COLD_START_WINDOW_MS
        val anchor = if (cold) processStartMs else activityCreateMs
        buildStart(if (cold) TYPE_COLD else TYPE_WARM, anchor, nowMs)
    } else if (foregroundedAtMs != 0L) {
        val anchor = foregroundedAtMs
        val type = pendingStartType ?: TYPE_HOT
        foregroundedAtMs = 0
        pendingStartType = null
        buildStart(type, anchor, nowMs)
    } else {
        null
    }

    /** Drops an in-flight foreground return, so it isn't reported against a later arming. */
    fun forgetForegroundReturn() {
        foregroundedAtMs = 0
        pendingStartType = null
    }

    private fun buildStart(
        type: String,
        startMs: Long,
        firstFrameMs: Long,
    ): GcRumAppStartTracker.AppStart? {
        if (startMs <= 0 || firstFrameMs < startMs) return null
        if (firstFrameMs - startMs > SANITY_CAP_MS) return null
        return GcRumAppStartTracker.AppStart(type, startMs, firstFrameMs)
    }
}
