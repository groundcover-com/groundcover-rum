package com.groundcover.rum.core.pipeline

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.GroundcoverOptionsUpdate
import com.groundcover.rum.RumEventName
import com.groundcover.rum.RumUser
import com.groundcover.rum.TracingOptions
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.UrlPattern
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.events.CustomEventCapture
import com.groundcover.rum.core.events.ErrorCapture
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.LogLevel
import com.groundcover.rum.core.events.NetworkCapture
import com.groundcover.rum.core.session.SessionKeys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The pipeline as a whole, beyond what the wire goldens pin: the enabledEvents gates, presence
// and the host lifecycle, session id control, the identity, network capture's questions, and
// stopping. Robolectric for org.json, which encodes each batch.

private fun aPipelineConfig(
    dsn: String = "ingest.example",
    sessionId: String? = null,
    options: GroundcoverOptions = GroundcoverOptions(
        transport = TransportOptions(batchSize = 0, compression = false)
    )
) = GroundcoverConfig(
    apiKey = "k",
    dsn = dsn,
    cluster = "c",
    environment = "e",
    appId = "a",
    sessionId = sessionId,
    options = options
)

private fun batching(batchSize: Int) =
    GroundcoverOptions(transport = TransportOptions(batchSize = batchSize, compression = false))

private fun started(
    config: GroundcoverConfig = aPipelineConfig(),
    diagnostics: RumDiagnostics = RumDiagnostics.shared
): Pair<CorePipeline, FakePlatform> {
    val platform = FakePlatform()
    val pipeline = CorePipeline(diagnostics = diagnostics)
    pipeline.start(config, platform.services)
    return pipeline to platform
}

private fun custom(name: String = "x") = CustomEventCapture(name, emptyMap())

@RunWith(RobolectricTestRunner::class)
class CorePipelineTest {
    @Test
    fun theSdksOwnUploadsAreNeverCapturedHoweverTheDsnIsWritten() {
        // Captured, each upload would fill the next batch with its own network event, and an idle
        // app would upload every batchTimeout for good. Capture may report the URL as given or
        // normalized (OkHttp's HttpUrl lowercases the host, drops a default port, resolves dots).
        val cases = listOf(
            Triple(
                "ingest.example",
                "https://ingest.example/json/rum",
                "https://ingest.example/json/rum"
            ),
            Triple(
                "Ingest.Example",
                "https://Ingest.Example/json/rum",
                "https://ingest.example/json/rum"
            ),
            Triple(
                "https://INGEST.example:443",
                "https://INGEST.example:443/json/rum",
                "https://ingest.example/json/rum"
            ),
            Triple(
                "https://ingest.example/a/../rum",
                "https://ingest.example/a/../rum/json/rum",
                "https://ingest.example/rum/json/rum"
            )
        )
        for ((dsn, asGiven, normalized) in cases) {
            val (pipeline, _) = started(aPipelineConfig(dsn = dsn))
            assertFalse(dsn, pipeline.capturesUrl(asGiven))
            assertFalse(dsn, pipeline.capturesUrl(normalized))
            assertTrue(pipeline.capturesUrl("https://api.example/orders"))
        }
    }

    @Test
    fun excludedUrlsAndADisabledNetworkSignalAreNotCaptured() {
        val (excluding, _) = started(
            aPipelineConfig(
                options = GroundcoverOptions(excludedUrls = listOf(UrlPattern.of("*/health")))
            )
        )
        assertFalse(excluding.capturesUrl("https://api.example/health"))
        assertTrue(excluding.capturesUrl("https://api.example/orders"))
        val (logsOnly, _) = started(
            aPipelineConfig(options = GroundcoverOptions(enabledEvents = listOf(RumEventName.LOGS)))
        )
        assertFalse(logsOnly.capturesUrl("https://api.example/orders"))
    }

