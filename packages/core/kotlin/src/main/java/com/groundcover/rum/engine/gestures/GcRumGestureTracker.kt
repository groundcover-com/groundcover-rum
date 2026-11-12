package com.groundcover.rum.engine.gestures

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.Window

/**
 * Recovers the scroll and swipe kinematics JavaScript cannot see: on Android the JS touch
 * stream is cancelled the instant a ScrollView claims a gesture, so JS knows a scroll
 * started and roughly which way, but never how far, how fast, or when it ended.
 *
 * Observation only — the Window.Callback is WRAPPED with every call delegated, and a
 * pre-existing callback is chained rather than replaced.
 */
internal class GcRumGestureTracker(
    private val application: Application,
    /**
     * Fired the first time a real window is actually hooked, which is what JS waits for
     * before standing its own classifier down. It cannot use the arming status: [attach]
     * runs on the main looper while the engine arms off it, so "started" is true well
     * before anything is instrumented — and stays true if no window is ever hookable.
     *
     * Declared before [onGesture] so the gesture callback stays the trailing lambda.
     */
    private val onAttached: () -> Unit = {},
    private val onGesture: (GcRumGesture) -> Unit,
) {
    companion object {
        /**
         * FALSE, and it is a statement about this tracker rather than about Android.
         *
         * Attachment is driven by [Application.ActivityLifecycleCallbacks], so the unit of coverage
         * is an ACTIVITY. A React Native `Modal` renders into a `Dialog` — its own `Window`, but not
         * an Activity — so no lifecycle callback ever fires for it and nothing here hooks it.
         *
         * Rides on the `gestures_attached` signal because JavaScript cannot infer it and must not
         * guess: told only "attached", JS stands down app-wide, and a drag inside a modal is then
         * measured by nobody. The iOS twin attaches per `UIWindow` and answers true.
         */
        const val COVERS_ALL_SURFACES = false
    }

    private val density: Float =
        application.resources?.displayMetrics?.density?.takeIf { it > 0f } ?: 1f

    private val wrapped = mutableMapOf<Window, GcRumWindowCallback>()

    /**
     * Whether any window is hooked right now. Mirrors `wrapped.isNotEmpty()`, kept as a separate
     * field because `wrapped` is main-thread-confined by convention (see [onMain]) while this is
     * read from the bridge thread answering a re-init. Written only from main, so `@Volatile` is
     * the whole synchronization needed.
     */
    @Volatile
    private var attached = false

    /**
     * For a JS context that arrived AFTER the attach: [onAttached] is edge-triggered, and a second
     * `start` on an already-started engine never re-runs the attach, so the edge is unrepeatable.
     * Metro's fast-refresh produces exactly that, and JS would be left believing nothing was
     * attached while this tracker kept measuring — every swipe reported twice.
     */
    fun isAttached(): Boolean = attached
    private val mainHandler = Handler(Looper.getMainLooper())

    private val lifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) = attach(activity)
        override fun onActivityStopped(activity: Activity) = detach(activity)
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

        /**
         * An activity can be destroyed without being stopped first — a `finish()`
         * from `onCreate`, or a process the system is dismantling — and then the
         * wrapped callback and its recognizer stay in `wrapped`, holding the dead
         * activity, until SDK stop(). Detaching is idempotent, so doing it here
         * as well as in onActivityStopped costs a map lookup.
         */
        override fun onActivityDestroyed(activity: Activity) = detach(activity)
    }

    /**
     * Set by [stop], and checked by [attach], so nothing re-wraps a window after teardown has
     * unwrapped everything — which would leave the SDK instrumenting a window it believes it has
     * released, with nothing left to unwrap it again.
     *
     * A flag rather than a generation token that [stop] bumps and posted work compares against.
     * A token covers the one caller that posts from the BRIDGE thread — [start]'s seeded attach —
     * but not the other: `ActivityLifecycleCallbacks` arrive on main, where capturing the token
     * and comparing it happen in a single uninterrupted turn, so the comparison is always equal
     * and the guard a no-op. The flag states the condition directly, for both call sites.
     *
     * One flag rather than one per cycle because the engine never reuses a tracker: [GcRumEngine]
     * drops its reference on stop and constructs a new one on the next start.
     *
     * `@Volatile` for the same reason [attached] is: [stop] runs on the bridge thread while [attach]
     * reads this on main.
     */
    @Volatile
    private var stopped = false

    /**
     * @param initial the activity already on screen, if any. Lifecycle callbacks
     *   only report FUTURE transitions, and JavaScript arms the engine long after
     *   the launch activity started — so without seeding it here the tracker
     *   would attach to nothing until the user backgrounded the app and came
     *   back, and every gesture until then would be invisible.
     */
    fun start(initial: Activity? = null) {
        application.registerActivityLifecycleCallbacks(lifecycleCallbacks)
        if (initial != null) onMain { attach(initial) }
    }

    fun stop() {
        // BEFORE the unregister, because unregistering does not interrupt a dispatch already under
        // way: the platform copies the callback array under its lock and iterates outside it, so a
        // callback removed here can still be delivered afterwards. The flag is what that late
        // delivery reads.
        stopped = true
        runCatching { application.unregisterActivityLifecycleCallbacks(lifecycleCallbacks) }
        // Eagerly, not after the unwrap below: the unwrap is posted to main, and until it runs a
        // re-init asking `isAttached()` would be told yes by a tracker that is being torn down.
        // Answering no early only ever leaves JS in charge of its own capture.
        attached = false
        onMain {
            wrapped.entries.toList().forEach { (window, callback) ->
                // Restore only if nobody wrapped US in the meantime; otherwise leave
                // the chain intact rather than cutting someone else out of it.
                runCatching { if (window.callback === callback) window.callback = callback.delegate }
                runCatching { callback.recognizer.teardown() }
            }
            wrapped.clear()
            // AGAIN, and not redundantly: the eager clear above happens on the bridge thread, and
            // main is still free to run a lifecycle callback the platform had already dispatched
            // before this block gets its turn. [detach] recomputes the flag as the remaining count,
            // which is true while any other window is still in the map — so the flag can be back to
            // true by the time we get here, with the map about to be emptied. Recomputed rather than
            // assigned false so it keeps stating the same fact the rest of the class states.
            attached = wrapped.isNotEmpty()
        }
    }

    /**
     * Window.callback is main-thread state, and `wrapped` is reachable from
     * both the lifecycle callbacks (main) and the bridge thread that calls
     * start/stop. Funnelling every mutation through the main looper keeps it
     * single-threaded without a lock.
     */
    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) runCatching { block() }
        else mainHandler.post { runCatching { block() } }
    }

    private fun attach(activity: Activity) {
        // Teardown has run or is running. Reachable from both call sites: a lifecycle dispatch the
        // platform had already committed to before [stop] unregistered us, and [start]'s seeded
        // attach still sitting on the main looper. Without this the wrap outlives stop() with
        // nothing left to undo it — the host dispatches every touch through a released tracker and
        // the recognizer's pooled VelocityTracker is never given back.
        if (stopped) return
        val window = activity.window ?: return
        if (wrapped.containsKey(window)) return
        // No existing callback means the window is not in a state worth
        // instrumenting; wrapping null would make us the app's dispatcher.
        val delegate = window.callback ?: return

        runCatching {
            val recognizer = GcRumGestureRecognizer(activity, density, onGesture)
            val callback = GcRumWindowCallback(delegate, recognizer)
            window.callback = callback
            wrapped[window] = callback
            attached = true
            // Only now is anything actually observing touches. Announced every
            // time rather than once: JS's flag is idempotent, and a tracker that
            // re-attaches after a stop/start cycle has to be able to say so again.
            runCatching { onAttached() }
        }
    }

    private fun detach(activity: Activity) {
        val window = activity.window ?: return
        val callback = wrapped.remove(window) ?: return
        // Another window may still be hooked (a dialog activity over the main one), so this is
        // the remaining count, not `false`.
        attached = wrapped.isNotEmpty()
        runCatching { if (window.callback === callback) window.callback = callback.delegate }
        // A gesture can be in flight — onDown seen, no UP yet — when the activity
        // goes away, and the VelocityTracker it holds comes from a platform pool
        // and owns a native allocation. Releasing it on the way out is the same
        // obligation as the UP/CANCEL path.
        runCatching { callback.recognizer.teardown() }
    }
}

