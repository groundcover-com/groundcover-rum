package com.groundcover.rum.core.common

import org.junit.Assert.assertEquals
import org.junit.Test

class TimeTest {
    @Test
    fun millisecondsAndNanosecondsConvertExactlyAs64BitIntegers() {
        assertEquals(1_800_000_000_000_000_000L, msToNs(1_800_000_000_000L))
        assertEquals(1_800_000_000_000L, nsToMs(1_800_000_000_000_000_000L))
        assertEquals(1_234_567_890_123L, nsToMs(msToNs(1_234_567_890_123L)))
    }

    @Test
    fun aFractionalMillisecondConvertsWithinANanosecond() {
        assertEquals(1_800_000_000_000_500_000L, fractionalMsToNs(1_800_000_000_000.5))
        assertEquals(1_800_000_000_000_000_000L, fractionalMsToNs(1_800_000_000_000.0))
    }
}
