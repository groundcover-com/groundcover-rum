package com.groundcover.rum.core.pipeline

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.crash.FakeCrashStore
import com.groundcover.rum.core.events.CustomEventCapture
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.LogLevel
import com.groundcover.rum.core.events.ScreenCapture
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The screen the pipeline stamps on every event and on the crash snapshot. Robolectric for
// org.json, which encodes each batch.

@RunWith(RobolectricTestRunner::class)
class ScreenStampTest {
    private fun started(
        options: GroundcoverOptions = GroundcoverOptions(
            transport = TransportOptions(batchSize = 0, compression = false)
        ),
        platform: FakePlatform = FakePlatform()
    ): Pair<CorePipeline, FakePlatform> {
        val pipeline = CorePipeline()
        pipeline.start(
            GroundcoverConfig(
                apiKey = "k",
                dsn = "ingest.example",
                cluster = "c",
                environment = "e",
                appId = "a",
                options = options
            ),
            platform.services
        )
        pipeline.presence()
        return pipeline to platform
    }

    @Test
    fun everyEventAfterAScreenCarriesItAndTheNavigationIsSent() {
        val (pipeline, platform) = started()
        pipeline.submit(ScreenCapture("Home", "Home-1"))
        pipeline.submit(CustomEventCapture("c", emptyMap()))
        val events = platform.requests.flatMap { it.events }
        assertEquals(listOf("navigation", "custom"), events.map { it["type"] })
        for (event in events) {
            assertEquals(
                mapOf("name" to "Home", "key" to "Home-1"),
                (event["attributes"] as Map<*, *>)["screen"]
            )
        }
    }

    @Test
    fun aNavigationMovesTheScreenEvenWithNavigationEventsOff() {
        val (pipeline, platform) = started(
            GroundcoverOptions(
                enabledEvents = listOf(RumEventName.LOGS),
                transport = TransportOptions(batchSize = 0, compression = false)
            )
        )
        pipeline.submit(ScreenCapture("Home", "Home-1"))
        pipeline.submit(LogCapture("m", LogLevel.INFO))
        assertEquals(listOf("log"), platform.types)
        assertEquals(
            mapOf("name" to "Home", "key" to "Home-1"),
            (platform.requests.first().events.first()["attributes"] as Map<*, *>)["screen"]
        )
    }

    @Test
    fun theCrashSnapshotCarriesTheScreen() {
        val (pipeline, _) = started(
            platform = FakePlatform().apply {
                crashStore = FakeCrashStore()
            }
        )
        pipeline.submit(ScreenCapture("Detail", "Detail-1"))
        val snapshot = pipeline.sessionSnapshot!!
        assertTrue(
            snapshot,
            snapshot.contains("\"screen\":{\"name\":\"Detail\",\"key\":\"Detail-1\"}")
        )
    }
}
