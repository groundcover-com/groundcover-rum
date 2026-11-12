package com.groundcover.rum.core.events

import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.RumEvent
import com.groundcover.rum.core.common.RandomIdGenerator
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.privacy.REDACTED
import com.groundcover.rum.core.privacy.resolvePrivacy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Turning a capture into a wire event: the enricher's ids, timestamps and flattened attributes,
// the event as the wire and the hooks see it, and the custom, log and error shapers.

private const val T0 = 1_800_000_000_000L

private fun anEnricher(platformAttributes: (() -> Map<String, Any?>)? = null) =
    EventEnricher(RandomIdGenerator(), { T0 }, platformAttributes)

class EventEnricherTest {
    private val enricher = anEnricher { mapOf("screen" to mapOf("name" to "Home", "key" to "k1")) }

    @Test
    fun stampsIdsTheTimestampInNanosecondsAndAnEmptyParentSpanId() {
        val event = enricher.enrich(EnrichInput(type = "custom"))
        assertEquals(msToNs(T0), event.timestamp)
        assertNull(event.startTimestamp)
        assertEquals("", event.parentSpanId)
        assertEquals(32, event.id.length)
        assertEquals(16, event.spanId.length)
        assertTrue(event.traceId!!.startsWith("0".repeat(16)))
    }

    @Test
    fun aNetworkEventGetsStartAndEndTimestampsInstead() {
        val event = enricher.enrich(
            EnrichInput(type = "network", timestamp = 5, endTimestamp = 9, spanName = "GET /x")
        )
        assertNull(event.timestamp)
        assertEquals(5L, event.startTimestamp)
        assertEquals(9L, event.endTimestamp)
        assertEquals("GET /x", event.wireJson()["span_name"])
    }

    @Test
    fun keepsASuppliedTime0IncludedAndReplacesANegativeOne() {
        assertEquals(0L, enricher.enrich(EnrichInput(type = "log", timestamp = 0)).timestamp)
        assertEquals(
            msToNs(T0),
            enricher.enrich(EnrichInput(type = "log", timestamp = -1)).timestamp
        )
    }

    @Test
    fun keepsSuppliedSpanAndTraceIds() {
        val event = enricher.enrich(
            EnrichInput(type = "network", traceId = "b".repeat(32), spanId = "a".repeat(16))
        )
        assertEquals("a".repeat(16), event.spanId)
        assertEquals("b".repeat(32), event.traceId)
    }

    @Test
    fun platformAttributesWinOverAUserAttributeOfTheSameName() {
        val event = enricher.enrich(
            EnrichInput(type = "log", attributes = mapOf("screen" to "user"))
        )
        assertEquals(mapOf("name" to "Home", "key" to "k1"), event.attributes["screen"])
    }

    @Test
    fun aThrowingContributorYieldsNoPlatformAttributes() {
        val throwing = anEnricher { throw IllegalStateException("boom") }
        val event = throwing.enrich(EnrichInput(type = "log", attributes = mapOf("a" to 1)))
        assertEquals(mapOf("a" to 1), event.attributes)
    }
}

class FlattenAttributesTest {
    @Test
    fun dotFlattensMapsAndFlattensMapsInListsUnderKeyAndIndex() {
        val out = flattenAttributes(
            mapOf(
                "a" to mapOf("b" to 1, "c" to mapOf("d" to "x")),
                "frames" to listOf(mapOf("function" to "f"), 7)
            )
        )
        assertEquals(
            mapOf(
                "a.b" to 1,
                "a.c.d" to "x",
                "frames" to listOf(mapOf("frames[0].function" to "f"), 7)
            ),
            out
        )
    }

    @Test
    fun boundsDepthAndMarksACycle() {
        var deep: Map<String, Any?> = mapOf("leaf" to 1)
        repeat(12) { deep = mapOf("n" to deep) }
        assertTrue(flattenAttributes(deep).values.contains("[Depth Limit]"))
        val cyclic = mutableMapOf<String, Any?>("a" to 1)
        cyclic["self"] = cyclic
        assertEquals(mapOf("a" to 1, "self" to "[Circular]"), flattenAttributes(cyclic))
    }

    @Test
    fun marksAListThatContainsItselfWithoutWalkingItAgain() {
        val list = mutableListOf<Any?>()
        list.add(list)
        list.add(list)
        assertEquals(
            mapOf("a" to listOf("[Circular]", "[Circular]")),
            flattenAttributes(mapOf("a" to list))
        )
    }

    @Test
    fun makesEveryValueJsonSafe() {
        class Profile {
            override fun toString() = "profile #7"
        }
        val out = flattenAttributes(mapOf("nan" to Double.NaN, "when" to Profile(), "flag" to true))
        assertTrue(out.containsKey("nan"))
        assertNull(out["nan"])
        assertEquals("profile #7", out["when"])
        assertEquals(true, out["flag"])
        // Any collection is a list, as the transport writes one a hook put back.
        assertEquals(listOf("a"), flattenAttributes(mapOf("tags" to setOf("a")))["tags"])
    }
}

// Robolectric for org.json, which the copy goes through.
@RunWith(RobolectricTestRunner::class)
class RumEventWireTest {
    @Test
    fun theWireCarriesTimestampsOnlyWhenSetAndAlwaysTheIds() {
        val event = RumEvent(
            type = "network",
            id = "i",
            spanId = "s",
            parentSpanId = "",
            traceId = "t",
            startTimestamp = 5,
            endTimestamp = 9,
            spanName = "GET /x",
            attributes = mutableMapOf("a" to 1)
        )
        assertEquals(
            mapOf(
                "attributes" to mapOf("a" to 1),
                "end_timestamp" to 9L,
                "id" to "i",
                "parentSpanId" to "",
                "spanId" to "s",
                "span_name" to "GET /x",
                "start_timestamp" to 5L,
                "traceId" to "t",
                "type" to "network"
            ),
            event.wireJson()
        )
    }

