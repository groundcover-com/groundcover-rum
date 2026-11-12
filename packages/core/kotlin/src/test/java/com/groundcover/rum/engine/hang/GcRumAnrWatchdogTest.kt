package com.groundcover.rum.engine.hang

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The watchdog's thread while the app is away. Nothing can stall then, so a paused watchdog must
 * cost nothing: parked on a monitor until it resumes, not waking every poll interval for as long as
 * an app that runs in the background (a foreground service) stays alive. The thread's state tells
 * the two apart: WAITING when parked, TIMED_WAITING in a sleep.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GcRumAnrWatchdogTest {

    private fun watchdogThread(): Thread {
        val deadline = System.currentTimeMillis() + 3_000
        while (System.currentTimeMillis() < deadline) {
            Thread.getAllStackTraces().keys
                .firstOrNull { it.name == "gc-rum-anr-watchdog" && it.isAlive }
                ?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("the watchdog thread never started")
    }

    private fun becomes(thread: Thread, state: Thread.State): Boolean {
        val deadline = System.currentTimeMillis() + 3_000
        while (System.currentTimeMillis() < deadline) {
            if (thread.state == state) return true
            Thread.sleep(10)
        }
        return false
    }

    @Test
    fun `a paused watchdog parks until it resumes`() {
        // A threshold no test reaches: Robolectric's main looper never answers the probe.
        val watchdog = GcRumAnrWatchdog(thresholdMs = 600_000, onHang = { _, _, _ -> })
        watchdog.setPaused(true)
        watchdog.start()
        val thread = watchdogThread()
        try {
            assertTrue("parked while paused", becomes(thread, Thread.State.WAITING))
            // Across more than one poll interval: still parked, never woken by a timer.
            repeat(15) {
                Thread.sleep(GcRumAnrWatchdog.POLL_INTERVAL_MS / 10)
                assertTrue("stays parked", thread.state == Thread.State.WAITING)
            }

            watchdog.setPaused(false)
            assertTrue("polls again once resumed", becomes(thread, Thread.State.TIMED_WAITING))
        } finally {
            watchdog.stop()
            thread.join(3_000)
        }
    }

    @Test
    fun `stopping a parked watchdog ends its thread`() {
        val watchdog = GcRumAnrWatchdog(thresholdMs = 600_000, onHang = { _, _, _ -> })
        watchdog.setPaused(true)
        watchdog.start()
        val thread = watchdogThread()
        assertTrue(becomes(thread, Thread.State.WAITING))

        watchdog.stop()
        thread.join(3_000)

        assertFalse(thread.isAlive)
    }
}
