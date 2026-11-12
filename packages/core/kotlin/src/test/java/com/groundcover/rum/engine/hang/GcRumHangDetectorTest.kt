package com.groundcover.rum.engine.hang

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Whether a stall is SEEN at all, and what duration is reported for it.
 *
 * These are the two things a watchdog can get wrong, and both turn on the SEQUENCE of observations
 * rather than any single verdict — so the sequence is what is replayed here, at the cadence the
 * monitor thread actually polls on.
 *
 * A watchdog that posts ONE token, sleeps the whole threshold, then asks whether it has run sees a
 * stall only if the token happens to be posted inside `[T, T + D - H)` — post earlier and it runs
 * before the stall begins, post later and it runs at `T + D`, still inside its own window, so the
 * cycle concludes the app is healthy. Its detection probability is `(D - H) / (H + POLL)`: 40%
 * for a 3s stall at a 2s threshold, ~18% for a 6s freeze at the 5s Android default.
 *
 * Every test below therefore sweeps the stall's PHASE across a full poll cycle. A test that picked
 * one phase could pass against such a sampling watchdog 40% of the time, which is how a coin-flip
 * defect survives a suite.
 */
class GcRumHangDetectorTest {

    private val threshold = 2_000L

    /** The monitor's poll cadence. Mirrors GcRumAnrWatchdog.POLL_INTERVAL_MS. */
    private val poll = 500L

    private val bootMs = 10_000L

    /**
     * Replays what the monitor thread observes across a stall, faithfully to the loop it drives:
     * post a probe if none is outstanding, sleep one poll interval, then observe. A probe posted
     * while the main thread is stuck does not run until the stall ends, which is exactly the
     * condition being detected.
     *
     * @param stallMs how long the main thread is blocked. 0 for a healthy app.
     * @param phaseMs how far into a poll cycle the stall begins — the variable a sampling
     *   watchdog is silently sensitive to.
     */
    private fun replay(
        stallMs: Long,
        phaseMs: Long,
        detector: GcRumHangDetector = GcRumHangDetector(threshold),
        onObserve: (GcRumHangDetector) -> Unit = {},
    ): GcRumHangDetector.Hang? {
        val stallStart = bootMs + poll + phaseMs
        val stallEnd = stallStart + stallMs

        // The loop stamps the heartbeat as it starts, so the first window is not counted against a
        // main thread nobody has probed yet.
        var lastBeat = bootMs
        var pendingPostedAt: Long? = null
        var now = bootMs
        var reported: GcRumHangDetector.Hang? = null

        // Well past the stall, so a detector that never reports is distinguishable from one that
        // reports late.
        while (now < stallEnd + 10 * poll) {
            if (pendingPostedAt == null) pendingPostedAt = now
            now += poll

            // A probe posted at p runs at p on a free main thread, and not until the stall ends if
            // it was posted inside one.
            val postedAt = pendingPostedAt
            val runsAt = if (postedAt in stallStart until stallEnd) stallEnd else postedAt
            if (runsAt <= now) {
                lastBeat = runsAt
                pendingPostedAt = null
            }

            val hang = detector.observe(now, lastBeat)
            if (hang != null && reported == null) reported = hang
            onObserve(detector)
        }
        return reported
    }

    /** Every phase across one full poll cycle, plus the two boundaries. */
    private fun phases(): List<Long> = (0L until poll step 50L).toList() + listOf(poll - 1)

    // region Detection — is the stall seen at all

    @Test
    fun `sees a stall longer than the threshold at every phase of the poll cycle`() {
        // A 3s stall at a 2s threshold must be reported at every phase, because detection must
        // not depend on when a single token happened to be posted.
        phases().forEach { phase ->
            val hang = replay(stallMs = 3_000, phaseMs = phase)
            assertNotNull("a 3000ms stall was missed at phase ${phase}ms", hang)
        }
    }

    @Test
    fun `sees a stall barely over the threshold, which single-token sampling cannot`() {
        // Single-token sampling needs `D > 2H + POLL` — 4.5s here, 10.5s at the 5s Android
        // default — before detection is certain, and anything between H and that bound is a coin
        // flip. Here one poll interval past the threshold is enough.
        phases().forEach { phase ->
            val hang = replay(stallMs = threshold + poll, phaseMs = phase)
            assertNotNull("a ${threshold + poll}ms stall was missed at phase ${phase}ms", hang)
        }
    }

    @Test
    fun `sees a six second freeze at the five second Android default`() {
        // At the Android default a single-token sampler reports this about 18% of the time, and a
        // low hang count reads as a healthy app rather than as a watchdog that cannot see.
        (0L until poll step 100L).forEach { phase ->
            val hang = replay(
                stallMs = 6_000,
                phaseMs = phase,
                detector = GcRumHangDetector(thresholdMs = 5_000),
            )
            assertNotNull("a 6s freeze was missed at the 5s default, phase ${phase}ms", hang)
        }
    }

    @Test
    fun `reports nothing for a responsive app`() {
        phases().forEach { phase ->
            assertNull(replay(stallMs = 0, phaseMs = phase))
        }
    }

    @Test
    fun `reports nothing for a stall shorter than the threshold`() {
        // A watchdog that fires below its own threshold is worse than one that samples coarsely:
        // it makes every scroll an incident.
        phases().forEach { phase ->
            assertNull(
                "a ${threshold - poll}ms stall was reported at phase ${phase}ms",
                replay(stallMs = threshold - poll, phaseMs = phase),
            )
        }
    }

