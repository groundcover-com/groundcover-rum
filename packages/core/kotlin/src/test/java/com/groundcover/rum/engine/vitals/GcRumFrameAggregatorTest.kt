package com.groundcover.rum.engine.vitals

import com.groundcover.rum.engine.vitals.GcRumFrameAggregator.SegmentReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What "slow" means, and what a segment is — the parts with judgement in them, so
 * they are tested away from any Android plumbing.
 *
 * The aggregator holds ONE open segment and hands it back when something closes
 * it; there is no timer and no windowing, since a window closing on a duration
 * would attribute a navigation's jank to the wrong screen.
 *
 * Kept in lockstep with iOS's GCRumFrameAggregatorTests: a divergence in the
 * thresholds makes the same app look jankier on one platform for no reason.
 */
class GcRumFrameAggregatorTest {

    private fun aggregator(
        maxSegmentMs: Long = 60_000,
        refreshRateHz: Double = 60.0,
    ) = GcRumFrameAggregator(maxSegmentMs, refreshRateHz)

    /** Feeds n frames of the given duration at ~60Hz, returning the last clock. */
    private fun feed(
        agg: GcRumFrameAggregator,
        count: Int,
        durationMs: Double,
        startMs: Long = 1_000,
    ): Long {
        var now = startMs
        repeat(count) {
            now += 16
            agg.record(durationMs, now)
        }
        return now
    }

    // region What counts as slow

    @Test
    fun `counts a frame as slow only once it has missed its vsync`() {
        val agg = aggregator()

        // At 60Hz the bar is 1000/59 = 16.95ms — one frame interval, not two.
        // 16.5ms still made its deadline; 20ms did not. Both go in the same
        // segment so the boundary itself is what is measured.
        feed(agg, 8, durationMs = 16.5)
        feed(agg, 2, durationMs = 20.0, startMs = 2_000)
        val segment = agg.flush(3_000, SegmentReason.NAVIGATION)

        assertEquals(10, segment!!.total)
        assertEquals(2, segment.slow)
    }

    @Test
    fun `scales the slow threshold to the display's refresh rate`() {
        // The bug this guards: a fixed 16.7ms bar calls a badly stuttering
        // 120Hz app perfectly healthy.
        val agg = aggregator(refreshRateHz = 120.0)

        // 120Hz: the bar is 1000/119 = 8.4ms. 10ms is comfortable at 60Hz and
        // late here — which is the whole reason the rate is a parameter.
        feed(agg, 10, durationMs = 10.0)
        val segment = agg.flush(2_000, SegmentReason.NAVIGATION)

        assertEquals(10, segment!!.slow)
    }

    @Test
    fun `counts a very late frame as frozen as well as slow`() {
        val agg = aggregator()

        feed(agg, 3, durationMs = 800.0)
        val segment = agg.flush(5_000, SegmentReason.NAVIGATION)

        assertEquals(3, segment!!.frozen)
        assertEquals(3, segment.slow)
    }

    /**
     * The wire has to carry the bar `slow` and `delayMs` were judged against.
     *
     * Android has no cadence estimation — FrameMetrics fires only on a real draw, so there is no
     * idle-frame stream to misclassify — which makes the budget here simply `1000/hz`. It ships
     * anyway, so a consumer never has to know which platform it is looking at or whether an
     * adaptive estimate was in play. iOS's twin is `carriesEffectiveBudget`.
     */
    @Test
    fun `carries the budget slow was judged against`() {
        val agg = aggregator(refreshRateHz = 120.0)

        agg.record(16.0, 1_000)
        val segment = agg.flush(5_000, SegmentReason.NAVIGATION)!!

        assertEquals(120.0, segment.refreshRate, 0.001)
        assertEquals(1000.0 / 120.0, segment.budgetMs, 0.001)
    }

