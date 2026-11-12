package com.groundcover.rum.engine.vitals

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.FrameMetrics
import android.view.Window
import androidx.annotation.RequiresApi
import com.groundcover.rum.engine.lifecycle.GcRumForegroundMonitor

/**
 * Feeds real frame timings into [GcRumFrameAggregator]. FrameMetrics (API 24+) reports what the
 * whole pipeline spent per frame, including work a Choreographer callback cannot see; below 24
 * there is no capture, since a wrong number is worse than none.
 *
 * Listeners attach per-activity because a Window is, and the callbacks land on the engine's
 * background thread so measuring jank never adds any. The aggregator hands closed segments
 * BACK, so what to do with one is this type's job.
 */
@RequiresApi(Build.VERSION_CODES.N)
internal class GcRumFrameTracker(
    private val application: Application,
    private val handler: Handler,
    private val aggregator: GcRumFrameAggregator,
    private val onSegment: (GcRumFrameAggregator.Segment) -> Unit,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private val listeners = mutableMapOf<Window, Window.OnFrameMetricsAvailableListener>()
    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Set synchronously by [stop], read from the frame callbacks and the lifecycle hops — all on
     * different threads, hence @Volatile. Removing a FrameMetrics listener is asynchronous and
     * lands on main, so callbacks queued before it stay in flight; this is what keeps them from
     * reaching the engine's emit after the bridge under it has been invalidated.
     */
    @Volatile
    private var stopped = false

    /** Set when the app left the foreground, cleared by the return it is waiting for. */
    @Volatile
    private var away = false

    /**
     * App-level edges from the per-Activity callbacks. Opening one Activity on top of another,
     * Back between them, a rotation or a dialog Activity is no trip to the background, and the
     * resume after a pause (a permission or biometric prompt) is no return: reacting to each
     * Activity would drop the departing screen's frames and file a `background` segment the user
     * never caused. A screen change closes its segment through the engine's flush instead.
     */
    private val foreground = GcRumForegroundMonitor(
        onForeground = {
            // Returning from the background: the gap is not a frame time.
            if (away) {
                away = false
                onAggregatorThread { aggregator.reset(nowMs()) }
            }
        },
        onBackground = {
            away = true
            // The app may never come back: this is the last chance to save this screen's
            // counters, since the return discards them.
            onAggregatorThread {
                emit(aggregator.flush(nowMs(), GcRumFrameAggregator.SegmentReason.BACKGROUND))
            }
        },
    )

    private val lifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            attach(activity)
            foreground.activityStarted()
        }

        override fun onActivityStopped(activity: Activity) {
            detach(activity)
            foreground.activityStopped(activity.isChangingConfigurations)
        }

        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    /**
     * @param initial the activity already on screen, if any. Lifecycle callbacks
     *   report only FUTURE transitions and the launch activity may have started
     *   before the engine was armed — unseeded, vitals would stay silent for the
     *   whole first foreground session.
     *
     * Registered, read and seeded in one task on main, where the lifecycle callbacks arrive, so
     * none can land in between. From the engine's thread, a stop landing after the read but before
     * the seed would be counted and then undone by it, leaving the count one high: no departure
     * would be seen again for the life of the process.
     */
    fun start(initial: () -> Activity? = { null }) {
        onMain {
            if (stopped) return@onMain
            application.registerActivityLifecycleCallbacks(lifecycleCallbacks)
            val current = initial()
            foreground.beginCounting(hasVisibleActivity = current != null)
            foreground.startObserving(hasVisibleActivity = current != null)
            if (current != null) attach(current)
        }
    }

    fun stop() {
        // BEFORE anything else, and synchronously: FrameMetrics callbacks and the lifecycle hops
        // below are already queued on other threads and will still run. Without this they reach
        // `onSegment` — the engine's emit — after teardown has invalidated the React bridge
        // underneath it. The engine's `runCatching` keeps that from crashing, but a signal
        // delivered into a dead bridge is not something to rely on being harmless.
        stopped = true
        foreground.stopObserving()
        onMain {
            // On main, as the registration is: a start still queued there sees `stopped` and
            // registers nothing.
            runCatching { application.unregisterActivityLifecycleCallbacks(lifecycleCallbacks) }
            // Iterate entries, not keys: the platform's remove() takes a non-null
            // listener, and a lookup by key is nullable.
            listeners.entries.toList().forEach { (window, listener) ->
                runCatching { window.removeOnFrameMetricsAvailableListener(listener) }
            }
            listeners.clear()
        }
    }

    private fun emit(segment: GcRumFrameAggregator.Segment?) {
        if (stopped) return
        if (segment != null) runCatching { onSegment(segment) }
    }

    /**
     * Runs aggregator work on the thread frame callbacks already arrive on.
     *
     * [GcRumFrameAggregator] holds plain mutable counters with no lock of its own — deliberately,
     * since it is a pure value transformer — so every mutation has to reach it from ONE thread.
     * `record` arrives on [handler] (that is where FrameMetrics is registered) and the bridge's
     * flush is posted there too, but the lifecycle callbacks above land on MAIN. Left there, a
     * rotation or a background transition could reset the counters mid-`record`, closing a segment
     * with bounds and counts from two different windows.
     */
    private fun onAggregatorThread(block: () -> Unit) {
        if (stopped) return
        // Dropped, not run inline, when the looper will not accept it. Running it here would put
        // the mutation back on the calling thread, which is the race this exists to remove — and a
        // dead looper means the engine is being torn down, so the segment had nowhere to go anyway.
        handler.post { runCatching(block) }
    }

    /** `listeners` is reachable from the lifecycle callbacks (main) and from the
     *  bridge thread that calls start/stop; the main looper is the one thread
     *  both can agree on. */
    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) runCatching { block() }
        else mainHandler.post { runCatching { block() } }
    }

    private fun attach(activity: Activity) {
        val window = activity.window ?: return
        if (listeners.containsKey(window)) return

        val listener = Window.OnFrameMetricsAvailableListener { _, metrics, _ ->
            runCatching {
                // TOTAL_DURATION is the whole pipeline, which is what the user
                // waited for — not just the part spent on the UI thread.
                val nanos = metrics.getMetric(FrameMetrics.TOTAL_DURATION)
                // Non-null only when this frame pushed the segment past the
                // safety cap.
                emit(aggregator.record(nanos / 1_000_000.0, nowMs()))
            }
        }

        runCatching {
            window.addOnFrameMetricsAvailableListener(listener, handler)
            listeners[window] = listener
        }
    }

    private fun detach(activity: Activity) {
        val window = activity.window ?: return
        val listener = listeners.remove(window) ?: return
        runCatching { window.removeOnFrameMetricsAvailableListener(listener) }
    }
}