    @Test
    fun traceHeadersAreOnlyForPropagationUrlsAndFreshEachCall() {
        val (pipeline, _) = started(
            aPipelineConfig(
                options = GroundcoverOptions(
                    tracing = TracingOptions(propagationUrls = listOf("https://api.example/*"))
                )
            )
        )
        assertTrue(pipeline.traceHeadersFor("https://other.example/x").isEmpty())
        val first = pipeline.traceHeadersFor("https://api.example/x")["traceparent"]
        val second = pipeline.traceHeadersFor("https://api.example/x")["traceparent"]
        assertTrue(first!!.startsWith("00-"))
        assertNotEquals(first, second)
    }

    @Test
    fun startsOnceASecondStartIsIgnored() {
        val (pipeline, platform) = started(aPipelineConfig(sessionId = "first"))
        pipeline.start(aPipelineConfig(sessionId = "second"), platform.services)
        assertEquals("first", pipeline.sessionId)
    }

    @Test
    fun doesNothingBeforeStart() {
        val pipeline = CorePipeline()
        pipeline.presence()
        pipeline.submit(custom())
        pipeline.lifecycle(HostLifecycle.BACKGROUND)
        pipeline.flush()
        pipeline.setSessionId("x")
        assertEquals("", pipeline.sessionId)
    }

    @Test
    fun enabledEventsGatesLogsAndExceptionsNeverCustomEvents() {
        val (pipeline, platform) = started(
            aPipelineConfig(
                options = GroundcoverOptions(
                    enabledEvents = listOf(RumEventName.INTERACTION),
                    transport = TransportOptions(batchSize = 0, compression = false)
                )
            )
        )
        pipeline.presence()
        pipeline.submit(LogCapture("m", LogLevel.INFO))
        pipeline.submit(ErrorCapture(type = "E", message = "m"))
        pipeline.submit(custom("c"))
        assertEquals(listOf("custom"), platform.types)
    }

    @Test
    fun logAttributesCannotShadowMessageLevelOrScreen() {
        val (pipeline, platform) = started()
        pipeline.presence()
        pipeline.submit(
            LogCapture(
                "real",
                LogLevel.WARN,
                attributes = mapOf(
                    "message" to "fake",
                    "level" to "fake",
                    "screen" to "fake",
                    "ok" to 1
                )
            )
        )
        // The screen is stamped on every event, empty before any navigation.
        assertEquals(
            mapOf(
                "message" to "real",
                "level" to "warn",
                "ok" to 1,
                "screen" to mapOf("name" to "", "key" to "")
            ),
            platform.requests.first().events.first()["attributes"]
        )
    }

    @Test
    fun nothingIsSentBeforePresenceAndPresenceShipsWhatWasHeld() {
        val (pipeline, platform) = started()
        pipeline.submit(custom("held"))
        pipeline.flush()
        assertTrue(platform.requests.isEmpty())
        pipeline.presence()
        pipeline.flush()
        assertEquals(listOf("custom"), platform.types)
    }

    @Test
    fun aBackgroundTransitionPersistsActivityAndSendsTheBuffer() {
        val (pipeline, platform) = started(aPipelineConfig(options = batching(100)))
        pipeline.presence()
        pipeline.submit(custom("held"))
        assertTrue(platform.requests.isEmpty())
        platform.nowMs += 1000
        pipeline.presence()
        pipeline.lifecycle(HostLifecycle.BACKGROUND)
        assertEquals(listOf("custom"), platform.types)
        assertEquals("${platform.nowMs}", platform.storage.values[SessionKeys.LAST_ACTIVITY])
    }

    @Test
    fun returningToTheForegroundCountsAsPresence() {
        val (pipeline, platform) = started()
        pipeline.submit(custom("held"))
        assertTrue(platform.requests.isEmpty())
        pipeline.lifecycle(HostLifecycle.FOREGROUND)
        pipeline.flush()
        assertEquals(listOf("custom"), platform.types)
    }

