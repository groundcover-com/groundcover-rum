package com.groundcover.rum.capture

import com.groundcover.rum.core.events.GestureDirection
import com.groundcover.rum.core.events.InteractionKind
import com.groundcover.rum.core.pipeline.HostLifecycle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Touch sequences and what they classify as, and the lifecycle mapping. The window glue runs
// under Robolectric in WindowCaptureTest and on a device in the e2e suite.

private const val FINGER = 0
private const val SECOND_FINGER = 1

private fun sample(phase: TouchPhase, x: Double, y: Double, at: Double, id: Int = FINGER) =
    TouchSample(id, phase, x, y, at)

private fun sequence(vararg samples: TouchSample): TouchSequence? {
    val tracker = TouchTracker()
    return samples.firstNotNullOfOrNull {
        (tracker.process(it) as? TouchTracker.Edge.Ended)?.sequence
    }
}

class TouchTrackerTest {
    @Test
    fun theFirstFingerDownStartsASequenceAndTheLastOneUpEndsIt() {
        val tracker = TouchTracker()
        assertTrue(
            tracker.process(sample(TouchPhase.BEGAN, 10.0, 10.0, 0.0)) is TouchTracker.Edge.Began
        )
        assertNull(tracker.process(sample(TouchPhase.BEGAN, 50.0, 50.0, 10.0, SECOND_FINGER)))
        assertNull(tracker.process(sample(TouchPhase.ENDED, 10.0, 10.0, 20.0)))
        val up = tracker.process(sample(TouchPhase.ENDED, 50.0, 50.0, 30.0, SECOND_FINGER))
        val finished = (up as TouchTracker.Edge.Ended).sequence
        assertEquals(2, finished.pointerCount)
        assertEquals(20.0, finished.durationMs, 0.0)
    }

    @Test
    fun aQuickStillTouchIsATap() {
        val finished = sequence(
            sample(TouchPhase.BEGAN, 100.0, 100.0, 1000.0),
            sample(TouchPhase.MOVED, 104.0, 103.0, 1050.0),
            sample(TouchPhase.ENDED, 103.0, 102.0, 1100.0)
        )!!
        assertEquals(InteractionKind.TAP, TouchClassifier.classify(finished)?.kind)
        assertEquals(103.0, finished.endX, 0.0)
        assertEquals(102.0, finished.endY, 0.0)
    }

    @Test
    fun aTouchThatLeftTheSlopIsNoTapEvenIfItCameBack() {
        val finished = sequence(
            sample(TouchPhase.BEGAN, 100.0, 100.0, 0.0),
            sample(TouchPhase.MOVED, 115.0, 100.0, 50.0),
            sample(TouchPhase.ENDED, 100.0, 100.0, 100.0)
        )!!
        assertEquals(15.0, finished.maxTravel, 0.0)
        // Out of the slop, and back to under the 32 dp a scroll needs: nothing.
        assertNull(TouchClassifier.classify(finished))
    }

    @Test
    fun aStillTouchHeldPast500msIsALongPress() {
        val tap = sequence(
            sample(TouchPhase.BEGAN, 0.0, 0.0, 0.0),
            sample(TouchPhase.ENDED, 0.0, 0.0, 500.0)
        )!!
        assertEquals(InteractionKind.TAP, TouchClassifier.classify(tap)?.kind)
        val held = sequence(
            sample(TouchPhase.BEGAN, 0.0, 0.0, 0.0),
            sample(TouchPhase.MOVED, 3.0, 4.0, 600.0),
            sample(TouchPhase.ENDED, 3.0, 4.0, 1200.0)
        )!!
        val press = TouchClassifier.classify(held)!!
        assertEquals(InteractionKind.LONG_PRESS, press.kind)
        assertEquals(1200, press.gesture?.durationMs)
        assertEquals(5, press.gesture?.distanceDp)
        assertEquals(1, press.gesture?.pointerCount)
        assertNull(press.gesture?.direction)
    }

    @Test
    fun aSlowDragIsAScrollWithItsReleaseVelocity() {
        // 50 dp up over a second, at a steady pace: the release velocity is the pace.
        val samples = mutableListOf(sample(TouchPhase.BEGAN, 100.0, 300.0, 0.0))
        for (step in 1..10) {
            samples.add(
                sample(
                    TouchPhase.MOVED,
                    100.0,
                    300.0 - step * 5,
                    step * 100.0
                )
            )
        }
        samples.add(sample(TouchPhase.ENDED, 100.0, 250.0, 1000.0))
        val result = TouchClassifier.classify(sequence(*samples.toTypedArray())!!)!!
        assertEquals(InteractionKind.SCROLL, result.kind)
        assertEquals(GestureDirection.UP, result.gesture?.direction)
        assertEquals(50, result.gesture?.distanceDp)
        assertEquals(1000, result.gesture?.durationMs)
        assertTrue(result.gesture!!.velocityDpS in 45..55)
        assertFalse(result.gesture!!.partial)
    }

