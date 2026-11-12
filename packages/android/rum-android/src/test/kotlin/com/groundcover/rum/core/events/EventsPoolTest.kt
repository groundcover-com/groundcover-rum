package com.groundcover.rum.core.events

import com.groundcover.rum.BeforeSend
import com.groundcover.rum.EnrichEvent
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.RumEvent
import com.groundcover.rum.RumUser
import com.groundcover.rum.core.common.RandomIdGenerator
import com.groundcover.rum.core.common.SafeStorage
import com.groundcover.rum.core.common.UserHook
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.pipeline.FakePlatform
import com.groundcover.rum.core.pipeline.aConfig
import com.groundcover.rum.core.session.SessionState
import com.groundcover.rum.core.transport.Transporter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The events pool: batching on size, on a timer and on demand; the hooks; the send gate and the
// cluster that hold a buffer, and the bound on what they hold; the batch envelope. Robolectric for
// org.json, which encodes each batch.

private const val T0 = 1_800_000_000_000L

private class PoolHarness(
    val config: ConfigManager,
    skip: Set<String> = emptySet(),
    device: (() -> Map<String, Any?>)? = null
) {
    val platform = FakePlatform(T0)
    val session = SessionState(SafeStorage(platform.storage)).apply {
        sessionId = "s1"
        setSessionStartTime(msToNs(T0))
    }
    val pool = EventsPool(
        config = config,
        session = session,
        transporter = Transporter(config, platform.sender, platform.executor),
        deviceAttributes = device ?: { mapOf("source" to "mobile-rum") },
        eventsToSkipFlush = skip,
        executor = platform.executor
    ).apply { initialize() }
    val enricher = EventEnricher(RandomIdGenerator(), { T0 })

    fun event(type: String, attributes: Map<String, Any?> = emptyMap()): RumEvent =
        enricher.enrich(EnrichInput(type = type, attributes = attributes))
}

@RunWith(RobolectricTestRunner::class)
class EventsPoolTest {
    @Test
    fun flushesOnceTheBatchSizeIsReached() {
        val h = PoolHarness(aConfig(batchSize = 2))
        h.pool.addEvent(h.event("custom"))
        assertTrue(h.platform.requests.isEmpty())
        h.pool.addEvent(h.event("custom"))
        assertEquals(1, h.platform.requests.size)
        assertEquals(2, h.platform.requests.first().events.size)
    }

    @Test
    fun anExplicitBatchSizeOf0SendsEveryEventAndANegativeOneIsIgnored() {
        val zero = PoolHarness(aConfig(batchSize = 0))
        zero.pool.addEvent(zero.event("custom"))
        assertEquals(1, zero.platform.requests.size)

        val negative = PoolHarness(aConfig(batchSize = -1))
        negative.pool.addEvent(negative.event("custom"))
        assertTrue("falls back to 10", negative.platform.requests.isEmpty())
    }

    @Test
    fun skipFlushTypesRideAlongWithTheNextFlushingEvent() {
        val h = PoolHarness(aConfig(batchSize = 1), skip = setOf("interaction"))
        h.pool.addEvent(h.event("interaction"))
        assertTrue(h.platform.requests.isEmpty())
        h.pool.addEvent(h.event("custom"))
        assertEquals(listOf("interaction", "custom"), h.platform.types)
    }

    @Test
    fun theTimerFlushesAnEventThatArrivesAfterAnEmptyWindow() {
        val h = PoolHarness(aConfig(batchTimeoutMs = 2000))
        h.platform.executor.advance(2000)
        h.pool.addEvent(h.event("custom"))
        h.platform.executor.advance(2000)
        assertEquals(1, h.platform.requests.size)
    }

    // A timer with nothing to send would wake the core thread every batch timeout for the life of
    // the process, in the background too: it runs only while something waits to be sent.
    @Test
    fun theTimerRunsOnlyWhileSomethingIsBuffered() {
        val h = PoolHarness(aConfig(batchTimeoutMs = 2000))
        assertEquals(0, h.platform.executor.pendingCount)
        h.pool.addEvent(h.event("custom"))
        assertEquals(1, h.platform.executor.pendingCount)
        h.platform.executor.advance(2000)
        assertEquals(1, h.platform.requests.size)
        assertEquals(0, h.platform.executor.pendingCount)
        h.pool.flush()
        assertEquals(0, h.platform.executor.pendingCount)
    }