    @Test
    fun aCopysAttributesAreItsOwnAllTheWayDown() {
        val original = RumEvent(
            type = "log",
            id = "i",
            spanId = "s",
            timestamp = 1,
            attributes = mutableMapOf("nested" to mutableMapOf("k" to "v"))
        )
        val copy = copyRumEvent(original)
        @Suppress("UNCHECKED_CAST")
        (copy.attributes["nested"] as MutableMap<String, Any?>)["k"] = "changed"
        copy.timestamp = 2
        assertEquals(mapOf("nested" to mapOf("k" to "v")), original.attributes)
        assertEquals(1L, original.timestamp)
        assertEquals(original.id, copy.id)
    }
}

class EventShaperTest {
    @Test
    fun aCustomEventIsSentAsGivenWithoutRedaction() {
        val input = shapeCustomEvent(
            CustomEventCapture("purchase", mapOf("password" to "x"), timestampNs = 7)
        )
        assertEquals("custom", input.type)
        assertEquals(7L, input.timestamp)
        assertEquals(
            mapOf(
                "custom_event_name" to "purchase",
                "custom_event_attributes" to mapOf("password" to "x")
            ),
            input.attributes
        )
    }

    @Test
    fun aLogStripsMessageLevelAndTheReservedKeysFromUserAttributes() {
        val input = shapeLogEvent(
            LogCapture(
                "hello",
                LogLevel.INFO,
                attributes = mapOf(
                    "message" to "spoofed",
                    "level" to "error",
                    "screen" to "spoofed",
                    "orderId" to 7
                )
            ),
            resolvePrivacy(null),
            reservedKeys = listOf("screen")
        )
        assertEquals("log", input.type)
        assertEquals(
            mapOf("orderId" to 7, "message" to "hello", "level" to "info"),
            input.attributes
        )
    }

    @Test
    fun aLogKeepsAUserKeyNoPlatformReserved() {
        val input = shapeLogEvent(
            LogCapture("hello", LogLevel.WARN, attributes = mapOf("location" to "warehouse-7")),
            resolvePrivacy(null)
        )
        assertEquals("warehouse-7", input.attributes["location"])
    }

    @Test
    fun aLogIsRedactedUnderTheLogPrivacyRules() {
        val input = shapeLogEvent(
            LogCapture(
                "login password=hunter2",
                LogLevel.ERROR,
                attributes = mapOf("token" to "t")
            ),
            resolvePrivacy(null)
        )
        assertEquals("login password=[REDACTED]", input.attributes["message"])
        assertEquals(REDACTED, input.attributes["token"])
    }

    @Test
    fun anExceptionIsShapedWithItsFingerprint() {
        val input = shapeErrorEvent(
            ErrorCapture(
                type = "PlaygroundError",
                message = "bad input",
                frames = listOf(ErrorFrame("App.kt", "run", 3, 0)),
                handled = true,
                metadata = mapOf("stage" to "test")
            ),
            resolvePrivacy(null)
        )
        assertEquals("exception", input.type)
        assertEquals(
            mapOf(
                "error_type" to "PlaygroundError",
                "error_message" to "bad input",
                "error_stacktrace" to listOf(
                    mapOf("filename" to "App.kt", "function" to "run", "lineno" to 3, "colno" to 0)
                ),
                "error_fingerprint" to "PlaygroundError:bad input",
                "error_handled" to true,
                "error_metadata" to mapOf("stage" to "test")
            ),
            input.attributes
        )
    }

    @Test
    fun handledDefaultsToFalseAndAnEmptyMessageAndTypeToTheirDefaults() {
        val input = shapeErrorEvent(ErrorCapture(type = "", message = ""), resolvePrivacy(null))
        assertEquals(false, input.attributes["error_handled"])
        assertEquals("Unknown error", input.attributes["error_message"])
        assertEquals("Error", input.attributes["error_type"])
        // The fingerprint uses the defaulted type, never an empty one.
        assertEquals("Error:Unknown error", input.attributes["error_fingerprint"])
        assertFalse(input.attributes.containsKey("error_metadata"))
    }

    @Test
    fun masksTheMessageAndMetadataAndFingerprintsTheRedactedMessage() {
        val input = shapeErrorEvent(
            ErrorCapture(
                type = "Error",
                message = "login failed password=hunter2",
                metadata = mapOf("tenant" to "acme")
            ),
            resolvePrivacy(PrivacyOptions(sensitiveKeys = listOf("tenant")))
        )
        assertEquals("login failed password=[REDACTED]", input.attributes["error_message"])
        assertEquals(
            "Error:login failed password=[REDACTED]",
            input.attributes["error_fingerprint"]
        )
        assertEquals(mapOf("tenant" to REDACTED), input.attributes["error_metadata"])
    }

    @Test
    fun leavesEverythingAsItIsUnderAllow() {
        val input = shapeErrorEvent(
            ErrorCapture(
                type = "Error",
                message = "login failed password=hunter2",
                metadata = mapOf("tenant" to "acme")
            ),
            resolvePrivacy(
                PrivacyOptions(level = PrivacyLevel.ALLOW, sensitiveKeys = listOf("tenant"))
            )
        )
        assertEquals("login failed password=hunter2", input.attributes["error_message"])
        assertEquals(mapOf("tenant" to "acme"), input.attributes["error_metadata"])
    }
}