    /**
     * The BOUNDARY, exclusive — iOS's `frozenBoundary` twin.
     *
     * The class KDoc says these thresholds are kept in lockstep with iOS "so a divergence makes the
     * same app look jankier on one platform for no reason", and the test above can't enforce it:
     * it feeds 800ms, which is frozen against any threshold up to 800, so without this test
     * `FROZEN_THRESHOLD_MS` could change and the suite would stay green.
     *
     * 700.0 exactly must NOT count, matching iOS's `> FROZEN_THRESHOLD_MS`; a hair over must.
     */
    @Test
    fun `700ms is the freeze boundary, exclusive`() {
        val agg = aggregator()

        agg.record(700.0, 1_000)
        agg.record(700.1, 1_016)
        val segment = agg.flush(5_000, SegmentReason.NAVIGATION)

        assertEquals(1, segment!!.frozen)
        // Both are far past the slow bar, so this pins the frozen count as the only thing the
        // boundary moves.
        assertEquals(2, segment.slow)
    }

    /**
     * `1000 / (rate - 1)` divides by zero at exactly 1Hz. No real display reports
     * that, which is precisely why it would only ever be found by a test.
     */
    @Test
    fun `survives a refresh rate of 1Hz without dividing by zero`() {
        val agg = aggregator(refreshRateHz = 1.0)

        agg.record(40.0, 1_000)
        val segment = agg.flush(1_100, SegmentReason.NAVIGATION)

        assertEquals(1, segment!!.total)
        // Whatever it decides, it must not be NaN-driven nonsense.
        assertTrue(segment.slow == 0 || segment.slow == 1)
    }

    @Test
    fun `carries the refresh rate through so the backend can interpret the rates`() {
        val agg = aggregator(refreshRateHz = 120.0)

        feed(agg, 2, durationMs = 40.0)
        val segment = agg.flush(3_000, SegmentReason.NAVIGATION)

        assertEquals(120.0, segment!!.refreshRate, 0.001)
    }

    // endregion

    // region Accumulating a segment

    /**
     * The core behaviour. Nothing closes a segment on a timer regardless of what the
     * user is doing; a screen's whole dwell is one segment, however long it lasts and
     * however many frames it contains (up to the safety cap).
     */
    @Test
    fun `accumulates indefinitely without emitting anything`() {
        val agg = aggregator(maxSegmentMs = 60_000)

        // 30 seconds of frames, well inside the 60s cap.
        repeat(1_800) { index ->
            assertNull(agg.record(16.0, 1_000 + index * 16L))
        }

        assertEquals(1_800, agg.flush(31_000, SegmentReason.NAVIGATION)!!.total)
    }

    @Test
    fun `carries the segment's own bounds, not the caller's clock`() {
        val agg = aggregator()

        // The segment opens on its FIRST frame, so its start is that frame's time
        // and not the aggregator's construction.
        agg.record(16.0, 5_000)
        agg.record(16.0, 5_500)
        val segment = agg.flush(9_000, SegmentReason.NAVIGATION)

        assertEquals(5_000L, segment!!.startMs)
        assertEquals(9_000L, segment.endMs)
    }

    /**
     * A 0 sentinel for "no segment open yet" collides with a legitimate
     * timestamp: the first frame would re-open the segment on the SECOND call,
     * and the segment would silently start late. Real clocks never hand out 0,
     * which is exactly why this would only ever be found by a test.
     */
    @Test
    fun `opens the first segment even when the clock reads zero`() {
        val agg = aggregator(maxSegmentMs = 1_000)

        agg.record(40.0, 0)
        val segment = agg.record(40.0, 1_000)

        assertEquals(0L, segment!!.startMs)
        assertEquals(1_000L, segment.endMs)
    }

    // endregion

    // region The safety cap

