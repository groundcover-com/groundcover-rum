package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.NativeOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.TtiMode
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.events.AppStartCapture
import com.groundcover.rum.core.events.AppStartMetric
import com.groundcover.rum.core.events.Capture
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.LogLevel
import com.groundcover.rum.core.events.NavigationStartCapture
import com.groundcover.rum.core.events.ScreenCapture
import com.groundcover.rum.core.pipeline.CorePipeline
import com.groundcover.rum.core.pipeline.FakeNativeEngine
import com.groundcover.rum.core.pipeline.FakePlatform
import com.groundcover.rum.core.pipeline.ManualExecutor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// App start and time to interactive: the engine's app_start signal, the tracker that holds launch
// metrics for the first screen and measures TTI from the cold start's origin (matching the RN and
// Flutter app-start tests), and the event. Robolectric for org.json.

private const val START_MS = 1_800_000_000_000.0

private fun aCold(after: Double = 850.0, type: String = "cold") =
    AppStartSignal(type, START_MS, START_MS + after)

/** A tracker on a manual executor, recording what it submits. */
private class TrackerHarness(manual: Boolean = false) {
    val executor = ManualExecutor()
    val marks = InteractiveMarks()
    val submitted = mutableListOf<Capture>()
    val tracker = AppStartTracker(
        submit = { submitted.add(it) },
        manualTti = manual,
        marks = marks,
        executor = executor,
        diagnostics = RumDiagnostics(sink = {})
    )

    val metrics: List<Triple<AppStartMetric, Long, String>>
        get() = submitted.filterIsInstance<AppStartCapture>()
            .map { Triple(it.metric, it.valueMs, it.navigationType) }

    /** The automatic mark, as the pipeline sets it on the first screen. */
    fun markAuto(ms: Double) {
        if (marks.markAuto(ms.toLong())) tracker.reportTtiIfReady()
    }
}

private fun anAppStartConfig(enabledEvents: List<RumEventName>? = null, tti: TtiMode? = null) =
    GroundcoverConfig(
        apiKey = "k",
        dsn = "ingest.example",
        cluster = "c",
        environment = "e",
        appId = "a",
        options = GroundcoverOptions(
            enabledEvents = enabledEvents,
            native = NativeOptions(tti = tti),
            transport = TransportOptions(batchSize = 0, compression = false)
        )
    )

private class AppStartRun(
    val pipeline: CorePipeline,
    val platform: FakePlatform,
    val engine: FakeNativeEngine
) {
    /** The engine's cold start, 2 s before now and drawn 850 ms after that. */
    fun emitColdStart() {
        engine.emit(
            "app_start",
            mapOf(
                "type" to "cold",
                "startMs" to platform.nowMs - 2_000,
                "firstFrameMs" to platform.nowMs - 1_150
            )
        )
    }

    /**
     * What [metric] was sent with, once the pipeline has flushed: a performance event never fills a
     * batch on its own.
     */
    fun attributes(metric: String): Map<*, *>? = platform.requests.flatMap { it.events }
        .mapNotNull { it["attributes"] as? Map<*, *> }
        .firstOrNull { it["performance_metric_name"] == metric }

    /** The value [metric] was sent with. */
    fun value(metric: String): Long? =
        (attributes(metric)?.get("performance_metric_value") as? Number)?.toLong()
}

/** A pipeline on a fake engine, with marks of its own. */
private fun started(
    config: GroundcoverConfig = anAppStartConfig(),
    marks: InteractiveMarks = InteractiveMarks()
): AppStartRun {
    val engine = FakeNativeEngine()
    val platform = FakePlatform().apply { this.engine = engine }
    val pipeline = CorePipeline(marks = marks)
    pipeline.start(config, platform.services)
    return AppStartRun(pipeline, platform, engine)
}

/** The screen an event was stamped with, as `name/key`. */
private fun screen(attributes: Map<*, *>?): String? {
    val screen = attributes?.get("screen") as? Map<*, *> ?: return null
    return "${screen["name"]}/${screen["key"]}"
}

class AppStartSignalTest {
    @Test
    fun `carries the type and the two anchors`() {
        val start = appStartOfSignal(
            mapOf("type" to "hot", "startMs" to START_MS, "firstFrameMs" to START_MS + 120)
        )
        assertEquals("hot", start?.type)
        assertEquals(120.0, start?.let { it.firstFrameMs - it.startMs })
    }