/** One gesture, in device-independent pixels so JavaScript never guesses at
 *  screen density. */
internal data class GcRumGesture(
    val kind: String,
    /**
     * Touch-DOWN time. JavaScript matches its own touch history against this, so
     * it must be when the finger LANDED — not when the detector finally
     * recognized the gesture, which lags by the slop and any pause before the
     * drag. A press-then-scroll would otherwise never correlate.
     */
    val startedAtMs: Long,
    val endedAtMs: Long,
    val startXDp: Double,
    val startYDp: Double,
    val endXDp: Double,
    val endYDp: Double,
    val direction: String,
    val distanceDp: Double,
    val velocityDpS: Double,
    val pointerCount: Int,
)

/**
 * Wraps a Window.Callback to observe touches. Kotlin's delegation forwards
 * every other method verbatim, so this stays a pure observer as the platform
 * adds methods to the interface.
 */
private class GcRumWindowCallback(
    val delegate: Window.Callback,
    val recognizer: GcRumGestureRecognizer,
) : Window.Callback by delegate {

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        // Observe first, then delegate — and never let observation change what
        // the app receives, or throw into its dispatch.
        runCatching { recognizer.onTouchEvent(event) }
        return delegate.dispatchTouchEvent(event)
    }
}

/**
 * Turns a touch stream into gestures.
 *
 * GestureDetector supplies the hard parts (slop, fling velocity) but has no
 * "sequence ended" callback, so plain drag-and-release is closed out here on
 * UP/CANCEL.
 */
