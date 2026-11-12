package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.events.ErrorFrame
import com.groundcover.rum.core.events.HangCapture
import com.groundcover.rum.core.events.HangKind
import com.groundcover.rum.core.pipeline.CorePipeline
import com.groundcover.rum.core.pipeline.FakeNativeEngine
import com.groundcover.rum.core.pipeline.FakePlatform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Hangs from the native engine: signal validation, the event (matching the RN and Flutter hang
// tests), and the pipeline that ships them. Robolectric for org.json.

private fun aHang(
    kind: HangKind = HangKind.ANR,
    startedAtMs: Double = 1_700_000_000_000.0,
    durationMs: Double = 5_210.0,
    frames: List<ErrorFrame> = emptyList()
) = HangCapture(kind, startedAtMs, durationMs, frames)

private val A_HANG_PAYLOAD: Map<String, Any?> =
    mapOf("kind" to "anr", "startedAtMs" to 1_700_000_000_000L, "durationMs" to 3_000L)

private fun hangOf(payload: Map<String, Any?>): HangCapture? =
    captureOfSignal("hang", payload) as? HangCapture

private fun shaped(hang: HangCapture): Map<String, Any?> = shapeHangEvent(hang).attributes

private fun aHangConfig(
    sampled: Boolean = true,
    enabledEvents: List<RumEventName>? = null,
    transport: TransportOptions = TransportOptions(batchSize = 0, compression = false)
) = GroundcoverConfig(
    apiKey = "k",
    dsn = "ingest.example",
    cluster = "c",
    environment = "e",
    appId = "a",
    options = GroundcoverOptions(
        enabledEvents = enabledEvents,
        sessionSampleRate = if (sampled) 1.0 else 0.0,
        transport = transport
    )
)

private class HangRun(val pipeline: CorePipeline, val platform: FakePlatform)

/** A pipeline past the presence gate, on a fake engine. */
private fun started(
    config: GroundcoverConfig = aHangConfig(),
    engine: FakeNativeEngine = FakeNativeEngine()
): HangRun {
    val platform = FakePlatform().apply { this.engine = engine }
    val pipeline = CorePipeline()
    pipeline.start(config, platform.services)
    pipeline.presence()
    return HangRun(pipeline, platform)
}

class HangSignalTest {
    @Test
    fun `a hang signal is a hang capture, with its stack`() {
        val hang = hangOf(
            mapOf(
                "kind" to "anr",
                "startedAtMs" to 1_700_000_000_000L,
                "durationMs" to 3_010L,
                "mainThreadStack" to listOf(
                    mapOf(
                        "filename" to "com.acme.Checkout",
                        "function" to "computeTotals",
                        "lineno" to 142,
                        "colno" to 0
                    )
                )
            )
        )
        assertEquals(HangKind.ANR, hang?.kind)
        assertEquals(3_010.0, hang?.durationMs)
        assertEquals(listOf("computeTotals"), hang?.frames?.map { it.function })
    }

    @Test
    fun `iOS's app hang carries no stack`() {
        val hang = hangOf(
            mapOf(
                "kind" to "app_hang",
                "startedAtMs" to 1_700_000_000_000.25,
                "durationMs" to 2_500.5
            )
        )
        assertEquals(HangKind.APP_HANG, hang?.kind)
        assertEquals(1_700_000_000_000.25, hang?.startedAtMs)
        assertTrue(hang?.frames?.isEmpty() == true)
    }

    @Test
    fun `a signal that breaks the contract is dropped, not repaired`() {
        val payloads = listOf(
            mapOf("kind" to "anr", "durationMs" to 3_000),
            mapOf("kind" to "anr", "startedAtMs" to "1700000000000", "durationMs" to 3_000),
            mapOf("kind" to "anr", "startedAtMs" to 1_700_000_000_000L, "durationMs" to null),
            mapOf("kind" to "anr", "startedAtMs" to 1_700_000_000_000L, "durationMs" to true),
            // Past what nanoseconds hold, or no time at all: placing it would overflow or lie.
            mapOf("kind" to "anr", "startedAtMs" to 1e17, "durationMs" to 3_000),
            mapOf("kind" to "anr", "startedAtMs" to 0, "durationMs" to 3_000)
        )
        for (payload in payloads) assertNull("$payload", captureOfSignal("hang", payload))
    }

    @Test
    fun `kinds with nothing to capture yield nothing`() {
        assertNull(captureOfSignal("ping", emptyMap()))
        assertNull(captureOfSignal("gesture", mapOf("kind" to "tap")))
    }
}

@RunWith(RobolectricTestRunner::class)
class HangEventTest {
    @Test
    fun `is an exception, the shape a crash or an error uses`() {
        val input = shapeHangEvent(aHang())
        assertEquals("exception", input.type)
        val attributes = input.attributes
        assertEquals("ANR", attributes["error_type"])
        assertEquals("Main thread blocked for 5210ms", attributes["error_message"])
        // Nobody handled it: the user watched a frozen app.
        assertEquals(false, attributes["error_handled"])
        assertEquals(
            mapOf(
                "native" to true,
                "hang_duration_ms" to 5_210L,
                "hang_started_at" to 1_700_000_000_000.0,
                "recovered" to true
            ),
            attributes["error_metadata"]
        )
    }

    @Test
    fun `is placed at the stall's onset, not when its recovery arrived`() {
        assertEquals(
            1_699_000_000_000_500_000L,
            shapeHangEvent(aHang(startedAtMs = 1_699_000_000_000.5)).timestamp
        )
    }

    @Test
    fun `uses each platform's own name for the stall`() {
        assertEquals("AppHang", shaped(aHang(kind = HangKind.APP_HANG))["error_type"])
    }

    @Test
    fun `fingerprints by duration bucket, so repeats group into one issue`() {
        assertEquals("ANR:5s", shaped(aHang(durationMs = 5_210.0))["error_fingerprint"])
        assertEquals("ANR:5s", shaped(aHang(durationMs = 5_940.0))["error_fingerprint"])
        assertEquals("ANR:<1s", shaped(aHang(durationMs = 700.0))["error_fingerprint"])
        assertEquals("ANR:30s+", shaped(aHang(durationMs = 120_000.0))["error_fingerprint"])
    }

    @Test
    fun `carries the main-thread stack when there is one`() {
        val frame = ErrorFrame("com.acme.Checkout", "computeTotals", 142, 0)
        assertEquals(
            """[{"filename":"com.acme.Checkout","function":"computeTotals","lineno":142,"colno":0}]""",
            encodeJson(shaped(aHang(frames = listOf(frame)))["error_stacktrace"])
        )
    }
}

@RunWith(RobolectricTestRunner::class)
class HangPipelineTest {
    @Test
    fun `sends a hang at once, whatever the batch settings, since a hang often precedes a kill`() {
        val started = started(
            aHangConfig(
                transport = TransportOptions(
                    batchSize = 100,
                    batchTimeoutMs = 300_000L,
                    compression = false
                )
            )
        )
        started.pipeline.submit(aHang())
        assertEquals(listOf("exception"), started.platform.types)
        val event = started.platform.requests.single().events.single()
        val attributes = event["attributes"] as Map<*, *>
        assertEquals("ANR", attributes["error_type"])
        assertEquals(true, attributes["error_metadata.recovered"])
    }

    @Test
    fun `drops hangs that enabledEvents leaves out`() {
        val started = started(aHangConfig(enabledEvents = listOf(RumEventName.LOGS)))
        started.pipeline.submit(aHang())
        started.pipeline.flush()
        assertTrue(started.platform.requests.isEmpty())
    }

    @Test
    fun `routes the engine's hangs, and nothing else`() {
        val engine = FakeNativeEngine()
        val started = started(engine = engine)
        var work = 0
        started.pipeline.onEngineWork = { work++ }
        engine.emit("hang", A_HANG_PAYLOAD)
        engine.emit("ping", emptyMap())
        engine.emit("hang", mapOf("kind" to "anr"))
        assertEquals(listOf("exception"), started.platform.types)
        // The runtime hears of the work, which can have rotated the session.
        assertEquals(1, work)
    }

    @Test
    fun `a session not sampled reports no hang`() {
        val engine = FakeNativeEngine()
        val started = started(aHangConfig(sampled = false), engine = engine)
        engine.emit("hang", A_HANG_PAYLOAD)
        assertTrue(started.platform.requests.isEmpty())
    }

    @Test
    fun `a stopped pipeline stops listening to the engine`() {
        val engine = FakeNativeEngine()
        val started = started(engine = engine)
        assertNotNull(engine.onSignal)
        started.pipeline.stop()
        assertNull(engine.onSignal)
    }
}
