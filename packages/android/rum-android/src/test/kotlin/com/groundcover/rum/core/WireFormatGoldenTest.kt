package com.groundcover.rum.core

import com.groundcover.rum.BeforeSend
import com.groundcover.rum.EnrichEvent
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.RumUser
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.common.decodeJsonObject
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.events.CustomEventCapture
import com.groundcover.rum.core.events.ErrorCapture
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.LogLevel
import com.groundcover.rum.core.pipeline.CorePipeline
import com.groundcover.rum.core.pipeline.FakePlatform
import com.groundcover.rum.core.pipeline.SentRequest
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The Kotlin golden over packages/core/wire: one test per request file, plus the behaviour every
// golden repeats (that directory's README; the TS goldens hold the reference versions). It drives
// the pipeline directly: the fixtures pin what the core sends for a call, and
// PublicApiTest.everyPublicCallReachesTheWire checks that each public call gets there. Robolectric
// for org.json, which encodes each batch.

/** packages/core/wire, from the module directory Gradle runs tests in. */
private val wireDirectory = File("../../core/wire")

/** 2027-01-15T08:00:00Z, the clock every fixture is written against. */
private const val FIXTURE_CLOCK_MS = 1_800_000_000_000L

/** What only this platform sends, set aside before comparing. */
private val platformSessionKeys = setOf("app", "device", "os", "source", "sdk")
private val platformEventAttributes = setOf("screen", "error_stacktrace")

private val hex32 = Regex("^[0-9a-f]{32}$")
private val hex16 = Regex("^[0-9a-f]{16}$")
private val traceId = Regex("^0{16}[0-9a-f]{16}$")

private fun fixture(name: String): Map<String, Any?> {
    val file = File(wireDirectory, name)
    check(file.isFile) { "missing wire fixture ${file.absolutePath}" }
    return checkNotNull(decodeJsonObject(file.readText())) { "${file.path} is not a JSON object" }
}

private fun goldenConfig(options: GroundcoverOptions? = null): GroundcoverConfig {
    val config = fixture("config.json")
    val user = config["user"] as Map<*, *>
    val fixtureOptions = config["options"] as Map<*, *>
    val transport = fixtureOptions["transport"] as Map<*, *>
    return GroundcoverConfig(
        apiKey = config["apiKey"] as String,
        dsn = config["dsn"] as String,
        cluster = config["cluster"] as String,
        environment = config["environment"] as String,
        appId = config["appId"] as String,
        namespace = config["namespace"] as String,
        releaseId = config["releaseId"] as String,
        user = RumUser(id = user["id"] as String?, email = user["email"] as String?),
        options = options ?: GroundcoverOptions(
            debug = fixtureOptions["debug"] as Boolean,
            transport = TransportOptions(
                batchSize = (transport["batchSize"] as Number).toInt(),
                compression = transport["compression"] as Boolean
            )
        )
    )
}

private fun goldenOptions(
    sessionMaxDurationMs: Long? = null,
    sessionSampleRate: Double? = null,
    beforeSend: BeforeSend? = null,
    enrichEvent: EnrichEvent? = null
) = GroundcoverOptions(
    sessionSampleRate = sessionSampleRate,
    sessionMaxDurationMs = sessionMaxDurationMs,
    beforeSend = beforeSend,
    enrichEvent = enrichEvent,
    transport = TransportOptions(batchSize = 0, compression = false)
)

private fun startPipeline(options: GroundcoverOptions? = null): Pair<CorePipeline, FakePlatform> {
    val platform = FakePlatform(FIXTURE_CLOCK_MS)
    val pipeline = CorePipeline()
    pipeline.start(goldenConfig(options), platform.services)
    return pipeline to platform
}

private fun assertMatches(pattern: Regex, value: Any?) {
    assertTrue("$value should match $pattern", value is String && pattern.matches(value))
}

/** The request with its random ids checked and removed, and this platform's own keys set aside. */
private fun sharedRequest(request: SentRequest): Map<String, Any?> {
    val session = request.sessionAttributes
    assertMatches(hex32, session["session_id"])
    val events = request.events.map { event ->
        assertMatches(hex32, event["id"])
        assertMatches(hex16, event["spanId"])
        assertMatches(traceId, event["traceId"])
        val attributes = event["attributes"] as Map<*, *>
        event.filterKeys { it !in setOf("id", "spanId", "traceId") } +
            ("attributes" to attributes.filterKeys { it !in platformEventAttributes })
    }
    val body = request.batch +
        mapOf(
            "sessionAttributes" to session.filterKeys {
                it != "session_id" && it !in platformSessionKeys
            },
            "events" to events
        )
    return mapOf("url" to request.url, "headers" to request.headers, "body" to body)
}

/**
 * [value] as canonical text, numbers as doubles: near 1.8e18 a double steps in 256 ns, which is how
 * the TS cores hold these values, so a port holding exact 64-bit integers compares as they do. A
 * boolean stays a boolean.
 */
private fun canonical(value: Any?): String = when (value) {
    null -> "null"

    is Boolean -> value.toString()

    is Number -> value.toDouble().toString()

    is String -> encodeJson(value)

    is Map<*, *> -> value.keys.map { it.toString() }.sorted()
        .joinToString(",", "{", "}") { "${encodeJson(it)}:${canonical(value[it])}" }

    is List<*> -> value.joinToString(",", "[", "]") { canonical(it) }

    else -> value.toString()
}

private fun earliestEventTime(request: SentRequest): Long = request.events.minOf {
    ((it["timestamp"] ?: it["start_timestamp"]) as Number).toLong()
}

