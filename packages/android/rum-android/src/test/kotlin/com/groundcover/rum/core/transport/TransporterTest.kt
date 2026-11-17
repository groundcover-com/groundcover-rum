package com.groundcover.rum.core.transport

import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.pipeline.FakePlatform
import com.groundcover.rum.core.pipeline.aConfig
import com.groundcover.rum.core.pipeline.gunzip
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The transporter: one POST per batch to {dsn}/json/rum, its headers, gzip, the debug log, and
// the verdict a delivery reports. Robolectric for org.json.

private fun aBatch() = Batch(
    sessionAttributes = mapOf("session_id" to "s"),
    events = listOf(mapOf("type" to "custom"))
)

private fun aTransporter(
    config: ConfigManager,
    platform: FakePlatform,
    diagnostics: RumDiagnostics = RumDiagnostics.shared
) = Transporter(config, platform.sender, platform.executor, diagnostics)

@RunWith(RobolectricTestRunner::class)
class TransporterTest {
    @Test
    fun postsJsonToTheEndpointWithTheApikeyHeader() {
        val platform = FakePlatform()
        aTransporter(aConfig(), platform).send(aBatch())
        val request = platform.requests.single()
        assertEquals("https://ingest.example/json/rum", request.url)
        assertEquals(
            mapOf("Content-Type" to "application/json", "apikey" to "k", "Content-Encoding" to ""),
            request.headers
        )
        assertEquals(
            mapOf(
                "sessionAttributes" to mapOf("session_id" to "s"),
                "events" to listOf(mapOf("type" to "custom"))
            ),
            request.batch
        )
    }

    @Test
    fun gzipsTheBodyWhenCompressionIsOn() {
        val platform = FakePlatform()
        aTransporter(aConfig(compression = true), platform).send(aBatch())
        val request = platform.requests.single()
        assertEquals("gzip", request.headers["Content-Encoding"])
        assertArrayEquals(byteArrayOf(0x1F, 0x8B.toByte()), request.body.copyOfRange(0, 2))
        assertEquals("custom", request.events.first()["type"])
    }

    @Test
    fun compressionIsOnByDefault() {
        val platform = FakePlatform()
        aTransporter(aConfig(compression = null), platform).send(aBatch())
        assertEquals("gzip", platform.requests.single().headers["Content-Encoding"])
    }

    @Test
    fun inDebugLogsTheBatchJson() {
        val lines = mutableListOf<String>()
        val diagnostics = RumDiagnostics(sink = { lines.add(it) })
        diagnostics.configure(debug = true)
        val platform = FakePlatform()
        aTransporter(
            aConfig(compression = true, debug = true),
            platform,
            diagnostics
        ).send(aBatch())
        assertEquals(1, platform.requests.size)
        assertTrue(
            lines.any {
                it.contains("Sending batch:") && it.contains("\"events\":[{\"type\":\"custom\"}]")
            }
        )
    }

    @Test
    fun sendsNothingWithoutAnApiKey() {
        val platform = FakePlatform()
        aTransporter(aConfig(apiKey = ""), platform).send(aBatch())
        assertTrue(platform.requests.isEmpty())
    }

    @Test
    fun sendsWhatJsonHasNoFormForAsJSONStringifyWould() {
        class Profile {
            override fun toString() = "profile #7"
        }
        val platform = FakePlatform()
        aTransporter(aConfig(), platform).send(
            Batch(
                sessionAttributes = mapOf(
                    "user" to mapOf(
                        "id" to "u",
                        "properties" to mapOf("since" to Profile(), 7 to "seven")
                    )
                ),
                events = listOf(
                    // What an enrichEvent or beforeSend hook can put back.
                    mapOf(
                        "type" to "custom",
                        "attributes" to mapOf(
                            "ratio" to Double.POSITIVE_INFINITY,
                            "kind" to Profile(),
                            "tags" to setOf("a")
                        )
                    )
                )
            )
        )
        assertEquals(
            mapOf(
                "sessionAttributes" to mapOf(
                    "user" to mapOf(
                        "id" to "u",
                        "properties" to mapOf("since" to "profile #7", "7" to "seven")
                    )
                ),
                "events" to listOf(
                    mapOf(
                        "type" to "custom",
                        "attributes" to mapOf(
                            "ratio" to null,
                            "kind" to "profile #7",
                            "tags" to listOf("a")
                        )
                    )
                )
            ),
            platform.requests.single().batch
        )
    }

    @Test
    fun aDeliveryReportsWhetherTheBatchLanded() {
        val verdicts = mutableListOf<Boolean>()
        val platform = FakePlatform()
        val transporter = aTransporter(aConfig(), platform)
        transporter.deliver(aBatch()) { verdicts.add(it) }
        platform.sender.delivers = false
        transporter.deliver(aBatch()) { verdicts.add(it) }
        aTransporter(aConfig(apiKey = ""), platform).deliver(aBatch()) { verdicts.add(it) }
        assertEquals(listOf(true, false, false), verdicts)
        assertEquals("nothing is sent without an API key", 2, platform.requests.size)
    }
}

class GzipTest {
    @Test
    fun roundTripsThroughGzip() {
        val text = "groundcover rum é 😀 ".repeat(500)
        val compressed = gzip(text.toByteArray(Charsets.UTF_8))!!
        assertTrue(compressed.size < text.toByteArray(Charsets.UTF_8).size)
        assertEquals(text, String(gunzip(compressed), Charsets.UTF_8))
    }

    @Test
    fun anEmptyBodyIsAValidGzipStream() {
        val compressed = gzip(ByteArray(0))!!
        assertEquals(0, gunzip(compressed).size)
        assertArrayEquals(byteArrayOf(0x1F, 0x8B.toByte()), compressed.copyOfRange(0, 2))
    }
}
