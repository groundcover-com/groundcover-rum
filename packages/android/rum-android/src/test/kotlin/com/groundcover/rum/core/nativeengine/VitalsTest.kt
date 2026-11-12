package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.events.FrameSegmentCapture
import com.groundcover.rum.core.events.FrameSegmentReason
import com.groundcover.rum.core.events.NavigationStartCapture
import com.groundcover.rum.core.events.ScreenCapture
import com.groundcover.rum.core.pipeline.CorePipeline
import com.groundcover.rum.core.pipeline.FakeNativeEngine
import com.groundcover.rum.core.pipeline.FakePlatform
import com.groundcover.rum.core.pipeline.HostLifecycle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Frame vitals from the native engine: the frame_segment payload (RN's vitals listener), the
// pipeline's segment path (as the Flutter SDK tests it), and the screen boundaries that close a
// segment under the screen it was drawn on. Robolectric for org.json.

private fun aSegment(
    total: Int = 10,
    screen: String = "Native",
    startMs: Long = 1_800_000_000_000L,
    endMs: Long = 1_800_000_005_000L
) = FrameSegmentCapture(
    startMs = startMs,
    endMs = endMs,
    total = total,
    slow = 2,
    frozen = 1,
    refreshRate = 60.0,
    delayMs = 26.6667,
    budgetMs = 16.6667,
    reason = FrameSegmentReason.NAVIGATION,
    screenName = screen,
    screenKey = "$screen-1"
)

/** The engine's `frame_segment` payload, as both engines write it. */
private fun aPayload(reason: String = "background"): MutableMap<String, Any?> = linkedMapOf(
    "segmentStartMs" to 1_800_000_000_000L,
    "segmentEndMs" to 1_800_000_005_000L,
    "total" to 300,
    "slow" to 4,
    "frozen" to 1,
    "refreshRate" to 60.0,
    "delayMs" to 41.5,
    "budgetMs" to 16.6667,
    "reason" to reason
)

private fun aVitalsConfig(enabledEvents: List<RumEventName>? = null) = GroundcoverConfig(
    apiKey = "k",
    dsn = "ingest.example",
    cluster = "c",
    environment = "e",
    appId = "a",
    options = GroundcoverOptions(
        enabledEvents = enabledEvents,
        transport = TransportOptions(batchSize = 0, compression = false)
    )
)

private class VitalsRun(
    val pipeline: CorePipeline,
    val platform: FakePlatform,
    val engine: FakeNativeEngine
) {
    val performance: List<Map<*, *>>
        get() = platform.requests.flatMap { it.events }
            .filter { it["type"] == "performance" }
            .mapNotNull { it["attributes"] as? Map<*, *> }

    /** The screen each shipped segment was stamped with. */
    val shippedScreens: List<Any?> get() = performance.map {
        (it["screen"] as? Map<*, *>)?.get("name")
    }
}

/** A pipeline past the presence gate, on a fake engine. */
private fun started(config: GroundcoverConfig = aVitalsConfig()): VitalsRun {
    val engine = FakeNativeEngine()
    val platform = FakePlatform().apply { this.engine = engine }
    val pipeline = CorePipeline(marks = InteractiveMarks())
    pipeline.start(config, platform.services)
    pipeline.presence()
    return VitalsRun(pipeline, platform, engine)
}

class FrameSegmentSignalTest {
    @Test
    fun `a payload is a segment on the screen it is given`() {
        val segment = frameSegmentOf(aPayload(), "Native", "Native-1")
        assertNotNull(segment)
        assertEquals(1_800_000_000_000L, segment!!.startMs)
        assertEquals(1_800_000_005_000L, segment.endMs)
        assertEquals(300, segment.total)
        assertEquals(4, segment.slow)
        assertEquals(1, segment.frozen)
        assertEquals(41.5, segment.delayMs, 0.0)
        assertEquals(FrameSegmentReason.BACKGROUND, segment.reason)
        assertEquals("Native", segment.screenName)
        assertEquals("Native-1", segment.screenKey)
    }

    @Test
    fun `one that breaks the contract is dropped, not repaired`() {
        val broken = mutableListOf<Map<String, Any?>>()
        for (key in listOf(
            "segmentStartMs",
            "segmentEndMs",
            "total",
            "slow",
            "frozen",
            "delayMs"
        )) {
            broken.add(aPayload().apply { remove(key) })
        }
        broken.add(aPayload(reason = "resize"))
        broken.add(aPayload().apply { put("delayMs", -1) })
        broken.add(aPayload().apply { put("segmentStartMs", "1800000000000") })
        for (payload in broken) assertNull("$payload", frameSegmentOf(payload, "a", ""))
    }
}

@RunWith(RobolectricTestRunner::class)
class FrameSegmentEventTest {
    @Test
    fun `a smooth segment's zero delay is a measurement, and a missing budget is no budget`() {
        val payload = aPayload().apply {
            put("delayMs", 0)
            remove("budgetMs")
        }
        val segment = frameSegmentOf(payload, "a", "")
        assertEquals(0.0, segment!!.delayMs, 0.0)
        val attributes = shapeFrameSegmentEvent(segment, "m").attributes
        assertFalse(attributes.containsKey("performance_frame_budget_ms"))
        assertEquals(0.0, attributes["performance_metric_value"])
    }
}

@RunWith(RobolectricTestRunner::class)
class FrameSegmentPipelineTest {
    @Test
    fun `ships one frames_delay_total per segment, at its end, under the screen it was drawn on`() {
        val run = started()
        run.pipeline.submit(ScreenCapture("Logs", "Logs-1"))
        run.pipeline.submit(aSegment())
        run.pipeline.flush()
        val event = run.platform.requests.flatMap {
            it.events
        }.single { it["type"] == "performance" }
        assertEquals(1_800_000_005_000_000_000L, (event["timestamp"] as Number).toLong())
        val attributes = event["attributes"] as Map<*, *>
        assertEquals(mapOf("name" to "Native", "key" to "Native-1"), attributes["screen"])
        assertEquals("frames_delay_total", attributes["performance_metric_name"])
        assertEquals(26.67, attributes["performance_metric_value"])
        assertTrue(attributes["performance_metric_id"] is String)
        assertEquals("", attributes["performance_metric_navigation_type"])
        assertEquals(60.0, (attributes["performance_refresh_rate_hz"] as Number).toDouble(), 0.0)
        assertEquals(16.67, attributes["performance_frame_budget_ms"])
        assertEquals("navigation", attributes["performance_segment_reason"])
        assertEquals(1_800_000_000_000_000_000L, (attributes["start_timestamp"] as Number).toLong())
        assertEquals(1_800_000_005_000_000_000L, (attributes["end_timestamp"] as Number).toLong())
        assertEquals(2, (attributes["performance_frames_slow"] as Number).toInt())
        assertEquals(1, (attributes["performance_frames_frozen"] as Number).toInt())
        // No count and no rate: platforms don't count the same frames.
        assertFalse(attributes.containsKey("performance_frames_total"))
    }

    @Test
    fun `drops an empty segment`() {
        val run = started()
        run.pipeline.submit(aSegment(total = 0))
        run.pipeline.flush()
        assertTrue(run.performance.isEmpty())
    }

    @Test
    fun `drops a segment that started before a session rotation`() {
        val run = started()
        run.platform.nowMs += 60_000
        run.pipeline.setSessionId("next")
        // A user is there, so the new session's batches can ship.
        run.pipeline.presence()
        // Started under the session that rotated away, and the pool stamps the session at send
        // time, so it would ship under the new one.
        run.pipeline.submit(aSegment())
        val now = run.platform.nowMs
        run.pipeline.submit(aSegment(screen = "Logs", startMs = now, endMs = now + 5_000))
        run.pipeline.flush()
        assertEquals(listOf("Logs"), run.shippedScreens)
    }

    @Test
    fun `keeps the first segment drawn wholly in the session after a rotation`() {
        val run = started()
        run.pipeline.submit(aSegment())
        // Away for longer than the inactivity gap, back to a new session.
        run.platform.nowMs += 40 * 60_000L
        run.pipeline.setSessionId("next")
        run.pipeline.presence()
        val now = run.platform.nowMs
        run.pipeline.submit(aSegment(screen = "Logs", startMs = now, endMs = now + 5_000))
        run.pipeline.flush()
        assertEquals(listOf("Native", "Logs"), run.shippedScreens)
    }

    @Test
    fun `drops a segment while the session is inactive`() {
        val run = started()
        // Past the 30-minute inactivity gap, with no new presence.
        run.platform.nowMs += 31 * 60_000L
        run.pipeline.submit(aSegment())
        run.pipeline.flush()
        assertTrue(run.performance.isEmpty())
    }

    @Test
    fun `keeps the first segment after a return that rotated the session`() {
        // The engine restarts its segment as the app returns; the session rotates a moment later,
        // when the return reaches the core thread. That segment holds only post-return frames.
        val run = started()
        run.pipeline.lifecycle(HostLifecycle.BACKGROUND)
        val leftAt = run.platform.nowMs
        run.platform.nowMs += 40 * 60_000L
        val restartedAt = run.platform.nowMs - 300
        run.pipeline.lifecycle(HostLifecycle.FOREGROUND)
        run.pipeline.submit(
            aSegment(screen = "Logs", startMs = restartedAt, endMs = run.platform.nowMs + 5_000)
        )
        // One that started before the app left measured the old session, and stays dropped.
        run.pipeline.submit(aSegment(startMs = leftAt - 1_000, endMs = leftAt))
        run.pipeline.flush()
        assertEquals(listOf("Logs"), run.shippedScreens)
    }

    @Test
    fun `enabledEvents without vitals sends none`() {
        val run = started(aVitalsConfig(enabledEvents = listOf(RumEventName.LOGS)))
        run.pipeline.submit(aSegment())
        run.pipeline.flush()
        assertTrue(run.platform.requests.isEmpty())
    }
}

@RunWith(RobolectricTestRunner::class)
class FrameSegmentBoundaryTest {
    @Test
    fun `a screen change closes the segment under the screen left, not the one arrived at`() {
        val run = started()
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        run.engine.openSegment = aPayload(reason = "navigation")
        run.pipeline.submit(ScreenCapture("Logs", "Logs-1"))
        run.pipeline.flush()
        assertEquals(1, run.engine.calls.count { it == "flushFrameSegment" })
        val attributes = run.performance.first()
        assertEquals(mapOf("name" to "Home", "key" to "Home-1"), attributes["screen"])
        assertEquals("navigation", attributes["performance_segment_reason"])
    }

    @Test
    fun `the first screen closes nothing, since the launch is its own`() {
        val run = started()
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        // The same screen again is no change either.
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        assertFalse(run.engine.calls.contains("flushFrameSegment"))
    }

    @Test
    fun `a manual navigation closes the segment too`() {
        val run = started()
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        run.engine.openSegment = aPayload(reason = "navigation")
        run.pipeline.submit(NavigationStartCapture("Checkout"))
        run.pipeline.flush()
        assertEquals(listOf("Home"), run.shippedScreens)
    }

    @Test
    fun `with vitals off, a screen change asks the engine for nothing`() {
        val run = started(aVitalsConfig(enabledEvents = listOf(RumEventName.NAVIGATION)))
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        run.pipeline.submit(ScreenCapture("Logs", "Logs-1"))
        assertFalse(run.engine.calls.contains("flushFrameSegment"))
    }

    @Test
    fun `the engine's background segment is sent at once, since the app may never run again`() {
        // It arrives a moment after the background flush; the batch timer may never fire.
        val engine = FakeNativeEngine()
        val platform = FakePlatform().apply { this.engine = engine }
        val pipeline = CorePipeline(marks = InteractiveMarks())
        pipeline.start(
            GroundcoverConfig(
                apiKey = "k",
                dsn = "ingest.example",
                cluster = "c",
                environment = "e",
                appId = "a",
                options = GroundcoverOptions(
                    transport = TransportOptions(
                        batchSize = 100,
                        batchTimeoutMs = 300_000L,
                        compression = false
                    )
                )
            ),
            platform.services
        )
        pipeline.presence()
        pipeline.submit(ScreenCapture("Native", "Native-1"))
        pipeline.lifecycle(HostLifecycle.BACKGROUND)
        val sentBefore = platform.requests.size
        engine.emit("frame_segment", aPayload())
        assertEquals(sentBefore + 1, platform.requests.size)
        val attributes = platform.requests.last().events.single()["attributes"] as Map<*, *>
        assertEquals("background", attributes["performance_segment_reason"])
    }

    @Test
    fun `a segment the engine closes itself takes the screen current now`() {
        val run = started()
        run.pipeline.submit(ScreenCapture("Native", "Native-1"))
        run.engine.emit("frame_segment", aPayload())
        run.pipeline.flush()
        val attributes = run.performance.first()
        assertEquals(mapOf("name" to "Native", "key" to "Native-1"), attributes["screen"])
        assertEquals("background", attributes["performance_segment_reason"])
    }
}