    @Test
    fun aFastFlickIsASwipe() {
        val samples = mutableListOf(sample(TouchPhase.BEGAN, 100.0, 600.0, 0.0))
        for (step in 1..6) {
            samples.add(
                sample(
                    TouchPhase.MOVED,
                    100.0,
                    600.0 - step * 75,
                    step * 25.0
                )
            )
        }
        samples.add(sample(TouchPhase.ENDED, 100.0, 150.0, 150.0))
        val result = TouchClassifier.classify(sequence(*samples.toTypedArray())!!)!!
        assertEquals(InteractionKind.SWIPE, result.kind)
        assertEquals(450, result.gesture?.distanceDp)
        assertTrue(result.gesture!!.velocityDpS in 2700..3300)
    }

    @Test
    fun aFlickThatComesToRestBeforeReleaseIsAScroll() {
        // 200 dp in 100 ms, then held still for 300 ms: fast on average, at rest when let go.
        val samples = mutableListOf(sample(TouchPhase.BEGAN, 100.0, 600.0, 0.0))
        for (step in 1..4) {
            samples.add(
                sample(
                    TouchPhase.MOVED,
                    100.0,
                    600.0 - step * 50,
                    step * 25.0
                )
            )
        }
        for (step in 1..6) samples.add(sample(TouchPhase.MOVED, 100.0, 400.0, 100.0 + step * 50))
        samples.add(sample(TouchPhase.ENDED, 100.0, 400.0, 400.0))
        val result = TouchClassifier.classify(sequence(*samples.toTypedArray())!!)!!
        assertEquals(InteractionKind.SCROLL, result.kind)
        assertEquals(0, result.gesture?.velocityDpS)
    }

    @Test
    fun twoFingersAreAPinchMeasuredByTheirSpread() {
        val pinch = sequence(
            sample(TouchPhase.BEGAN, 100.0, 100.0, 0.0),
            sample(TouchPhase.BEGAN, 200.0, 100.0, 5.0, SECOND_FINGER),
            sample(TouchPhase.MOVED, 50.0, 100.0, 100.0),
            sample(TouchPhase.MOVED, 250.0, 100.0, 100.0, SECOND_FINGER),
            sample(TouchPhase.ENDED, 50.0, 100.0, 200.0),
            sample(TouchPhase.ENDED, 250.0, 100.0, 210.0, SECOND_FINGER)
        )!!
        val result = TouchClassifier.classify(pinch)!!
        assertEquals(InteractionKind.PINCH, result.kind)
        assertEquals(2, result.gesture?.pointerCount)
        assertEquals(100, result.gesture?.distanceDp)
        assertNull(result.gesture?.direction)
    }

    @Test
    fun twoFingersOrACancelledTouchAreNoTap() {
        val twoFingers = sequence(
            sample(TouchPhase.BEGAN, 0.0, 0.0, 0.0),
            sample(TouchPhase.BEGAN, 40.0, 0.0, 5.0, SECOND_FINGER),
            sample(TouchPhase.ENDED, 0.0, 0.0, 50.0),
            sample(TouchPhase.ENDED, 40.0, 0.0, 60.0, SECOND_FINGER)
        )!!
        assertEquals(InteractionKind.PINCH, TouchClassifier.classify(twoFingers)?.kind)
        val cancelled = sequence(
            sample(TouchPhase.BEGAN, 0.0, 0.0, 0.0),
            sample(TouchPhase.CANCELLED, 0.0, 0.0, 50.0)
        )!!
        assertTrue(cancelled.cancelled)
        assertNull(TouchClassifier.classify(cancelled))
    }

    @Test
    fun aResetForgetsASequenceInFlight() {
        val tracker = TouchTracker()
        tracker.process(sample(TouchPhase.BEGAN, 0.0, 0.0, 0.0))
        tracker.reset()
        assertNull(tracker.process(sample(TouchPhase.ENDED, 0.0, 0.0, 10.0)))
    }
}

class LifecycleMapperTest {
    @Test
    fun theLaunchIsNoReturnAndALaterReturnIs() {
        val reported = mutableListOf<HostLifecycle>()
        val mapper = LifecycleMapper { reported.add(it) }
        mapper.foreground()
        mapper.background()
        mapper.foreground()
        assertEquals(listOf(HostLifecycle.BACKGROUND, HostLifecycle.FOREGROUND), reported)
    }
}
