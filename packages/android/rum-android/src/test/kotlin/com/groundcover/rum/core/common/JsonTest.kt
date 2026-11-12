package com.groundcover.rum.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// What the app hands the SDK unflattened (user properties, what a hook puts back) becomes plain
// JSON data once, so one odd value never costs a whole batch. Robolectric for org.json, which
// plain JVM tests only see as stubs.
@RunWith(RobolectricTestRunner::class)
class JsonTest {
    private class Profile {
        override fun toString() = "profile #7"
    }

    private fun roundTrip(value: Any?) = decodeJsonObject(encodeJson(value))

    @Test
    fun jsonScalarsMapsAndListsAreKeptAsTheyAre() {
        val value = mapOf(
            "s" to "x",
            "i" to 1,
            "d" to 1.5,
            "b" to true,
            "none" to null,
            "list" to listOf(1, "two")
        )
        assertEquals(value, roundTrip(value))
    }

    @Test
    fun nanosecondsAreWrittenAsExactIntegers() {
        assertTrue(
            encodeJson(mapOf("ns" to 1_800_000_000_000_000_001L))
                .contains("\"ns\":1800000000000000001")
        )
    }

    @Test
    fun aNonFiniteNumberIsNullAndAnythingElseItsStringForm() {
        val value = mapOf(
            "nan" to Double.NaN,
            "inf" to Double.POSITIVE_INFINITY,
            "profile" to Profile(),
            "chars" to charArrayOf('a')
        )
        assertEquals(
            mapOf("nan" to null, "inf" to null, "profile" to "profile #7", "chars" to listOf("a")),
            roundTrip(value)
        )
    }

    @Test
    fun aMapsKeysBecomeStrings() {
        assertEquals(mapOf("1" to "a"), roundTrip(mapOf(1 to "a")))
    }

    @Test
    fun aCollectionThatContainsItselfIsMarkedCircular() {
        val loop = mutableMapOf<String, Any?>("a" to 1)
        loop["self"] = loop
        val list = mutableListOf<Any?>(1)
        list.add(list)
        assertEquals(mapOf("a" to 1, "self" to "[Circular]"), toJsonData(loop))
        assertEquals(listOf(1, "[Circular]"), toJsonData(list))
    }

    @Test
    fun theSameCollectionTwiceSideBySideIsNotACycle() {
        val shared = mapOf("k" to 1)
        assertEquals(listOf(shared, shared), toJsonData(listOf(shared, shared)))
    }

    @Test
    fun nestingPast32LevelsIsCut() {
        var value: Any = mapOf("leaf" to true)
        repeat(40) { value = mapOf("n" to value) }
        var node = toJsonData(value) as Map<*, *>
        repeat(31) { node = node["n"] as Map<*, *> }
        assertEquals("[Depth Limit]", node["n"])
    }

    @Test
    fun toJsonMapMakesTheSameDataAsAMap() {
        val map = toJsonMap(mapOf("when" to Profile(), "nested" to mapOf("x" to Double.NaN)))
        assertEquals("profile #7", map["when"])
        assertEquals(mapOf("x" to null), map["nested"])
    }

    @Test
    fun decodeJsonObjectReadsAnObjectAndNothingElse() {
        assertEquals(mapOf("a" to 1), decodeJsonObject("{\"a\":1}"))
        assertNull(decodeJsonObject("[1]"))
        assertNull(decodeJsonObject("not json"))
    }
}