    @Test
    fun `force-closes a segment that has run past the cap`() {
        val agg = aggregator(maxSegmentMs = 1_000)

        assertNull(agg.record(100.0, 5_000))
        assertNull(agg.record(100.0, 5_500))

        val segment = agg.record(100.0, 6_000)

        assertEquals(SegmentReason.SAFETY, segment!!.reason)
        assertEquals(5_000L, segment.startMs)
        assertEquals(6_000L, segment.endMs)
        // The frame that closed it belongs to the segment it closed, not to the
        // next one — otherwise every cap-closed segment loses a frame and the one
        // after it gains a stranger.
        assertEquals(3, segment.total)
    }

    @Test
    fun `reopens at the close, leaving no gap in coverage`() {
        val agg = aggregator(maxSegmentMs = 1_000)

        agg.record(100.0, 0)
        val first = agg.record(100.0, 1_000)
        agg.record(100.0, 1_500)
        val second = agg.flush(1_800, SegmentReason.NAVIGATION)

        // Contiguous: a gap here is frames measured and then dropped, which is
        // worse than not measuring them, because the totals look complete.
        assertEquals(first!!.endMs, second!!.startMs)
        // And the counters really did start over.
        assertEquals(1, second.total)
    }

    // endregion

    // region Flush and reset

    @Test
    fun `flush hands back a partial segment`() {
        val agg = aggregator(maxSegmentMs = 60_000)

        agg.record(50.0, 1_000)
        val segment = agg.flush(1_200, SegmentReason.BACKGROUND)

        assertEquals(1_200L, segment!!.endMs)
        assertEquals(1, segment.total)
    }

    /**
     * An empty segment is not news, and shipping one makes "0 frames measured"
     * indistinguishable from "0% slow" on a dashboard. A navigation between two
     * screens the app never drew is the common case.
     */
    @Test
    fun `flush with no frames hands back nothing`() {
        assertNull(aggregator().flush(5_000, SegmentReason.NAVIGATION))
    }

    @Test
    fun `flush closes the segment, so a second flush is empty`() {
        val agg = aggregator()

        agg.record(50.0, 1_000)
        assertNotNull(agg.flush(1_100, SegmentReason.NAVIGATION))
        // The counters were reset, so the same frames cannot be reported twice.
        assertNull(agg.flush(1_200, SegmentReason.NAVIGATION))
    }

    /**
     * Every reason has to survive the round trip, and the wire strings are
     * mirrored by a TypeScript union that nothing off-device compares them to.
     */
    @Test
    fun `carries the reason it was given`() {
        for (reason in SegmentReason.values()) {
            val agg = aggregator()
            agg.record(50.0, 1_000)
            assertEquals(reason, agg.flush(1_100, reason)!!.reason)
        }
    }

    @Test
    fun `the reason's wire value matches the TypeScript union`() {
        assertEquals("navigation", SegmentReason.NAVIGATION.wireValue)
        assertEquals("background", SegmentReason.BACKGROUND.wireValue)
        assertEquals("safety", SegmentReason.SAFETY.wireValue)
    }

    // region Lost time
    //
    // An absolute duration rather than a rate, and the reason is worth keeping next to the
    // arithmetic: a rate needs a frame-count denominator, and the two platforms do not count the
    // same frames — Android's FrameMetrics fires only on a real draw, iOS's CADisplayLink on every
    // display refresh, so an idle iOS screen counts every refresh while Android counts only the
    // frames actually drawn. Nothing below divides by a count, so nothing can inherit that.

    @Test
    fun `sums the time each slow frame lost beyond the frame BUDGET`() {
        val agg = aggregator()

        // 60Hz: the budget is 1000/60 = 16.667ms; the slow BAR is 1000/59 = 16.949ms. Two 30ms
        // frames are slow and each lost 30 - 16.667 = 13.333ms.
        feed(agg, 2, durationMs = 30.0)
        // ...and eight comfortable frames lose nothing at all.
        feed(agg, 8, durationMs = 10.0, startMs = 2_000)
        val segment = agg.flush(3_000, SegmentReason.NAVIGATION)!!

        assertEquals(10, segment.total)
        assertEquals(2, segment.slow)
        assertEquals(26.667, segment.delayMs, 0.01)
    }

