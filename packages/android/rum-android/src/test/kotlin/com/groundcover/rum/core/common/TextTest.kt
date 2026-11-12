package com.groundcover.rum.core.common

import org.junit.Assert.assertEquals
import org.junit.Test

class TextTest {
    @Test
    fun truncateTurnsNullIntoEmptyAndStringifiesOtherValues() {
        assertEquals("", truncate(null))
        assertEquals("", truncate(""))
        assertEquals("0", truncate(0))
        assertEquals("false", truncate(false))
        assertEquals("123", truncate(12345, maxLength = 3))
    }

    @Test
    fun truncateKeepsTextWithinTheLimitAndCutsAndMarksTextBeyondIt() {
        assertEquals("abc", truncate("abc", maxLength = 3))
        assertEquals("abc", truncate("abcd", maxLength = 3))
        assertEquals("abc…", truncate("abcd", maxLength = 3, ellipsis = "…"))
        assertEquals("abc", truncate("abc", maxLength = 3, ellipsis = "…"))
        assertEquals(10_000, truncate("x".repeat(10_001)).length)
        assertEquals("", truncate("abc", maxLength = 0))
    }

    @Test
    fun truncateCountsUtf16UnitsAsTheOtherSdksDoAndNeverCutsACharacterInHalf() {
        // The emoji is two UTF-16 units: a cut after two units would land inside it.
        assertEquals("a😀", truncate("a😀b", maxLength = 3))
        assertEquals("a", truncate("a😀b", maxLength = 2))
    }

    @Test
    fun normalizeWhitespaceCollapsesRunsAndTrims() {
        assertEquals("a b", normalizeWhitespace("  a \n\t b  "))
        assertEquals("", normalizeWhitespace(null))
    }
}
