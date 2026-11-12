package com.groundcover.rum.core.common

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UserHookTest {
    @Test
    fun aHookIsRunningOnlyOnItsOwnThreadAndOnlyWhileItRuns() {
        assertFalse(UserHook.isRunning)
        val seenElsewhere = UserHook.run {
            assertTrue(UserHook.isRunning)
            var other = true
            val thread = Thread { other = UserHook.isRunning }
            thread.start()
            thread.join()
            other
        }
        assertFalse(seenElsewhere)
        assertFalse(UserHook.isRunning)
    }

    @Test
    fun aHookThatThrowsLeavesTheScope() {
        runCatching { UserHook.run { throw IllegalStateException("boom") } }
        assertFalse(UserHook.isRunning)
    }
}
