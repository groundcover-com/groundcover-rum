package com.groundcover.rum.engine.vitals

/**
 * Accumulates frame durations into ONE open segment and hands it back when something closes it.
 * Per SCREEN, not per interval — a fixed wall-clock window straddling a navigation would be
 * labelled with whichever screen happened to be current. A pure value transformer, which is
 * what keeps it testable on a bare JVM.
 *
 * Shares iOS's slow/frozen THRESHOLDS ([slowThresholdMs] / [expectedFrameMs] /
 * [FROZEN_THRESHOLD_MS]), so the same frame duration is judged identically on both platforms.
 * It deliberately does NOT carry iOS's adaptive-refresh (ProMotion) cadence estimation — and
 * must not, because the two platforms feed this DIFFERENT inputs:
 *  - iOS feeds the CADisplayLink inter-tick INTERVAL, which on an idle 120Hz panel is ~16.7ms
 *    even for trivial content. So it has to estimate the rate the display is ACTUALLY running at
 *    (median of recent intervals) or every idle frame reads slow against the 8.33ms peak.
 *  - Android feeds `FrameMetrics.TOTAL_DURATION` — the frame's actual pipeline WORK-TIME, emitted
 *    only on a real draw (see [GcRumFrameTracker]). There is no idle-frame stream to misclassify,
 *    and a sustained high work-time genuinely IS jank that must be reported — not absorbed into a
 *    rolling baseline, which is exactly what porting the cadence estimate here would do.
 *
 * Net: identical `slow` judgement per frame duration; only iOS layers cadence estimation on top,
 * for a problem Android's frame source does not have.
 */