    @Test
    fun `one that breaks the contract is dropped`() {
        val payloads = listOf(
            mapOf("startMs" to START_MS, "firstFrameMs" to START_MS),
            mapOf("type" to "cold", "startMs" to "$START_MS", "firstFrameMs" to START_MS),
            mapOf("type" to "cold", "startMs" to START_MS),
            // Past what nanoseconds hold, or no time at all: TTI's conversion would overflow.
            mapOf("type" to "cold", "startMs" to -1e19, "firstFrameMs" to -1e19 + 850),
            mapOf("type" to "cold", "startMs" to 0, "firstFrameMs" to 850),
            mapOf("type" to "cold", "startMs" to START_MS, "firstFrameMs" to 1e17)
        )
        for (payload in payloads) assertNull("$payload", appStartOfSignal(payload))
    }
}

class AppStartTrackerTest {
    @Test
    fun `holds a launch metric for the screen it landed on`() {
        val harness = TrackerHarness()
        harness.tracker.onAppStart(aCold())
        assertTrue(harness.submitted.isEmpty())
        harness.tracker.screenKnown()
        assertEquals(listOf(Triple(AppStartMetric.COLD, 850L, "cold")), harness.metrics)
    }

    @Test
    fun `sends it anyway after 5 s when no screen lands`() {
        val harness = TrackerHarness()
        harness.tracker.onAppStart(aCold())
        harness.executor.advance(4_999)
        assertTrue(harness.submitted.isEmpty())
        harness.executor.advance(1)
        assertEquals(listOf(AppStartMetric.COLD), harness.metrics.map { it.first })
    }

    @Test
    fun `maps each start type onto its metric, and rejects one it does not know`() {
        val harness = TrackerHarness()
        harness.tracker.screenKnown()
        for (type in listOf("cold_prewarmed", "warm", "hot", "constructor")) {
            harness.tracker.onAppStart(aCold(type = type))
        }
        // The cold_prewarmed start anchors TTI, and no mark has landed.
        assertEquals(
            listOf(
                AppStartMetric.COLD to "cold_prewarmed",
                AppStartMetric.WARM to "warm",
                AppStartMetric.HOT to "hot"
            ),
            harness.metrics.map { it.first to it.third }
        )
    }

    @Test
    fun `drops a start whose first frame comes before it`() {
        val harness = TrackerHarness()
        harness.tracker.screenKnown()
        harness.tracker.onAppStart(aCold(after = -5.0))
        assertTrue(harness.submitted.isEmpty())
    }

    @Test
    fun `reports TTI once, from the cold start's origin, at the first screen`() {
        val harness = TrackerHarness()
        harness.tracker.onAppStart(aCold())
        harness.markAuto(START_MS + 2_400)
        harness.tracker.screenKnown()
        harness.markAuto(START_MS + 9_000) // set once: ignored
        assertEquals(
            listOf(
                Triple(AppStartMetric.COLD, 850L, "cold"),
                Triple(AppStartMetric.TTI, 2_400L, "cold")
            ),
            harness.metrics
        )
    }

    @Test
    fun `clamps TTI to the first frame, since interactive before visible is impossible`() {
        val harness = TrackerHarness()
        harness.tracker.screenKnown()
        harness.markAuto(START_MS + 100)
        harness.tracker.onAppStart(aCold())
        assertEquals(Triple(AppStartMetric.TTI, 850L, "cold"), harness.metrics.last())
    }

    @Test
    fun `a hot or warm start anchors no TTI`() {
        val harness = TrackerHarness()
        harness.tracker.screenKnown()
        harness.markAuto(START_MS + 2_000)
        harness.tracker.onAppStart(aCold(type = "hot"))
        harness.tracker.onAppStart(aCold(type = "warm"))
        assertTrue(harness.metrics.none { it.first == AppStartMetric.TTI })
    }

    @Test
    fun `in manual mode TTI waits for markAppInteractive, never the screen`() {
        val harness = TrackerHarness(manual = true)
        harness.tracker.screenKnown()
        harness.markAuto(START_MS + 2_000)
        harness.tracker.onAppStart(aCold())
        assertTrue(harness.metrics.none { it.first == AppStartMetric.TTI })
        harness.marks.markManual(START_MS.toLong() + 12_000)
        harness.tracker.reportTtiIfReady()
        assertEquals(Triple(AppStartMetric.TTI, 12_000L, "cold"), harness.metrics.last())
    }

