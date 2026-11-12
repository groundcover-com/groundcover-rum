package com.groundcover.rum.engine.lifecycle

/**
 * Whether the app is in the foreground, from a stream of activity transitions. Android
 * has no app-level callback, so this counts started activities and reports the edges.
 * Pure on purpose — no android.* import, so the judgement runs in the JVM unit suite.
 *
 * Counts STARTED, not resumed: a dialog or an app-switcher peek pauses the top activity
 * without the app leaving, and treating that as a departure would pause the watchdogs
 * while the user is still looking at the app.
 *
 * Thread-safety: the lifecycle callbacks ([activityStarted]/[activityStopped]) arrive on
 * the MAIN thread, while [beginCounting]/[startObserving]/[stopObserving] run on the
 * engine's arm/teardown thread. `started` is updated compound (`++`/`--`), so a bare
 * `@Volatile` would not be enough — every accessor is `@Synchronized`, giving both the
 * atomicity that compound update needs and the happens-before that publishes one thread's
 * writes (and the resulting edge callbacks) to the other.
 */
internal class GcRumForegroundMonitor(
    private val onForeground: () -> Unit,
    private val onBackground: () -> Unit,
) {
    private var started = 0
    private var foreground = false

    /**
     * Whether edges are being REPORTED. Counting is unconditional — see
     * [beginCounting] for why the two are separate.
     */
    private var reporting = false

    val isForeground: Boolean @Synchronized get() = foreground

    /**
     * Starts counting, seeding whatever is already on screen. Called at engine CONSTRUCTION, not
     * when JS arms it: lifecycle callbacks report only future transitions, so anything started
     * before JS arrives is lost — leaving the count at zero with an activity on screen, so the
     * real departure is never reported either. The seed is irreducibly one bit, since Android
     * has no "how many are started" query.
     *
     * @param hasVisibleActivity whether an activity is on screen right now.
     */
    @Synchronized
    fun beginCounting(hasVisibleActivity: Boolean) {
        if (hasVisibleActivity) started = 1
    }

    /**
     * Begins REPORTING edges, and says where things stand now. Deliberately says "foreground"
     * again on a re-arm, since JS can destroy() and init() on one engine and the consumers —
     * themselves idempotent — need telling.
     *
     * @param hasVisibleActivity a FLOOR under the count, not a replacement: on some hosts
     *   [beginCounting] runs after the launch activity's onStart, so the count can be zero with
     *   the app on screen. Only raises zero to one, so an observed two survives.
     */
    @Synchronized
    fun startObserving(hasVisibleActivity: Boolean) {
        if (started == 0 && hasVisibleActivity) started = 1
        reporting = true
        if (started > 0 && !foreground) {
            foreground = true
            onForeground()
        }
    }

    /**
     * Stops reporting edges. Paired with [startObserving]. The COUNT deliberately
     * survives — it reflects activities genuinely still on screen, and with counting
     * owned by construction there is nothing to accumulate, so resetting would lose the
     * truth. Silent: the app has not backgrounded, we have merely stopped watching.
     */
    @Synchronized
    fun stopObserving() {
        reporting = false
        foreground = false
    }

    @Synchronized
    fun activityStarted() {
        started++
        if (!foreground && reporting) {
            foreground = true
            onForeground()
        }
    }

    /**
     * @param isChangingConfigurations a rotation (or any config change) stops the
     *   activity and immediately starts a replacement. The count legitimately
     *   touches zero in between, and treating that as a trip to the background
     *   would pause the watchdog exactly when a config change is most likely to
     *   stall the main thread — and then unpause it a frame later. Skip the edge;
     *   the recreated activity's start is what resumes normal accounting.
     */
    @Synchronized
    fun activityStopped(isChangingConfigurations: Boolean) {
        // Never go negative: a stop can arrive for an activity started before the
        // engine was armed, and an underflow would leave the app permanently
        // "backgrounded" from then on.
        if (started > 0) started--
        if (started > 0) return
        if (isChangingConfigurations) return
        if (foreground && reporting) {
            foreground = false
            onBackground()
        }
    }
}
