package com.groundcover.rum.engine.gestures

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Direction, distance and swipe-vs-scroll — the Kotlin side of a decision three
 * runtimes make and one wire field carries.
 *
 * Deliberately a port of `GCRumGestureClassifierTests.swift`, case for case, so
 * the two suites can be diffed. A divergence between the platforms is invisible in
 * production — nothing crashes, no assertion on "some direction" notices, and the
 * dashboard is confidently wrong — so the tests agreeing is most of what keeps the
 * implementations agreeing.
 */
class GcRumGestureClassifierTest {

    private fun classify(
        from: Pair<Double, Double>,
        to: Pair<Double, Double>,
        velocityDpS: Double = 0.0,
        pointerCount: Int = 1,
    ) = GcRumGestureClassifier.classify(
        startXDp = from.first,
        startYDp = from.second,
        endXDp = to.first,
        endYDp = to.second,
        velocityDpS = velocityDpS,
        pointerCount = pointerCount,
    )

    // ---- Direction ----

    /**
     * Screen coordinates grow DOWNWARD. Dragging toward the top of the screen
     * decreases y and is "up" — the inversion people get wrong.
     */
    @Test
    fun `a drag toward the top of the screen is up`() {
        assertEquals("up", classify(100.0 to 500.0, 100.0 to 100.0)?.direction)
    }

    @Test
    fun `a drag toward the bottom of the screen is down`() {
        assertEquals("down", classify(100.0 to 100.0, 100.0 to 500.0)?.direction)
    }

    @Test
    fun `a drag toward the left edge is left`() {
        assertEquals("left", classify(500.0 to 100.0, 100.0 to 100.0)?.direction)
    }

    @Test
    fun `a drag toward the right edge is right`() {
        assertEquals("right", classify(100.0 to 100.0, 500.0 to 100.0)?.direction)
    }

    @Test
    fun `a diagonal drag is reported along whichever axis it mostly went`() {
        assertEquals("down", classify(0.0 to 0.0, 40.0 to 300.0)?.direction)
        assertEquals("right", classify(0.0 to 0.0, 300.0 to 40.0)?.direction)
    }

    /** Not a UX choice, just a tie-break that must be stable. */
    @Test
    fun `a perfectly diagonal drag resolves to the horizontal axis`() {
        assertEquals("right", classify(0.0 to 0.0, 100.0 to 100.0)?.direction)
        assertEquals("left", classify(0.0 to 0.0, -100.0 to -100.0)?.direction)
    }

    // ---- Minimum distance ----

    @Test
    fun `a movement below the reporting floor is not a gesture`() {
        assertNull(classify(0.0 to 0.0, 0.0 to 31.0))
    }

    @Test
    fun `the floor is inclusive`() {
        assertNotNull(classify(0.0 to 0.0, 0.0 to 32.0))
    }

    @Test
    fun `distance is the straight line between the ends, not one axis`() {
        // 3-4-5 triangle scaled: 30, 40 -> 50.
        assertEquals(50.0, classify(0.0 to 0.0, 30.0 to 40.0)?.distanceDp ?: 0.0, 0.0001)
    }

    // ---- swipe vs scroll ----

    /**
     * The divergence this classifier exists to close. Taking `GestureDetector.onFling`
     * firing AS the answer would make Android's
     * `ViewConfiguration.getMinimumFlingVelocity()` — around 50 dp/s — the bar, so a drag
     * released at, say, 150 dp/s would be a swipe here and a scroll on iOS. Same finger,
     * same motion, two labels, one wire field.
     */
    @Test
    fun `a drag released with momentum is a swipe`() {
        assertEquals("swipe", classify(0.0 to 0.0, 200.0 to 0.0, velocityDpS = 600.0)?.kind)
    }

    @Test
    fun `a drag released slowly is a scroll, however far it travelled`() {
        val result = classify(0.0 to 0.0, 800.0 to 0.0, velocityDpS = 150.0)
        assertEquals("scroll", result?.kind)
        assertEquals(800.0, result?.distanceDp ?: 0.0, 0.0001)
    }

    @Test
    fun `the swipe threshold is inclusive`() {
        assertEquals(
            "swipe",
            classify(0.0 to 0.0, 200.0 to 0.0, velocityDpS = GcRumGestureClassifier.SWIPE_VELOCITY_DP_S)?.kind,
        )
    }

    @Test
    fun `just under the swipe threshold is a scroll`() {
        assertEquals(
            "scroll",
            classify(
                0.0 to 0.0,
                200.0 to 0.0,
                velocityDpS = GcRumGestureClassifier.SWIPE_VELOCITY_DP_S - 1,
            )?.kind,
        )
    }

    /** No fling reported means the release was under the platform's own floor,
     *  which is far under ours. */
    @Test
    fun `a release the platform never reported as a fling is a scroll`() {
        assertEquals("scroll", classify(0.0 to 0.0, 200.0 to 0.0, velocityDpS = 0.0)?.kind)
    }

    /**
     * A two-finger drag is a PINCH, and native does not measure pinches — JavaScript's numbers are
     * all there are for one, which is why `NATIVE_MEASURED_KINDS` deliberately omits it.
     *
     * Native therefore has to decline the sequence entirely. Classifying it as a scroll/swipe does
     * not merely mislabel it: JS reports its `pinch` UNSUPPRESSED (suppression covers only
     * swipe/scroll), so the same two-finger gesture arrives twice — once as a native `scroll`, once
     * as a JS `pinch`. Duplicate interactions are exactly what the suppression mechanism exists to
     * prevent.
     */
    @Test
    fun `a multi-pointer sequence is declined, because a pinch is JavaScript's to report`() {
        assertNull(classify(0.0 to 0.0, 200.0 to 0.0, velocityDpS = 600.0, pointerCount = 2))
        assertNull(classify(0.0 to 0.0, 200.0 to 0.0, velocityDpS = 10.0, pointerCount = 3))
        // One finger travelling the same distance is still a gesture — the guard is on the pointer
        // count alone and must not swallow the ordinary case.
        assertNotNull(classify(0.0 to 0.0, 200.0 to 0.0, velocityDpS = 600.0, pointerCount = 1))
    }

    /** The three runtimes must agree on the number, not merely on the rule. */
    @Test
    fun `the thresholds match the other platforms`() {
        assertEquals(300.0, GcRumGestureClassifier.SWIPE_VELOCITY_DP_S, 0.0)
        assertEquals(32.0, GcRumGestureClassifier.MIN_DISTANCE_DP, 0.0)
    }
}