    @Test
    fun aZeroBatchTimeoutFallsBackToThe10SecondDefault() {
        val h = PoolHarness(aConfig(batchTimeoutMs = 0))
        h.pool.addEvent(h.event("custom"))
        h.platform.executor.advance(9000)
        assertTrue(h.platform.requests.isEmpty())
        h.platform.executor.advance(1000)
        assertEquals(1, h.platform.requests.size)
    }

    @Test
    fun holdsTheBufferWithoutAClusterAndSendsOnceOneIsSet() {
        val h = PoolHarness(aConfig(cluster = ""))
        h.pool.addEvent(h.event("custom"))
        h.pool.flush()
        assertTrue(h.platform.requests.isEmpty())
        h.config.update(GroundcoverConfigUpdate(cluster = "later"))
        h.pool.flush()
        assertEquals("later", h.platform.requests.first().sessionAttributes["cluster"])
    }

    @Test
    fun whileGatedHoldsUpTo500EventsAndDropsTheNewest() {
        val h = PoolHarness(aConfig())
        h.pool.setFlushGate { false }
        for (index in 0 until MAX_GATED_BUFFER_EVENTS + 5) {
            h.pool.addEvent(h.event("custom", mapOf("i" to index)))
        }
        h.pool.setFlushGate(null)
        h.pool.flush()
        val sent = h.platform.requests.first().events
        assertEquals(MAX_GATED_BUFFER_EVENTS, sent.size)
        assertEquals(MAX_GATED_BUFFER_EVENTS - 1, (sent.last()["attributes"] as Map<*, *>)["i"])
    }

    @Test
    fun withoutAClusterHoldsUpTo500EventsAndDropsTheNewest() {
        // A missing cluster must not let the buffer grow without bound.
        val h = PoolHarness(aConfig(cluster = ""))
        for (index in 0 until MAX_GATED_BUFFER_EVENTS + 5) {
            h.pool.addEvent(h.event("custom", mapOf("i" to index)))
        }
        assertTrue(h.platform.requests.isEmpty())
        h.config.update(GroundcoverConfigUpdate(cluster = "later"))
        h.pool.flush()
        val sent = h.platform.requests.first().events
        assertEquals(MAX_GATED_BUFFER_EVENTS, sent.size)
        assertEquals(MAX_GATED_BUFFER_EVENTS - 1, (sent.last()["attributes"] as Map<*, *>)["i"])
    }

    @Test
    fun aThrowingGateFailsOpen() {
        // Kotlin only: Swift's gate can't throw.
        val h = PoolHarness(aConfig())
        h.pool.setFlushGate { throw IllegalStateException("gate") }
        h.pool.addEvent(h.event("custom"))
        h.pool.flush()
        assertEquals(1, h.platform.requests.size)
    }

    @Test
    fun beforeSendDropsWhatItRejectsAndAThrowingHookDropsTheEvent() {
        val h = PoolHarness(
            aConfig(
                beforeSend = BeforeSend { event ->
                    if (event.attributes["boom"] == true) throw IllegalStateException("hook")
                    event.attributes["drop"] != true
                }
            )
        )
        h.pool.addEvent(h.event("custom", mapOf("drop" to true)))
        h.pool.addEvent(h.event("custom", mapOf("boom" to true)))
        h.pool.addEvent(h.event("custom", mapOf("keep" to true)))
        h.pool.flush()
        assertEquals(1, h.platform.requests.first().events.size)
    }

    @Test
    fun enrichEventSeesDotFlattenedAttributesAndItsResultShips() {
        var seen: Any? = null
        val h = PoolHarness(
            aConfig(
                enrichEvent = EnrichEvent { event ->
                    seen = event.attributes["nested.key"]
                    event.attributes["added"] = 1
                    event
                }
            )
        )
        h.pool.addEvent(h.event("custom", mapOf("nested" to mapOf("key" to "v"))))
        h.pool.flush()
        assertEquals("v", seen)
        val attributes = h.platform.requests.first().events.first()["attributes"] as Map<*, *>
        assertEquals(1, attributes["added"])
    }