    @Test
    fun `charges nothing for a frame past the budget but inside the vsync tolerance`() {
        // THE distinction between the two thresholds, and the only test that pins it. 16.8ms is past
        // the 16.667ms budget but short of the 16.949ms bar, so it is deliberately not called slow —
        // and a delay accumulated over every frame rather than every SLOW frame would report time
        // lost on an app that is keeping up.
        val agg = aggregator()

        feed(agg, 5, durationMs = 16.8)
        val segment = agg.flush(1_000, SegmentReason.NAVIGATION)!!

        assertEquals(0, segment.slow)
        assertEquals(0.0, segment.delayMs, 1e-9)
    }

    @Test
    fun `scales the lost time to the display, so a 120Hz frame is late sooner`() {
        val agg = aggregator(refreshRateHz = 120.0)

        // 120Hz: the budget is 8.333ms. A 20ms frame lost 11.667ms here, against 3.333ms at 60Hz.
        feed(agg, 1, durationMs = 20.0)
        val segment = agg.flush(1_000, SegmentReason.NAVIGATION)!!

        assertEquals(11.667, segment.delayMs, 0.01)
    }

    @Test
    fun `reports a segment with no slow frames rather than dropping it`() {
        // A segment with nothing slow in it still ships, and its zero is how "this screen was
        // fine" gets said rather than omitted.
        val agg = aggregator()

        feed(agg, 1, durationMs = 10.0)
        feed(agg, 1, durationMs = 16.0, startMs = 2_000)
        feed(agg, 1, durationMs = 12.0, startMs = 3_000)
        val segment = agg.flush(4_000, SegmentReason.NAVIGATION)!!

        assertEquals(0, segment.slow)
    }

    @Test
    fun `clears the lost time when a segment closes`() {
        // The per-screen reset. Without it the next screen inherits this one's jank — the same
        // misattribution the per-screen segment exists to prevent, just in a different field.
        val agg = aggregator()

        feed(agg, 3, durationMs = 500.0)
        val first = agg.flush(1_000, SegmentReason.NAVIGATION)!!
        assertTrue(first.delayMs > 1_000)

        feed(agg, 1, durationMs = 10.0, startMs = 2_000)
        val second = agg.flush(3_000, SegmentReason.NAVIGATION)!!

        assertEquals(0.0, second.delayMs, 1e-9)
    }

    @Test
    fun `reset drops the accumulated lost time along with the segment`() {
        // Returning from the background. The frames are discarded, so the time they lost has to go
        // with them or it lands on the next screen.
        val agg = aggregator()

        feed(agg, 3, durationMs = 500.0)
        agg.reset(61_000)

        feed(agg, 1, durationMs = 10.0, startMs = 61_100)
        val segment = agg.flush(61_500, SegmentReason.NAVIGATION)!!

        assertEquals(0.0, segment.delayMs, 1e-9)
    }

    // endregion

    @Test
    fun `reset drops the in-flight segment instead of reporting it`() {
        // Returning from the background: the gap is not a real frame time.
        val agg = aggregator(maxSegmentMs = 60_000)

        agg.record(40.0, 1_000)
        agg.reset(61_000)

        assertNull(agg.flush(61_500, SegmentReason.NAVIGATION))
    }

    /**
     * reset also re-anchors the segment, so the time spent backgrounded is not
     * counted toward the safety cap — otherwise the first frame back would
     * immediately close a segment containing one frame.
     */
    @Test
    fun `reset re-anchors the segment start`() {
        val agg = aggregator(maxSegmentMs = 1_000)

        agg.record(50.0, 1_000)
        agg.reset(61_000)

        assertNull(agg.record(50.0, 61_100))
        assertEquals(61_000L, agg.flush(61_200, SegmentReason.NAVIGATION)!!.startMs)
    }

    // endregion
}
