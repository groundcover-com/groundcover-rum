package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.NativeOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.decodeJsonObject
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.config.ResolvedOptions
import com.groundcover.rum.core.config.resolveHangThresholdMs
import com.groundcover.rum.core.config.resolveVitalsMaxSegmentMs
import com.groundcover.rum.core.crash.FakeCrashStore
import com.groundcover.rum.core.events.ScreenCapture
import com.groundcover.rum.core.pipeline.CorePipeline
import com.groundcover.rum.core.pipeline.FakeNativeEngine
import com.groundcover.rum.core.pipeline.FakePlatform
import com.groundcover.rum.core.pipeline.RumRuntime
import com.groundcover.rum.engine.GcRumEngineConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The native engine as the pipeline starts it: the option resolvers, the engine's config, and the
// start itself, for sampled and unsampled sessions. Robolectric for org.json.

private fun anEngineConfig(
    sampled: Boolean = true,
    enabledEvents: List<RumEventName>? = null,
    native: NativeOptions? = null
) = GroundcoverConfig(
    apiKey = "k",
    dsn = "ingest.example",
    cluster = "c",
    environment = "e",
    appId = "a",
    options = GroundcoverOptions(
        enabledEvents = enabledEvents,
        sessionSampleRate = if (sampled) 1.0 else 0.0,
        native = native,
        transport = TransportOptions(batchSize = 0, compression = false)
    )
)

private fun resolved(config: GroundcoverConfig = anEngineConfig()): ResolvedOptions =
    ConfigManager(config).config.options

private fun decode(json: String?): Map<String, Any?> = json?.let { decodeJsonObject(it) }.orEmpty()

private class Started(val pipeline: CorePipeline, val platform: FakePlatform)

private fun started(
    config: GroundcoverConfig = anEngineConfig(),
    engine: FakeNativeEngine = FakeNativeEngine(),
    store: FakeCrashStore? = null,
    diagnostics: RumDiagnostics = RumDiagnostics.shared
): Started {
    val platform = FakePlatform().apply {
        this.engine = engine
        crashStore = store
    }
    val pipeline = CorePipeline(diagnostics = diagnostics)
    pipeline.start(config, platform.services)
    return Started(pipeline, platform)
}

class NativeOptionsTest {
    @Test
    fun `the hang threshold defaults to five seconds, Android's own ANR bar`() {
        assertEquals(5_000L, resolveHangThresholdMs(null))
        assertEquals(1_500L, resolveHangThresholdMs(1_500L))
    }

    @Test
    fun `out of range falls back to the default rather than reaching the engine`() {
        assertEquals(5_000L, resolveHangThresholdMs(100L))
        assertEquals(5_000L, resolveHangThresholdMs(120_000L))
        assertEquals(60_000L, resolveVitalsMaxSegmentMs(null))
        assertEquals(2_000L, resolveVitalsMaxSegmentMs(2_000L))
        assertEquals(60_000L, resolveVitalsMaxSegmentMs(500L))
        assertEquals(60_000L, resolveVitalsMaxSegmentMs(360_000L))
    }
}

@RunWith(RobolectricTestRunner::class)
class EngineConfigTest {
    @Test
    fun `a recorded session arms crashes, hangs, app start and vitals, never gestures`() {
        val json = decode(engineConfigJson(resolved(), recording = true, snapshotJson = null))
        assertEquals(
            mapOf(
                "crashes" to true,
                "hangs" to true,
                "appStart" to true,
                "vitals" to true,
                "gestures" to false
            ),
            json["features"]
        )
        assertEquals(
            mapOf("hangThresholdMs" to 5_000L, "vitalsMaxSegmentMs" to 60_000L),
            (json["thresholds"] as Map<*, *>).mapValues { (it.value as Number).toLong() }
        )
        assertEquals(false, json["clearSnapshotAfterHarvest"])
    }

    @Test
    fun `an unsampled session still arms crashes, and clears the last run's envelope`() {
        val json = decode(engineConfigJson(resolved(), recording = false, snapshotJson = null))
        assertEquals(
            mapOf(
                "crashes" to true,
                "hangs" to false,
                "appStart" to false,
                "vitals" to false,
                "gestures" to false
            ),
            json["features"]
        )
        assertEquals(true, json["clearSnapshotAfterHarvest"])
        assertFalse(json.containsKey("snapshotJson"))
    }

    @Test
    fun `carries this session's snapshot, which the engine installs right after its harvest`() {
        val json = decode(
            engineConfigJson(resolved(), recording = true, snapshotJson = """{"session_id":"s1"}""")
        )
        assertEquals("""{"session_id":"s1"}""", json["snapshotJson"])
    }

    @Test
    fun `enabledEvents switches each feature off`() {
        val options = resolved(
            anEngineConfig(
                enabledEvents = listOf(RumEventName.HANGS),
                native = NativeOptions(hangThresholdMs = 1_000L)
            )
        )
        val json = decode(engineConfigJson(options, recording = true, snapshotJson = null))
        assertEquals(
            mapOf(
                "crashes" to false,
                "hangs" to true,
                "appStart" to false,
                "vitals" to false,
                "gestures" to false
            ),
            json["features"]
        )
        val thresholds = json["thresholds"] as Map<*, *>
        assertEquals(1_000L, (thresholds["hangThresholdMs"] as Number).toLong())
    }