    @Test
    fun whatAHookPutsInShipsAsJsonAndTheBatchIsKept() {
        class Profile {
            override fun toString() = "profile #7"
        }
        val loop = mutableMapOf<String, Any?>("a" to 1)
        loop["self"] = loop
        val h = PoolHarness(
            aConfig(
                enrichEvent = EnrichEvent { event ->
                    event.attributes["profile"] = Profile()
                    event.attributes["loop"] = loop
                    event
                }
            )
        )
        h.pool.addEvent(h.event("custom", mapOf("keep" to true)))
        h.pool.flush()
        val attributes = h.platform.requests.first().events.first()["attributes"] as Map<*, *>
        assertEquals(true, attributes["keep"])
        assertEquals("profile #7", attributes["profile"])
        assertEquals("[Circular]", (attributes["loop"] as Map<*, *>)["self"])
    }

    @Test
    fun hooksRunInTheUserHookScope() {
        val seen = mutableListOf<Boolean>()
        val h = PoolHarness(
            aConfig(
                beforeSend = BeforeSend {
                    seen.add(UserHook.isRunning)
                    true
                },
                enrichEvent = EnrichEvent { event ->
                    seen.add(UserHook.isRunning)
                    event
                }
            )
        )
        h.pool.addEvent(h.event("custom"))
        assertEquals(listOf(true, true), seen)
        assertFalse(UserHook.isRunning)
    }

    @Test
    fun flushSyncDiscardsAGatedBufferInsteadOfCarryingItAcrossAnIdChange() {
        val h = PoolHarness(aConfig())
        h.pool.setFlushGate { false }
        h.pool.addEvent(h.event("custom"))
        h.pool.flushSync()
        h.pool.setFlushGate(null)
        h.pool.flush()
        assertTrue(h.platform.requests.isEmpty())
    }

    @Test
    fun flushSyncClearsTheBufferBeforeItsSendSoAnEventAddedMeanwhileIsKept() {
        val h = PoolHarness(aConfig(batchSize = 100))
        h.pool.addEvent(h.event("custom", mapOf("n" to 1)))
        h.platform.sender.onSend = {
            h.platform.sender.onSend = null
            h.pool.addEvent(h.event("custom", mapOf("n" to 2)))
        }
        h.pool.flushSync()
        h.pool.flush()
        assertEquals(2, h.platform.requests.size)
        assertEquals(2, (h.platform.requests.last().events.first()["attributes"] as Map<*, *>)["n"])
    }

    @Test
    fun theEnvelopePutsSessionIdentityOverAnythingTheDeviceProvides() {
        val h = PoolHarness(
            aConfig(),
            device = {
                mapOf("source" to "mobile-rum", "session_id" to "spoofed", "cluster" to "spoofed")
            }
        )
        val attributes = h.pool.sessionAttributes()
        assertEquals("s1", attributes["session_id"])
        assertEquals("c", attributes["cluster"])
        assertEquals("mobile-rum", attributes["source"])
        assertEquals(msToNs(T0), attributes["session_start_time"])
        assertEquals(emptyMap<String, Any?>(), attributes["user"])
        assertEquals("a", attributes["service.name"])
        assertEquals("", attributes["namespace"])
        assertEquals("", attributes["releaseId"])
    }

    @Test
    fun aThrowingDeviceProviderCostsOnlyTheDevicePart() {
        val h = PoolHarness(aConfig(), device = { throw IllegalStateException("device") })
        val attributes = h.pool.sessionAttributes()
        assertEquals("s1", attributes["session_id"])
        assertNull(attributes["source"])
    }

    @Test
    fun theEnvelopeCarriesOnlyTheUserFieldsSet() {
        val config = ConfigManager(
            GroundcoverConfig(
                apiKey = "k",
                dsn = "d",
                cluster = "c",
                environment = "e",
                appId = "a",
                user = RumUser(id = "u1", email = "a@b")
            )
        )
        val h = PoolHarness(config)
        assertEquals(
            mapOf("id" to "u1", "email" to "a@b"),
            h.pool.sessionAttributes()["user"]
        )
        assertTrue(encodeJson(h.pool.sessionAttributes()["user"]).contains("\"email\":\"a@b\""))
    }
}