    @Test
    fun aRotationFlushesAConfirmedSessionsBufferUnderItsOldId() {
        val (pipeline, platform) = started(
            aPipelineConfig(
                options = GroundcoverOptions(
                    sessionMaxDurationMs = 60_000,
                    transport = TransportOptions(batchSize = 100, compression = false)
                )
            )
        )
        val first = pipeline.sessionId
        pipeline.presence()
        pipeline.submit(custom("before"))
        platform.nowMs += 60_000
        pipeline.submit(custom("after"))
        assertEquals(first, platform.requests.first().sessionAttributes["session_id"])
        assertNotEquals(first, pipeline.sessionId)
    }

    @Test
    fun setSessionIdSendsTheOldSessionThenStartsTheGivenId() {
        val (pipeline, platform) = started(aPipelineConfig(options = batching(100)))
        val before = pipeline.sessionId
        pipeline.presence()
        pipeline.submit(custom("old"))
        pipeline.setSessionId("fixed")
        assertEquals(before, platform.requests.first().sessionAttributes["session_id"])
        assertEquals("fixed", pipeline.sessionId)
        pipeline.setSessionId(null)
        assertEquals(32, pipeline.sessionId.length)
    }

    @Test
    fun anUnsampledSessionReportsNothingAndSaysSo() {
        val platform = FakePlatform()
        val pipeline = CorePipeline()
        assertEquals(
            PipelineStart.UNSAMPLED,
            pipeline.start(
                aPipelineConfig(options = GroundcoverOptions(sessionSampleRate = 0.0)),
                platform.services
            )
        )
        pipeline.presence()
        pipeline.submit(custom())
        pipeline.flush()
        assertTrue(platform.requests.isEmpty())
        assertEquals("", pipeline.sessionId)
    }

    @Test
    fun stopDropsTheBufferAndKeepsThePersistedSession() {
        val (pipeline, platform) = started(aPipelineConfig(options = batching(100)))
        val id = pipeline.sessionId
        pipeline.presence()
        pipeline.submit(custom())
        pipeline.stop()
        pipeline.flush()
        platform.executor.advance(60_000)
        assertTrue(platform.requests.isEmpty())
        assertEquals(id, platform.storage.values[SessionKeys.ID])
    }

    @Test
    fun identifyUserMergesAndUpdateConfigReachesTheEnvelope() {
        val (pipeline, platform) = started()
        pipeline.presence()
        pipeline.identifyUser(RumUser(id = "u1"))
        pipeline.identifyUser(RumUser(email = "a@b"))
        pipeline.updateConfig(GroundcoverConfigUpdate(environment = "prod"))
        pipeline.submit(custom())
        val attributes = platform.requests.first().sessionAttributes
        assertEquals(mapOf("id" to "u1", "email" to "a@b"), attributes["user"])
        assertEquals("prod", attributes["env"])
    }

    @Test
    fun updateConfigSwitchesTheDebugLog() {
        val diagnostics = RumDiagnostics(sink = {})
        val (pipeline, _) = started(diagnostics = diagnostics)
        assertFalse(diagnostics.isDebug)
        pipeline.updateConfig(
            GroundcoverConfigUpdate(options = GroundcoverOptionsUpdate(debug = true))
        )
        assertTrue(diagnostics.isDebug)
    }

    @Test
    fun aNetworkCaptureIsShapedAndSent() {
        val (pipeline, platform) = started()
        pipeline.presence()
        pipeline.submit(
            NetworkCapture(
                method = "GET",
                url = "https://api.example/orders?token=t",
                startMs = 1_800_000_000_000L,
                endMs = 1_800_000_000_100L,
                status = 200
            )
        )
        val event = platform.requests.first().events.first()
        assertEquals("network", event["type"])
        assertEquals("GET /orders", event["span_name"])
        assertEquals(
            "https://api.example/orders?token=%5BREDACTED%5D",
            (event["attributes"] as Map<*, *>)["url.full"]
        )
    }
}
