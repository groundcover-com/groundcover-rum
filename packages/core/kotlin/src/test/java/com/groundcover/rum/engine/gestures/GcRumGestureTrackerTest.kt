package com.groundcover.rum.engine.gestures

import android.app.Activity
import android.app.Application
import android.os.Looper
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The two orderings between [GcRumGestureTracker.stop] on the bridge thread and the main looper
 * still finishing the job. Both need three things a plain unit test cannot offer — a controllable
 * main looper, real `Window`s to wrap, and a lifecycle callback that arrives after it was
 * unregistered — which is why this file runs under Robolectric.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GcRumGestureTrackerTest {

    /**
     * Models the one platform behaviour both races turn on: `Application.dispatchActivityStarted`
     * copies the callback array under its lock and then iterates OUTSIDE it, so a dispatch already
     * under way still delivers to a callback that `unregisterActivityLifecycleCallbacks` has since
     * removed. [inFlight] is that copy — it keeps the reference the platform would still be holding,
     * which is the only way a test can deliver the late callback.
     */
    private class SnapshotApplication(private val real: Application) : Application() {
        val inFlight = mutableListOf<ActivityLifecycleCallbacks>()

        override fun getResources() = real.resources

        override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
            inFlight += callback
        }

        /** Deliberately does NOT touch [inFlight]: that is the whole point. */
        override fun unregisterActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) = Unit
    }

    private fun activity(): Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private fun trackerOn(app: Application) = GcRumGestureTracker(app, onAttached = {}) { }

    /** [stop] runs on the bridge thread in production; from main its main-thread hop is inline. */
    private fun offMain(block: () -> Unit) = Thread { block() }.apply { start(); join() }

    @Test
    fun `a detach landing mid-teardown must not leave the attach flag set`() {
        val app = SnapshotApplication(RuntimeEnvironment.getApplication())
        val tracker = trackerOn(app)
        val first = activity()
        val second = activity()

        tracker.start(first)
        app.inFlight.forEach { it.onActivityStarted(second) }
        assertTrue("two windows hooked", tracker.isAttached())

        shadowOf(Looper.getMainLooper()).pause()
        offMain { tracker.stop() } // clears the flag eagerly, posts the unwrap
        // An onActivityStopped the platform had already dispatched. detach() recomputes the flag
        // as `wrapped.isNotEmpty()` — true, because the first window is still in the map.
        app.inFlight.forEach { it.onActivityStopped(second) }
        shadowOf(Looper.getMainLooper()).idle() // the posted unwrap empties `wrapped`

        // JS reads this across the bridge on re-init and suppresses its own swipe/scroll on the
        // strength of it, so a stale `true` here means nothing measures movement at all.
        assertFalse("nothing is hooked; isAttached() must not claim otherwise", tracker.isAttached())
    }

    @Test
    fun `an activity start landing after teardown must not wrap a window nobody will unwrap`() {
        val app = SnapshotApplication(RuntimeEnvironment.getApplication())
        val tracker = trackerOn(app)
        val activity = activity()
        val hostCallback = activity.window.callback

        tracker.start(activity)
        assertTrue(tracker.isAttached())

        shadowOf(Looper.getMainLooper()).pause()
        offMain { tracker.stop() }
        shadowOf(Looper.getMainLooper()).idle() // unwrap runs: callback restored, `wrapped` empty
        assertSame("teardown finished", hostCallback, activity.window.callback)

        // The late dispatch. stop() has already returned, so anything wrapped here is wrapped for
        // the life of the process: the host dispatches every touch through a dead tracker and the
        // recognizer's pooled VelocityTracker is never released.
        app.inFlight.forEach { it.onActivityStarted(activity) }

        assertSame("nothing will ever unwrap this again", hostCallback, activity.window.callback)
        assertFalse(tracker.isAttached())
    }
}