internal class GcRumFrameAggregator(
    private val maxSegmentMs: Long,
    private val refreshRateHz: Double,
) {
    /**
     * Why a segment ended. Ships on the wire, so a consumer can sum consecutive
     * [SAFETY] segments up to a [NAVIGATION]/[BACKGROUND] one and recover a whole
     * screen's total.
     *
     * [wireValue] is part of the wire contract.
     */
    internal enum class SegmentReason(val wireValue: String) {
        /** The user navigated. JavaScript asked for this one, because only
         *  JavaScript knows the screen is about to change. */
        NAVIGATION("navigation"),

        /** The app left the foreground. Pushed by native — the screen has not
         *  changed, so the ambient stamp is correct. */
        BACKGROUND("background"),

        /** The segment simply ran too long. A screen has no upper bound on how
         *  long a user stays, and unflushed counters are data nobody can see. */
        SAFETY("safety"),
    }

    data class Segment(
        val startMs: Long,
        val endMs: Long,
        val total: Int,
        val slow: Int,
        val frozen: Int,
        val refreshRate: Double,
        /**
         * Milliseconds lost across every slow frame — each one's duration beyond the frame budget,
         * summed. An ABSOLUTE duration on purpose: a rate needs a denominator, and the two
         * platforms do not count the same frames, so no rate is reported. Idle frames add exactly
         * zero here.
         */
        val delayMs: Double,
        /**
         * The budget [slow] and [delayMs] were actually judged against, in milliseconds.
         *
         * Constant here — Android has no cadence estimation, because FrameMetrics fires only on a
         * real draw and so has no idle-frame stream to misclassify. It ships anyway, so a consumer
         * never has to know which platform produced a segment or whether an adaptive estimate was
         * in play. On iOS this is the ESTIMATED cadence and differs from `1000/refreshRate` by up
         * to a factor of two on an idle ProMotion panel.
         */
        val budgetMs: Double,
        val reason: SegmentReason,
    )

    /** Nullable rather than a 0 sentinel: 0 is a valid timestamp, and a sentinel
     *  that collides with a real value swallows the first segment instead of
     *  opening it. */
    private var segmentStartMs: Long? = null
    private var total = 0
    private var slow = 0
    private var frozen = 0
    private var delayMs = 0.0

    /**
     * Adds a frame to the open segment.
     *
     * @return the closed segment when this frame pushed the segment past
     *   [maxSegmentMs], otherwise null. A segment normally ends via [flush].
     * @param frameDurationMs how long this frame took end to end.
     * @param nowMs wall clock, passed in so tests need no real time.
     */
    fun record(frameDurationMs: Double, nowMs: Long): Segment? {
        val startMs = segmentStartMs ?: nowMs
        segmentStartMs = startMs

        total++
        if (frameDurationMs > slowThresholdMs(refreshRateHz)) {
            slow++
            // Measured against the frame BUDGET (1000/hz), not against the slow bar (1000/(hz-1)).
            // The bar carries a vsync's tolerance so a frame landing a hair late is not called
            // slow; the time the user actually lost is still everything past the budget.
            delayMs += frameDurationMs - expectedFrameMs(refreshRateHz)
        }
        if (frameDurationMs > FROZEN_THRESHOLD_MS) frozen++
        // The cap is checked AFTER counting, so the frame that closes a segment
        // belongs to the segment it closes rather than to the next one.
        if (nowMs - startMs < maxSegmentMs) return null
        return close(nowMs, SegmentReason.SAFETY)
    }

    /**
     * Closes the open segment and hands it over.
     *
     * @return null when no frames were recorded — an empty segment is not news,
     *   and emitting one would make "0 frames" indistinguishable from "0% slow".
     */
    fun flush(endMs: Long, reason: SegmentReason): Segment? {
        if (total <= 0) return null
        return close(endMs, reason)
    }

    /**
     * Drops the in-flight segment without reporting — used when returning from
     * the background, where the gap is not a real frame time.
     *
     * Re-anchors as well as clearing: the time spent backgrounded must not count
     * toward the safety cap, or the first frame back would immediately close a
     * segment containing that one frame.
     */
    fun reset(nowMs: Long) {
        segmentStartMs = nowMs
        total = 0
        slow = 0
        frozen = 0
        delayMs = 0.0
    }

    /** Builds the segment and reopens the next one at the same instant, so
     *  coverage is contiguous — a gap here is frames measured and then dropped,
     *  which is worse than not measuring them because the totals look complete. */
    private fun close(endMs: Long, reason: SegmentReason): Segment {
        val segment = Segment(
            startMs = segmentStartMs ?: endMs,
            endMs = endMs,
            total = total,
            slow = slow,
            frozen = frozen,
            refreshRate = refreshRateHz,
            delayMs = delayMs,
            budgetMs = expectedFrameMs(refreshRateHz),
            reason = reason,
        )
        reset(endMs)
        return segment
    }

    internal companion object {
        /** Past this the user perceives a freeze, not a stutter. */
        const val FROZEN_THRESHOLD_MS = 700.0

        /**
         * One frame's worth of time — the budget a frame is late relative to.
         *
         * Distinct from [slowThresholdMs] on purpose: that bar is deliberately one vsync's
         * tolerance looser, so a frame a hair past its deadline is not CALLED slow. Once a frame is
         * slow, though, the time the user lost is everything past the budget, not past the bar.
         */
        fun expectedFrameMs(refreshRateHz: Double): Double =
            if (refreshRateHz > 0) 1000.0 / refreshRateHz else 1000.0 / 60.0

        /**
         * How late a frame must be to count as slow: one frame interval plus a vsync's
         * tolerance. `1000 / (rate - 1)` rather than `1000 / rate`, so a frame landing a
         * hair after its deadline — which every frame does — is not called slow. Relative to the
         * display, since a fixed 16.7ms bar would call a stuttering 120Hz app healthy.
         */
        fun slowThresholdMs(refreshRateHz: Double): Double =
            // A 1Hz display does not exist, but the subtraction divides by zero
            // there and the guard costs nothing.
            if (refreshRateHz > 1) 1000.0 / (refreshRateHz - 1) else 1000.0 / refreshRateHz
    }
}
