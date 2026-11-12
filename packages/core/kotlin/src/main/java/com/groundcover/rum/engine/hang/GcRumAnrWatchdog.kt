package com.groundcover.rum.engine.hang

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

/**
 * Detects main-thread stalls before the system kills the app for one, by heartbeat: a background
 * thread posts a probe to the main looper on a fixed cadence, and a busy main thread stops
 * answering. Nothing is scheduled ON the main thread beyond that probe, since a check that had to
 * run there could not run during the stall it detects.
 *
 * The cadence is the point. One probe and a sleep of the WHOLE threshold before asking whether
 * it had run would make detection probabilistic — see [GcRumHangDetector], which owns that
 * judgement. This type is the plumbing: a thread, a looper, a stack capture.
 *
 * Stalls the process does not survive come post-mortem via ApplicationExitInfo; this reports the
 * recoverable ones, which the system records nowhere.
 */
internal class GcRumAnrWatchdog(
    private val thresholdMs: Long,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
    private val mainThread: Thread = Looper.getMainLooper().thread,
    private val onHang: (startedAtMs: Long, durationMs: Long, stack: JSONArray) -> Unit,
) {
    @Volatile
    private var running = false

    @Volatile
    private var paused = false

    /**
     * When the main thread last ran [probe], on the MONOTONIC clock
     * ([SystemClock.elapsedRealtime]) — the liveness signal AND the recovery signal. Monotonic on
     * purpose: an NTP sync or a user clock change must not be read as elapsed stall time, or a
     * responsive app would report a fabricated ANR the size of the clock jump.
     */
    @Volatile
    private var lastBeatMs = 0L

    /**
     * Whether a probe is outstanding. Only one is ever in flight: re-posting every cycle would
     * queue one probe per poll for the length of a stall, and they would all run on recovery.
     */
    private val probePending = AtomicBoolean(false)

    private var thread: Thread? = null

    private val probe = Runnable {
        lastBeatMs = SystemClock.elapsedRealtime()
        probePending.set(false)
    }

    fun start() {
        if (running) return
        running = true

        val thread = Thread({ loop() }, "gc-rum-anr-watchdog").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
        }
        this.thread = thread
        thread.start()
    }

    fun stop() {
        running = false
        synchronized(parking) { parking.notifyAll() }
        thread?.interrupt()
        thread = null
    }

    /** A backgrounded app is idle, not hung. */
    fun setPaused(value: Boolean) {
        // Refresh the heartbeat as the app comes BACK, before clearing the flag. Time spent in the
        // background is not a stall, and a stale beat would make the first observation after a
        // resume read as a hang lasting as long as the app was away. iOS beats on
        // willEnterForeground for the same reason.
        if (!value) lastBeatMs = SystemClock.elapsedRealtime()
        paused = value
        if (!value) synchronized(parking) { parking.notifyAll() }
    }

    /**
     * What a paused watchdog waits on. Nothing can stall while the app is away, so it parks until
     * [setPaused] resumes it or [stop] ends it, rather than waking every poll interval for as long
     * as an app that runs in the background stays alive. No wakeup is lost: the flag is checked
     * and the wait entered under this monitor, which both notifiers take after writing their flag.
     */
    private val parking = Object()

    private fun park() {
        synchronized(parking) {
            while (paused && running) {
                try {
                    parking.wait()
                } catch (_: InterruptedException) {
                    // Interrupted by stop(); fall out of the loop on the next check.
                    Thread.currentThread().interrupt()
                    running = false
                    return
                }
            }
        }
    }

    private fun loop() {
        // Stamp the clock before the first probe, so the opening window is not charged to a main
        // thread nobody has asked anything of yet.
        lastBeatMs = SystemClock.elapsedRealtime()
        val detector = GcRumHangDetector(thresholdMs)
        // Captured at the moment the stall is first SEEN and held until it is reported.
        var stack: JSONArray? = null

        while (running) {
            if (paused) {
                detector.reset()
                stack = null
                park()
                continue
            }

            if (probePending.compareAndSet(false, true)) {
                if (!mainHandler.post(probe)) {
                    // The looper is gone (app tearing down) — nothing to watch.
                    return
                }
            }

            sleep(POLL_INTERVAL_MS)
            if (!running) return
            // Re-checked after the sleep: a background transition during it must not be charged as
            // a stall, and the detector's own state has to go with it.
            if (paused) {
                detector.reset()
                stack = null
                continue
            }

            val hang = detector.observe(nowMs = SystemClock.elapsedRealtime(), lastBeatMs = lastBeatMs)

            if (hang != null) {
                // Only stalls the app RECOVERED from reach here; one it never returns from kills
                // the process, and ApplicationExitInfo carries that story instead.
                //
                // The stall was measured on the monotonic clock, but `hang_started_at` on the wire
                // is a wall-clock epoch. Read both clocks once, together, and back-compute the
                // epoch instant the stall began. `durationMs` is a monotonic delta and needs no
                // conversion.
                val startedAtEpochMs = GcRumHangDetector.epochStartMs(
                    monotonicStartMs = hang.startedAtMs,
                    nowMonotonicMs = SystemClock.elapsedRealtime(),
                    nowEpochMs = System.currentTimeMillis(),
                )
                onHang(startedAtEpochMs, hang.durationMs, stack ?: JSONArray())
                stack = null
            } else if (detector.isStalling) {
                // Capture the main thread's stack the first time the stall is seen, while it is
                // still stuck — after recovery it shows whatever the app moved on to, which is
                // exactly the wrong frame to report.
                if (stack == null) stack = captureMainThreadStack()
            } else {
                stack = null
            }
        }
    }

    private fun captureMainThreadStack(): JSONArray {
        val frames = JSONArray()
        runCatching {
            mainThread.stackTrace.take(MAX_FRAMES).forEach { element ->
                frames.put(
                    JSONObject()
                        .put("filename", element.className)
                        .put("function", element.methodName)
                        .put("lineno", element.lineNumber.coerceAtLeast(0))
                        .put("colno", 0)
                )
            }
        }
        return frames
    }

    private fun sleep(ms: Long) {
        runCatching { Thread.sleep(ms) }.onFailure {
            // Interrupted by stop(); fall out of the loop on the next check.
            Thread.currentThread().interrupt()
            running = false
        }
    }

    internal companion object {
        /**
         * How often the main thread is asked whether it is alive. Also the granularity of both
         * detection and the reported duration, so it is the bound on the accuracy [GcRumHangDetector]
         * documents: detection is certain for any stall longer than `thresholdMs + POLL_INTERVAL_MS`.
         */
        const val POLL_INTERVAL_MS = 500L
        const val MAX_FRAMES = 100
    }
}