private fun customEventNames(platform: FakePlatform) = platform.requests.flatMap { request ->
    request.events.map { (it["attributes"] as Map<*, *>)["custom_event_name"] }
}

@RunWith(RobolectricTestRunner::class)
class WireFormatGoldenTest {
    private fun onlyRequest(send: (CorePipeline) -> Unit): Map<String, Any?> {
        val (pipeline, platform) = startPipeline()
        pipeline.presence()
        send(pipeline)
        assertEquals(1, platform.requests.size)
        return sharedRequest(platform.requests.single())
    }

    @Test
    fun customEventJson() {
        val sent = onlyRequest {
            it.submit(
                CustomEventCapture(
                    "purchase",
                    mapOf(
                        "amount" to 42,
                        "nested" to mapOf("sku" to "abc")
                    )
                )
            )
        }
        assertEquals(canonical(fixture("custom-event.json")), canonical(sent))
    }

    @Test
    fun logEventJson() {
        val sent = onlyRequest {
            it.submit(LogCapture("golden log line", LogLevel.WARN, mapOf("context" to "checkout")))
        }
        assertEquals(canonical(fixture("log-event.json")), canonical(sent))
    }

    @Test
    fun exceptionEventJson() {
        val sent = onlyRequest {
            it.submit(
                ErrorCapture(
                    type = "Error",
                    message = "golden failure",
                    handled = true,
                    metadata = mapOf("stage" to "test")
                )
            )
        }
        assertEquals(canonical(fixture("exception-event.json")), canonical(sent))
    }

    @Test
    fun doesNotTransmitAnythingBeforeGenuinePresence() {
        val (pipeline, platform) = startPipeline(goldenOptions())
        pipeline.submit(CustomEventCapture("pre-presence", emptyMap()))
        assertTrue(platform.requests.isEmpty())

        pipeline.presence()
        pipeline.submit(CustomEventCapture("post-presence", emptyMap()))
        assertTrue(customEventNames(platform).containsAll(listOf("pre-presence", "post-presence")))
    }

    @Test
    fun sendsNothingWhenSessionSampleRateIs0() {
        val (pipeline, platform) = startPipeline(goldenOptions(sessionSampleRate = 0.0))
        pipeline.presence()
        pipeline.submit(CustomEventCapture("e", emptyMap()))
        assertTrue(platform.requests.isEmpty())
    }

    @Test
    fun keepsSessionIdentityStableAcrossFlushesWithinASession() {
        val (pipeline, platform) = startPipeline(goldenOptions())
        pipeline.presence()
        pipeline.submit(CustomEventCapture("first", emptyMap()))
        pipeline.submit(CustomEventCapture("second", emptyMap()))
        assertTrue(platform.requests.size >= 2)
        val ids = platform.requests.map { it.sessionAttributes["session_id"] }.toSet()
        assertEquals(1, ids.size)
        assertEquals(pipeline.sessionId, ids.single())
    }

    @Test
    fun neverClaimsASessionStartedAfterAnEventInTheSameBatch() {
        val (pipeline, platform) = startPipeline(goldenOptions())
        pipeline.presence()
        pipeline.submit(CustomEventCapture("first", emptyMap()))
        pipeline.submit(CustomEventCapture("second", emptyMap()))
        assertTrue(platform.requests.isNotEmpty())
        for (request in platform.requests) {
            val start = (request.sessionAttributes["session_start_time"] as Number).toLong()
            assertTrue(start <= earliestEventTime(request))
        }
    }

    /**
     * Opens a session, crosses the cap with one event (with `during` set while that trigger goes
     * through the pipeline), then sends one more, and checks that no batch under the new session
     * claims a start later than an event it carries.
     */
    private fun rotateAcrossCap(options: (FakePlatform, () -> Boolean) -> GroundcoverOptions) {
        var during = false
        val platform = FakePlatform(FIXTURE_CLOCK_MS)
        val pipeline = CorePipeline()
        pipeline.start(goldenConfig(options(platform) { during }), platform.services)
        pipeline.presence()
        pipeline.submit(CustomEventCapture("before-cap", emptyMap()))
        val before = platform.requests.last().sessionAttributes["session_id"]

        platform.nowMs = FIXTURE_CLOCK_MS + 60_000 + 1000
        during = true
        pipeline.submit(CustomEventCapture("after-cap", emptyMap()))
        during = false

        pipeline.presence()
        pipeline.submit(CustomEventCapture("post-rotation", emptyMap()))

        val rotated = platform.requests.filter { it.sessionAttributes["session_id"] != before }
        assertTrue("the cap should have rotated the session", rotated.isNotEmpty())
        for (request in rotated) {
            val start = (request.sessionAttributes["session_start_time"] as Number).toLong()
            assertTrue(
                "the rotated session started after an event it carries",
                start <= earliestEventTime(request)
            )
        }
    }

    @Test
    fun aRotatedSessionNeverStartsAfterItsTriggerWhenTimePassesWhileItIsSent() {
        rotateAcrossCap { platform, during ->
            goldenOptions(
                sessionMaxDurationMs = 60_000,
                beforeSend = BeforeSend {
                    if (during()) platform.nowMs += 5
                    true
                }
            )
        }
    }

    @Test
    fun aRotatedSessionNeverStartsAfterAnEnrichEventBackdatedTrigger() {
        rotateAcrossCap { _, during ->
            goldenOptions(
                sessionMaxDurationMs = 60_000,
                enrichEvent = EnrichEvent { event ->
                    val timestamp = event.timestamp
                    if (during() && timestamp != null) event.timestamp = timestamp - 5 * 1_000_000
                    event
                }
            )
        }
    }
}
