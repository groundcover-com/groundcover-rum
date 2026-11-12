package com.groundcover.rum.engine.appstart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which start a lifecycle sequence is. A native app opens Activities on top of each other and
 * recreates them on every rotation, and neither of those is a start anyone waited for: only a
 * return from the background (hot) or a UI the system tore down and rebuilt (warm) is.
 */
class GcRumAppStartStateTest {
    private val processStart = 1_700_000_000_000L

    /** A launched app: its first Activity created, started and drawn, the cold start reported. */
    private fun launched(): GcRumAppStartState = GcRumAppStartState().apply {
        processStartMs = processStart
        activityCreated(isFreshLaunch = true, nowMs = processStart + 200)
        activityStarted(processStart + 220)
        val cold = firstFrame(processStart + 850)
        assertEquals("cold", cold?.type)
        assertEquals(850L, cold?.let { it.firstFrameMs - it.startMs })
    }

    @Test
    fun `a return from the background is a hot start, measured from the return`() {
        val state = launched()
        state.activityStopped(isChangingConfigurations = false)
        state.activityStarted(processStart + 60_000)
        val hot = state.firstFrame(processStart + 60_120)
        assertEquals("hot", hot?.type)
        assertEquals(120L, hot?.let { it.firstFrameMs - it.startMs })
    }

    @Test
    fun `an Activity opened on top of a running one is navigation, not a warm start`() {
        val state = launched()
        state.activityCreated(isFreshLaunch = true, nowMs = processStart + 5_000)
        state.activityStarted(processStart + 5_020)
        state.activityStopped(isChangingConfigurations = false)
        assertNull(state.firstFrame(processStart + 5_300))
    }

    @Test
    fun `a rotation recreates the Activity without a warm or a hot start`() {
        val state = launched()
        state.activityStopped(isChangingConfigurations = true)
        state.activityCreated(isFreshLaunch = false, nowMs = processStart + 5_000)
        state.activityStarted(processStart + 5_020)
        assertNull(state.firstFrame(processStart + 5_300))
    }

    @Test
    fun `a UI the system tore down while away is a warm start when the user comes back`() {
        val state = launched()
        state.activityStopped(isChangingConfigurations = false)
        state.activityCreated(isFreshLaunch = false, nowMs = processStart + 90_000)
        state.activityStarted(processStart + 90_030)
        val warm = state.firstFrame(processStart + 90_400)
        assertEquals("warm", warm?.type)
        // Measured from the return to the foreground, as the hot start it replaces is.
        assertEquals(370L, warm?.let { it.firstFrameMs - it.startMs })
    }

    @Test
    fun `a return after a rotation earlier in the session is still a hot start`() {
        val state = launched()
        state.activityStopped(isChangingConfigurations = true)
        state.activityCreated(isFreshLaunch = false, nowMs = processStart + 5_000)
        state.activityStarted(processStart + 5_020)
        state.activityStopped(isChangingConfigurations = false)
        state.activityStarted(processStart + 60_000)
        assertEquals("hot", state.firstFrame(processStart + 60_100)?.type)
    }

    @Test
    fun `the launch's own start is not a hot start`() {
        val state = GcRumAppStartState().apply { processStartMs = processStart }
        state.activityCreated(isFreshLaunch = true, nowMs = processStart + 200)
        state.activityStarted(processStart + 220)
        assertEquals("cold", state.firstFrame(processStart + 850)?.type)
        assertNull(state.firstFrame(processStart + 900))
    }
}
