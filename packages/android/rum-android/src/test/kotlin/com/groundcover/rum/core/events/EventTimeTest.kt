package com.groundcover.rum.core.events

import com.groundcover.rum.core.session.anEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EventTimeTest {
    private val now = 1_800_000_000_000_000_000L
    private val window = 3600L * 1_000_000_000L

    @Test
    fun trustsOnlyTimesInsideTheWindowEndingNow() {
        assertTrue(isTrustedEventTime(now, now, window))
        assertTrue(isTrustedEventTime(now - window + 1, now, window))
        assertFalse(isTrustedEventTime(now - window, now, window))
        assertFalse(isTrustedEventTime(now + 1, now, window))
        assertFalse(isTrustedEventTime(0, now, window))
        assertFalse(isTrustedEventTime(null, now, window))
        // Milliseconds read as nanoseconds land in 1970.
        assertFalse(isTrustedEventTime(1_800_000_000_000L, now, window))
    }

    @Test
    fun theEarliestTrustedTimeReadsTimestampAndStartTimestamp() {
        val events = listOf(
            anEvent("x", timestamp = now - 10),
            anEvent("x", startTimestamp = now - 20),
            null,
            anEvent("x", timestamp = 5)
        )
        assertEquals(now - 20, earliestTrustedEventTime(events, now, window))
        assertNull(earliestTrustedEventTime(listOf(anEvent("x")), now, window))
    }
}