    // endregion

    // region Duration — measured from when the stall began

    @Test
    fun `measures the stall from the last responsive instant, not from a probe posted inside it`() {
        // Timing from when the TOKEN WAS POSTED — necessarily somewhere inside the stall — would
        // under-report every duration by however long the stall had already been running.
        //
        // The heartbeat times from the last instant the main thread was KNOWN responsive, which
        // is at most one poll interval before the stall truly began. That makes the error a
        // bounded OVER-estimate rather than an unbounded under-estimate: a duration that reads
        // slightly long is a hang someone can still act on, whereas one that reads short can drop
        // a stall into a lower bucket, or under a consumer's alerting floor entirely.
        phases().forEach { phase ->
            val hang = replay(stallMs = 3_000, phaseMs = phase)
            assertNotNull(hang)
            assertTrue(
                "phase ${phase}ms reported ${hang!!.durationMs}ms for a 3000ms stall",
                hang.durationMs >= 3_000 && hang.durationMs <= 3_000 + poll,
            )
        }
    }

    @Test
    fun `reports the stall start as the last responsive instant`() {
        // startedAtMs lands on the wire as `hang_started_at`, so it has to be the stall's own
        // clock, not the watchdog's bookkeeping.
        val hang = replay(stallMs = 3_000, phaseMs = 0)
        assertNotNull(hang)
        assertEquals(hang!!.startedAtMs + hang.durationMs, bootMs + poll + 3_000)
    }

    // endregion

    // region What is NOT a hang

    @Test
    fun `reports nothing when the watchdog was reset mid-stall`() {
        // reset() is what the loop calls when the app is backgrounded or the SDK torn down. A
        // suspended app is not a hung one, and iOS's GCRumHangRules guards the same case.
        val detector = GcRumHangDetector(threshold)
        val hang = replay(
            stallMs = 6_000,
            phaseMs = 0,
            detector = detector,
            onObserve = { if (it.isStalling) it.reset() },
        )
        assertNull(hang)
    }

    @Test
    fun `abandons a stall rather than wedging when the clock moves backwards`() {
        // The watchdog feeds a monotonic clock (SystemClock.elapsedRealtime), so a beat that reads
        // BEFORE the stall start can only come from a misbehaving clock. That is not a recovery —
        // but it must not leave the detector stuck in a stall it can never close either, because
        // a wedged detector reports nothing again, ever.
        val detector = GcRumHangDetector(threshold)

        assertNull(detector.observe(nowMs = 20_000, lastBeatMs = 10_000))
        assertTrue(detector.isStalling)

        assertNull(detector.observe(nowMs = 20_500, lastBeatMs = 5_000))
        assertTrue("a backwards clock left the detector wedged in a stall", !detector.isStalling)
    }

    @Test
    fun `keeps waiting while the main thread is still stuck`() {
        val detector = GcRumHangDetector(threshold)

        assertNull(detector.observe(nowMs = 20_000, lastBeatMs = 10_000))
        assertNull(detector.observe(nowMs = 20_500, lastBeatMs = 10_000))
        assertNull(detector.observe(nowMs = 30_000, lastBeatMs = 10_000))
        assertTrue(detector.isStalling)
    }

    @Test
    fun `sees a second stall after reporting the first`() {
        // One detector serves the whole process, so a reported hang must leave it armed: the
        // stall is state that has to be cleared, not a cycle that starts afresh on its own.
        val detector = GcRumHangDetector(threshold)

        assertNull(detector.observe(nowMs = 20_000, lastBeatMs = 10_000))
        val first = detector.observe(nowMs = 20_500, lastBeatMs = 20_400)
        assertNotNull(first)
        assertTrue(!detector.isStalling)

        assertNull(detector.observe(nowMs = 30_000, lastBeatMs = 25_000))
        val second = detector.observe(nowMs = 30_500, lastBeatMs = 30_400)
        assertNotNull(second)
        assertEquals(5_400L, second!!.durationMs)
    }

    // endregion

    // region epoch conversion — the watchdog measures monotonically, reports in wall-clock

    @Test
    fun `converts a monotonic stall start to wall-clock epoch`() {
        // The watchdog measures elapsed time on SystemClock.elapsedRealtime() (immune to clock
        // changes), but `hang_started_at` on the wire is epoch. The stall start it produces is
        // therefore a small ms-since-boot value that must NOT reach the wire as-is — it has to be
        // back-computed against the current wall clock. Here the stall began 3s before now.
        val nowEpoch = 1_700_000_003_000L
        val epochStart = GcRumHangDetector.epochStartMs(
            monotonicStartMs = 7_000L,
            nowMonotonicMs = 10_000L,
            nowEpochMs = nowEpoch,
        )
        assertEquals(1_700_000_000_000L, epochStart)
        // And distinctly NOT the raw monotonic instant, which as an epoch would read as 1970.
        assertTrue(epochStart != 7_000L)
    }

    @Test
    fun `epoch conversion is independent of how much time passed since the stall ended`() {
        // Reporting can lag the stall by a poll interval; the epoch start must not drift with it,
        // because the offset (now - start) is read on the same monotonic clock as the start.
        val nowEpoch = 1_700_000_010_000L
        assertEquals(
            nowEpoch - 4_000L,
            GcRumHangDetector.epochStartMs(
                monotonicStartMs = 50_000L,
                nowMonotonicMs = 54_000L,
                nowEpochMs = nowEpoch,
            ),
        )
    }

    // endregion
}