    @Test
    fun `the engine reads the config as it is written`() {
        // The engine decodes its config on its own: a key spelt differently on either side is a
        // feature that silently never arms.
        val options = resolved(
            anEngineConfig(
                enabledEvents = listOf(RumEventName.CRASHES, RumEventName.VITALS),
                native = NativeOptions(hangThresholdMs = 1_000L, vitalsMaxSegmentMs = 5_000L)
            )
        )
        val config = GcRumEngineConfig.decode(
            engineConfigJson(options, recording = true, snapshotJson = """{"session_id":"s1"}""")
        )
        assertTrue(config.features.crashes)
        assertFalse(config.features.hangs)
        assertFalse(config.features.appStart)
        assertTrue(config.features.vitals)
        assertFalse(config.features.gestures)
        assertEquals(1_000L, config.thresholds.hangThresholdMs)
        assertEquals(5_000L, config.thresholds.vitalsMaxSegmentMs)
        assertEquals("""{"session_id":"s1"}""", config.snapshotJson)
        assertFalse(config.clearSnapshotAfterHarvest)
    }
}

@RunWith(RobolectricTestRunner::class)
class EngineStartTest {
    @Test
    fun `starts the engine once the pipeline has decided the session`() {
        val engine = FakeNativeEngine()
        val started = started(engine = engine, store = FakeCrashStore())
        assertEquals(listOf("start"), engine.calls)
        assertEquals(true, engine.features["hangs"])
        val snapshot = decode(engine.config["snapshotJson"] as? String)
        assertEquals(started.pipeline.sessionId, snapshot["session_id"])
    }

    @Test
    fun `starts the engine for a session not sampled too, crashes only`() {
        val engine = FakeNativeEngine()
        started(anEngineConfig(sampled = false), engine = engine)
        assertEquals(listOf("start"), engine.calls)
        assertEquals(true, engine.features["crashes"])
        assertEquals(false, engine.features["hangs"])
        assertEquals(true, engine.config["clearSnapshotAfterHarvest"])
    }

    @Test
    fun `drains once the engine has started, since its start is the harvest`() {
        val engine = FakeNativeEngine().apply { holdsStart = true }
        val store = FakeCrashStore()
        started(engine = engine, store = store)
        assertEquals(0, store.reads)
        engine.finishStart()
        assertEquals(1, store.reads)
    }

    @Test
    fun `drains for a session not sampled too`() {
        val store = FakeCrashStore()
        started(anEngineConfig(sampled = false), store = store)
        assertEquals(1, store.reads)
    }

    @Test
    fun `a stop before the engine replied drains nothing`() {
        val engine = FakeNativeEngine().apply { holdsStart = true }
        val store = FakeCrashStore()
        started(engine = engine, store = store).pipeline.stop()
        engine.finishStart()
        assertEquals(0, store.reads)
    }

    @Test
    fun `nothing of this run reaches the engine before its start replied`() {
        val engine = FakeNativeEngine().apply { holdsStart = true }
        val store = FakeCrashStore()
        val started = started(engine = engine, store = store)
        // A change while the engine is still starting waits for it too.
        started.pipeline.submit(ScreenCapture("Home", "Home-1"))
        assertTrue(store.snapshots.isEmpty())
        engine.finishStart()
        assertEquals(
            mapOf("name" to "Home", "key" to "Home-1"),
            decode(store.snapshots.last())["screen"]
        )
    }

    @Test
    fun `warns when crash capture was asked for and is unavailable`() {
        val lines = mutableListOf<String>()
        val engine = FakeNativeEngine().apply {
            status = NativeEngineStatus(crashesUnavailable = "another handler owns crashes")
        }
        started(engine = engine, diagnostics = RumDiagnostics(sink = { lines.add(it) }))
        val warnings = lines.filter { it.contains("native crash capture is unavailable") }
        assertEquals(1, warnings.size)
        assertTrue(warnings.single().contains("another handler owns crashes"))
    }

    @Test
    fun `doesn't warn for a session not sampled, which reports nothing anyway`() {
        val lines = mutableListOf<String>()
        val engine = FakeNativeEngine().apply {
            status = NativeEngineStatus(crashesUnavailable = "another handler owns crashes")
        }
        started(
            anEngineConfig(sampled = false),
            engine = engine,
            diagnostics = RumDiagnostics(sink = { lines.add(it) })
        )
        assertTrue(lines.none { it.contains("native crash capture is unavailable") })
    }

    @Test
    fun `stopping the pipeline stops the engine`() {
        for (sampled in listOf(true, false)) {
            val engine = FakeNativeEngine()
            started(anEngineConfig(sampled = sampled), engine = engine).pipeline.stop()
            assertEquals(listOf("start", "stop"), engine.calls)
        }
    }

    @Test
    fun `the testing reset stops the engine, and a start after it starts it afresh`() {
        val engine = FakeNativeEngine()
        val platform = FakePlatform().apply { this.engine = engine }
        val runtime = RumRuntime(makePlatform = { platform.services })
        runtime.start(anEngineConfig())
        runtime.reset()
        assertEquals(listOf("start", "stop"), engine.calls)
        runtime.start(anEngineConfig())
        assertEquals(listOf("start", "stop", "start"), engine.calls)
    }
}