private class GcRumGestureRecognizer(
    context: Context,
    private val density: Float,
    private val onGesture: (GcRumGesture) -> Unit,
) {
    private var downTimeMs = 0L
    private var downX = 0f
    private var downY = 0f
    private var scrolling = false
    private var maxPointers = 1
    private var velocityTracker: VelocityTracker? = null

    /** The platform's own fling figure, when it reported one. Null means it did
     *  not, which is itself information: the release was under its floor. */
    private var flingVelocityPxS: Double? = null

    private val detector = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean {
                downTimeMs = System.currentTimeMillis()
                downX = e.rawX
                downY = e.rawY
                scrolling = false
                maxPointers = e.pointerCount
                recycleVelocityTracker()
                velocityTracker = runCatching { VelocityTracker.obtain() }.getOrNull()
                return false
            }

            override fun onScroll(
                e1: MotionEvent?,
                e2: MotionEvent,
                distanceX: Float,
                distanceY: Float,
            ): Boolean {
                scrolling = true
                if (e2.pointerCount > maxPointers) maxPointers = e2.pointerCount
                return false
            }

            override fun onFling(
                e1: MotionEvent?,
                e2: MotionEvent,
                velocityX: Float,
                velocityY: Float,
            ): Boolean {
                // Recorded, not acted on. Emitting a "swipe" here would make the
                // platform's own fling floor (~50 dp/s from ViewConfiguration) the
                // definition of a swipe — roughly 6x below iOS's, so the same drag
                // would be labelled differently per platform. The kind is decided on
                // release, by the shared classifier.
                flingVelocityPxS = Math.hypot(velocityX.toDouble(), velocityY.toDouble())
                return false
            }
        },
    )

    fun onTouchEvent(event: MotionEvent) {
        detector.onTouchEvent(event)
        if (event.pointerCount > maxPointers) maxPointers = event.pointerCount
        // Fed every event so a release without a fling still has a velocity. The
        // tracker wants raw coordinates to match downX/downY.
        velocityTracker?.addMovement(event)

        val action = event.actionMasked
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            if (scrolling) emitRelease(event)
            scrolling = false
            recycleVelocityTracker()
        }
    }

    /**
     * Closes out a drag, letting the shared classifier decide what it was.
     *
     * Release velocity either way: the platform's fling figure when it reported
     * one, otherwise our own VelocityTracker's — never `distance / duration`, the
     * AVERAGE over the whole drag, or one field would carry two different
     * quantities depending on which branch produced it.
     */
    private fun emitRelease(e: MotionEvent) {
        val endedAtMs = System.currentTimeMillis()
        val velocityPxS = flingVelocityPxS ?: measuredVelocityPxS()

        val classified = GcRumGestureClassifier.classify(
            startXDp = downX / density.toDouble(),
            startYDp = downY / density.toDouble(),
            endXDp = e.rawX / density.toDouble(),
            endYDp = e.rawY / density.toDouble(),
            velocityDpS = velocityPxS / density,
            pointerCount = maxPointers,
        ) ?: return

        onGesture(
            GcRumGesture(
                kind = classified.kind,
                startedAtMs = downTimeMs,
                endedAtMs = endedAtMs,
                startXDp = downX / density.toDouble(),
                startYDp = downY / density.toDouble(),
                endXDp = e.rawX / density.toDouble(),
                endYDp = e.rawY / density.toDouble(),
                direction = classified.direction,
                distanceDp = classified.distanceDp,
                velocityDpS = classified.velocityDpS,
                pointerCount = maxPointers,
            )
        )
    }

    private fun measuredVelocityPxS(): Double = runCatching {
        val tracker = velocityTracker ?: return 0.0
        tracker.computeCurrentVelocity(1000)
        Math.hypot(tracker.xVelocity.toDouble(), tracker.yVelocity.toDouble())
    }.getOrDefault(0.0)

    /**
     * Abandons whatever gesture is in flight and gives the platform its
     * VelocityTracker back.
     *
     * For detach and SDK stop, where the touch stream simply ends — no UP, no
     * CANCEL, so [onTouchEvent]'s own release path never runs. Nothing is emitted:
     * a gesture we stopped watching mid-way has no end point, and reporting a
     * partial one would be worse than reporting none.
     */
    fun teardown() {
        scrolling = false
        recycleVelocityTracker()
    }

    private fun recycleVelocityTracker() {
        runCatching { velocityTracker?.recycle() }
        velocityTracker = null
        flingVelocityPxS = null
    }
}
