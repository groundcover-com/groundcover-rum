package com.groundcover.rum.engine.hang

/**
 * The judgement half of the hang watchdog: given repeated observations of when the main thread last
 * answered a probe, decides when a stall has begun and what to report once it ends.
 *
 * Kept apart from [GcRumAnrWatchdog] for the same reason iOS keeps `GCRumHangRules` apart from
 * its watchdog — a thread and a Looper are not things a unit test can drive. Unlike iOS's, this one
 * holds STATE: a stall is a sequence of observations rather than a single verdict, so the sequence
 * is what has to be testable.
 *
 * **Why elapsed time.** Posting one token, sleeping the whole threshold and then asking whether
 * the token had run would make detection probabilistic — a stall would be visible only if the
 * token landed inside `[T, T + D - H)`, since a token posted later still runs within its own
 * window. Comparing ELAPSED time against the threshold makes detection certain for any stall
 * longer than `H + POLL`.
 *
 * **On accuracy.** A stall is timed from the last instant the main thread was KNOWN responsive,
 * which is at most one poll interval before it truly began, so durations over-report by up to that
 * much. That is deliberately the direction to err in: timing from a probe posted *inside* the
 * stall would under-report without bound, and a duration that reads short can drop a
 * hang into a lower duration bucket, or under a consumer's alerting floor entirely, whereas one
 * that reads slightly long is still a hang someone can act on. iOS bounds the same
 * error at its 100ms heartbeat rather than this 500ms poll — a difference worth knowing when
 * comparing durations across platforms, and far smaller than either platform's threshold.
 */
internal class GcRumHangDetector(private val thresholdMs: Long) {

    /** @param startedAtMs the last instant the main thread was known responsive. */
    data class Hang(val startedAtMs: Long, val durationMs: Long)

    /** Non-null exactly while a stall is being waited out. */
    private var stallStartedAtMs: Long? = null

    val isStalling: Boolean
        get() = stallStartedAtMs != null

    /**
     * Folds one observation in.
     *
     * @param nowMs the monitor's clock.
     * @param lastBeatMs when the main thread last ran the probe. It only advances when the main
     *   thread actually ran something, so it is both the liveness signal and the recovery signal.
     * @return the hang this observation completed, or null — which covers a healthy app, a stall
     *   still in progress, and a stall abandoned for one of the reasons below.
     */
    fun observe(nowMs: Long, lastBeatMs: Long): Hang? {
        val startedAtMs = stallStartedAtMs
        if (startedAtMs == null) {
            // Elapsed time, not a slept window: this is what makes detection certain.
            if (nowMs - lastBeatMs >= thresholdMs) stallStartedAtMs = lastBeatMs
            return null
        }

        // The heartbeat has to have MOVED to count as a recovery. Equal means the main thread has
        // still not run anything, so keep waiting — reporting on an unmoved beat would be a
        // duration of zero, which iOS's rules guard against too.
        if (lastBeatMs == startedAtMs) return null

        if (lastBeatMs < startedAtMs) {
            // The beat reads EARLIER than the stall start, which no recovery can produce. The
            // watchdog feeds a MONOTONIC clock (SystemClock.elapsedRealtime), which cannot run
            // backwards, so this is defense against a misbehaving clock: abandon the stall rather
            // than wait on a comparison that can no longer come true, since a wedged detector
            // reports nothing again, ever, which is a worse failure than the one lost hang.
            stallStartedAtMs = null
            return null
        }

        stallStartedAtMs = null
        return Hang(startedAtMs = startedAtMs, durationMs = lastBeatMs - startedAtMs)
    }

    /**
     * Drops any stall in progress without reporting it. Called when the app is backgrounded — a
     * suspended app is not a hung one — and on teardown, where the events pool may already be gone.
     */
    fun reset() {
        stallStartedAtMs = null
    }

    internal companion object {
        /**
         * Convert a MONOTONIC stall-start instant into a wall-clock epoch timestamp for the wire.
         *
         * The watchdog measures elapsed time with `SystemClock.elapsedRealtime()` so an NTP or
         * user clock change cannot be read as stall time (which would fabricate ANRs) — but
         * `hang_started_at` has to be an epoch timestamp the backend can place on a timeline. Given
         * one pair of clock reads taken together (`nowMonotonicMs`/`nowEpochMs`), back-compute the
         * epoch instant the stall began: subtract how long ago it was from the current wall clock.
         */
        fun epochStartMs(monotonicStartMs: Long, nowMonotonicMs: Long, nowEpochMs: Long): Long =
            nowEpochMs - (nowMonotonicMs - monotonicStartMs)
    }
}