    @Test
    fun `each mark is set once, and the reset clears both`() {
        val marks = InteractiveMarks()
        assertTrue(marks.markManual(1))
        assertFalse(marks.markManual(2))
        assertTrue(marks.markAuto(3))
        assertEquals(1L, marks.mark(manual = true))
        assertEquals(3L, marks.mark(manual = false))
        marks.reset()
        assertNull(marks.mark(manual = true))
        assertNull(marks.mark(manual = false))
    }
}

@RunWith(RobolectricTestRunner::class)
class AppStartPipelineTest {
    @Test
    fun `the event is a performance metric with a fresh id, under the appStart gate`() {
        val run = started()
        run.pipeline.presence()
        run.pipeline.submit(AppStartCapture(AppStartMetric.COLD, 850, "cold_prewarmed"))
        run.pipeline.flush()
        val event = run.platform.requests.flatMap { it.events }.single()
        assertEquals("performance", event["type"])
        val attributes = event["attributes"] as Map<*, *>
        assertEquals("app_start_cold", attributes["performance_metric_name"])
        assertEquals(850L, (attributes["performance_metric_value"] as Number).toLong())
        assertTrue((attributes["performance_metric_id"] as? String)?.isNotEmpty() == true)
        assertEquals("cold_prewarmed", attributes["performance_metric_navigation_type"])

        val off = started(anAppStartConfig(enabledEvents = listOf(RumEventName.LOGS)))
        off.pipeline.presence()
        off.pipeline.submit(AppStartCapture(AppStartMetric.COLD, 850, "cold"))
        off.pipeline.flush()
        assertTrue(off.platform.requests.isEmpty())
    }

    @Test
    fun `routes the engine's app start, released by the first screen, the automatic TTI mark`() {
        val run = started()
        run.pipeline.presence()
        run.emitColdStart()
        run.pipeline.flush()
        assertTrue(run.platform.requests.isEmpty())
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        run.pipeline.flush()
        assertEquals(850L, run.value("app_start_cold"))
        // Landing now, 2 s after the start.
        assertEquals(2_000L, run.value("app_start_tti"))
    }

    @Test
    fun `stamps the cold start and TTI it releases with the screen, by a screen or a navigation`() {
        val lands =
            listOf(ScreenCapture("Home", "Home-1"), NavigationStartCapture("Home", "Home-1"))
        for (land in lands) {
            val run = started()
            run.pipeline.presence()
            run.emitColdStart()
            run.pipeline.submit(land)
            run.pipeline.flush()
            for (metric in listOf("app_start_cold", "app_start_tti")) {
                assertEquals(metric, "Home/Home-1", screen(run.attributes(metric)))
            }
        }
    }

    @Test
    fun `with navigation events off, the screen still stamps events, and launch metrics wait`() {
        val run = started(
            anAppStartConfig(enabledEvents = listOf(RumEventName.LOGS, RumEventName.APP_START))
        )
        run.pipeline.presence()
        run.emitColdStart()
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        run.pipeline.submit(LogCapture("after landing", LogLevel.INFO))
        run.pipeline.flush()
        val events = run.platform.requests.flatMap { it.events }
        assertTrue(events.none { it["type"] == "navigation" })
        val screens = events.map { event ->
            val attributes = event["attributes"] as Map<*, *>
            "${event["type"]}:${attributes["performance_metric_name"] ?: ""}:${screen(attributes)}"
        }
        assertEquals(
            listOf(
                "performance:app_start_cold:Home/Home-1",
                "performance:app_start_tti:Home/Home-1",
                "log::Home/Home-1"
            ),
            screens
        )
    }

    @Test
    fun `in manual mode the app's mark releases TTI, and the screen doesn't`() {
        val marks = InteractiveMarks()
        val run = started(anAppStartConfig(tti = TtiMode.MANUAL), marks)
        run.pipeline.presence()
        run.emitColdStart()
        run.pipeline.submit(ScreenCapture("Home", "Home-1"))
        run.pipeline.flush()
        assertNotNull(run.attributes("app_start_cold"))
        assertNull(run.attributes("app_start_tti"))
        marks.markManual(run.platform.nowMs + 500)
        run.pipeline.interactiveMarked()
        run.pipeline.flush()
        assertEquals(2_500L, run.value("app_start_tti"))
    }
}
