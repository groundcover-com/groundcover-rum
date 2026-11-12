package com.groundcover.rum.engine.vitals

import android.app.Activity
import android.app.Application
import android.os.Handler
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// The engine's frame tracker under real Activity lifecycles. Here rather than in the engine's own
// JVM suite, which has no Android runtime; rum-android compiles the engine in.

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GcRumFrameTrackerTest {
    private val application = ApplicationProvider.getApplicationContext<Application>()
    private val main = Handler(Looper.getMainLooper())
    private val aggregator = GcRumFrameAggregator(maxSegmentMs = 60_000, refreshRateHz = 60.0)
    private val segments = mutableListOf<GcRumFrameAggregator.Segment>()
    private val tracker = GcRumFrameTracker(application, main, aggregator, { segments += it })

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()

    @Test
    fun `a stop that lands while the tracker starts still leaves the next departure counted`() {
        val launch = Robolectric.buildActivity(Activity::class.java).setup()
        var visible: Activity? = launch.get()
        // The engine starts the tracker on its own thread, and the user leaves the launch Activity
        // just then: its stop is a main-thread message, landing between the tracker reading what
        // is on screen and counting it.
        val readThenStop: () -> Activity? = {
            val seen = visible
            val stop = {
                launch.pause().stop()
                visible = null
            }
            if (Looper.myLooper() == Looper.getMainLooper()) {
                main.post(stop)
            } else {
                val stopped = CountDownLatch(1)
                main.post {
                    stop()
                    stopped.countDown()
                }
                stopped.await(5, TimeUnit.SECONDS)
            }
            seen
        }
        val engineThread = thread { tracker.start(readThenStop) }
        while (engineThread.isAlive) {
            idleMain()
            engineThread.join(10)
        }
        idleMain()

        // The user comes back, draws a frame and leaves again: that departure closes a segment.
        val next = Robolectric.buildActivity(Activity::class.java).setup()
        idleMain()
        aggregator.record(20.0, System.currentTimeMillis())
        next.pause().stop()
        idleMain()

        assertEquals(
            listOf(GcRumFrameAggregator.SegmentReason.BACKGROUND),
            segments.map { it.reason }
        )
        tracker.stop()
    }
}
