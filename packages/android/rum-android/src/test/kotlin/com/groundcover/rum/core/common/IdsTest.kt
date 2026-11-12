package com.groundcover.rum.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IdsTest {
    private val ids = RandomIdGenerator()
    private val hex = Regex("^[0-9a-f]+$")

    @Test
    fun idsAre32SpanIds16AndTraceIds32LowercaseHex() {
        val id = ids.generateId()
        val spanId = ids.generateSpanId()
        val traceId = ids.generateTraceId()
        assertTrue(id.length == 32 && hex.matches(id))
        assertTrue(spanId.length == 16 && hex.matches(spanId))
        assertTrue(traceId.length == 32 && hex.matches(traceId))
    }

    @Test
    fun everyHexDigitTurnsUpInEveryPosition() {
        val seen = List(32) { mutableSetOf<Char>() }
        repeat(2_000) {
            ids.generateId().forEachIndexed { position, digit -> seen[position].add(digit) }
        }
        assertTrue(seen.all { it.size == 16 })
    }

    @Test
    fun traceIdsKeepTheUpper64BitsZero() {
        repeat(20) { assertEquals("0".repeat(16), ids.generateTraceId().take(16)) }
    }

    @Test
    fun idsDoNotRepeat() {
        assertEquals(1_000, List(1_000) { ids.generateId() }.toSet().size)
        assertEquals(1_000, List(1_000) { ids.generateSpanId() }.toSet().size)
    }
}
