package com.groundcover.rum.core.pipeline

import com.groundcover.rum.EnrichEvent
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverInitException
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.common.MapStorage
import com.groundcover.rum.core.common.PlatformStorage
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.systemClock
import com.groundcover.rum.core.events.CustomEventCapture
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.LogLevel
import com.groundcover.rum.core.transport.BatchRequest
import com.groundcover.rum.core.transport.BatchSender
import com.groundcover.rum.core.transport.SendOutcome
import java.util.Collections
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The runtime behind the public API: start, the calls it drops, the core thread every call hops
// to, and the session id an app reads from any thread.

private fun aRuntimeConfig(
    appId: String = "a",
    options: GroundcoverOptions = GroundcoverOptions(
        transport = TransportOptions(batchSize = 0, compression = false)
    )
) = GroundcoverConfig(
    apiKey = "k",
    dsn = "ingest.example",
    cluster = "c",
    environment = "e",
    appId = appId,
    options = options
)

/** A sender recording the thread each request was handed over on. */
private class ThreadRecordingSender : BatchSender {
    val threads: MutableList<Thread> = Collections.synchronizedList(mutableListOf())

    override fun send(endpoint: String, request: BatchRequest, completion: (SendOutcome) -> Unit) {
        threads.add(Thread.currentThread())
        completion(SendOutcome.Delivered)
    }
}

private fun onCoreThread(sender: BatchSender) = PlatformServices(
    storage = MapStorage(),
    clock = systemClock,
    sender = sender,
    deviceAttributes = { emptyMap() },
    executor = ThreadExecutor()
)

/** Waits, briefly, for work on the core thread to land. */
private fun eventually(condition: () -> Boolean): Boolean {
    repeat(200) {
        if (condition()) return true
        Thread.sleep(10)
    }
    return condition()
}

private fun custom() = CustomEventCapture("x", emptyMap())

@RunWith(RobolectricTestRunner::class)
class RumRuntimeTest {
    @Test
    fun callsBeforeStartAreDroppedAndSaySoInDebug() {
        val lines = Collections.synchronizedList(mutableListOf<String>())
        val diagnostics = RumDiagnostics(sink = { lines.add(it) })
        diagnostics.configure(debug = true)
        val platform = FakePlatform()
        val runtime = RumRuntime(makePlatform = { platform.services }, diagnostics = diagnostics)
        runtime.dispatch("sendCustomEvent") { it.submit(custom()) }
        assertEquals("", runtime.sessionId)
        assertTrue(lines.any { it.contains("sendCustomEvent") && it.contains("hasn't started") })
    }

    @Test
    fun startRejectsABlankAppIdAndStaysStopped() {
        val platform = FakePlatform()
        val runtime = RumRuntime(makePlatform = { platform.services })
        assertThrows(GroundcoverInitException::class.java) {
            runtime.start(aRuntimeConfig(appId = " "))
        }
        assertEquals("", runtime.sessionId)
    }

    @Test
    fun aSecondStartIsIgnored() {
        val platform = FakePlatform()
        val runtime = RumRuntime(makePlatform = { platform.services })
        runtime.start(aRuntimeConfig())
        val first = runtime.sessionId
        runtime.start(aRuntimeConfig(appId = "other"))
        assertEquals(first, runtime.sessionId)
        assertEquals(32, first.length)
    }

    @Test
    fun aCallFromInsideAHookIsDropped() {
        // Sent, it would run through the same hook again, without end.
        val platform = FakePlatform()
        lateinit var runtime: RumRuntime
        runtime = RumRuntime(makePlatform = { platform.services })
        runtime.start(
            aRuntimeConfig(
                options = GroundcoverOptions(
                    enrichEvent = EnrichEvent { event ->
                        runtime.dispatch("logger.info") {
                            it.submit(LogCapture("from a hook", LogLevel.INFO))
                        }
                        event
                    },
                    transport = TransportOptions(batchSize = 0, compression = false)
                )
            )
        )
        runtime.dispatch("presence") { it.presence() }
        runtime.dispatch("sendCustomEvent") { it.submit(custom()) }
        assertEquals(listOf("custom"), platform.types)
    }

    @Test
    fun workRunsOnTheCoreQueueNeverTheMainThread() {
        val sender = ThreadRecordingSender()
        val runtime = RumRuntime(makePlatform = { onCoreThread(sender) })
        runtime.start(aRuntimeConfig())
        runtime.dispatch("presence") { it.presence() }
        runtime.dispatch("sendCustomEvent") { it.submit(custom()) }
        assertTrue(eventually { sender.threads.size == 1 })
        assertTrue(sender.threads.single() !== Thread.currentThread())
        assertEquals("gc-rum-core", sender.threads.single().name)
        runtime.reset()
    }

    @Test
    fun theSessionIdIsReadableFromInsideAHookWithoutWaitingOnTheQueue() {
        val seen = AtomicReference<String?>(null)
        lateinit var runtime: RumRuntime
        runtime = RumRuntime(makePlatform = { onCoreThread(ThreadRecordingSender()) })
        runtime.start(
            aRuntimeConfig(
                options = GroundcoverOptions(
                    beforeSend = {
                        seen.set(runtime.sessionId)
                        true
                    }
                )
            )
        )
        runtime.dispatch("sendCustomEvent") { it.submit(custom()) }
        assertTrue(eventually { seen.get() != null })
        assertEquals(runtime.sessionId, seen.get())
        runtime.reset()
    }

    @Test
    fun theSessionIdIsReadableAsSoonAsStartReturns() {
        // A storage as slow as a cold disk, so the queued start is still running when start returns.
        val slowStorage = object : PlatformStorage by MapStorage() {
            override fun getItem(key: String): String? {
                Thread.sleep(100)
                return null
            }
        }
        val runtime = RumRuntime(makePlatform = {
            PlatformServices(
                storage = slowStorage,
                clock = systemClock,
                sender = ThreadRecordingSender(),
                deviceAttributes = { emptyMap() },
                executor = ThreadExecutor()
            )
        })
        runtime.start(aRuntimeConfig())
        assertEquals(32, runtime.sessionId.length)
        runtime.reset()
    }

    @Test
    fun setSessionIdCompletesOnceTheOldSessionIsHandedOver() {
        val platform = FakePlatform()
        val runtime = RumRuntime(makePlatform = { platform.services })
        runtime.start(
            aRuntimeConfig(
                options = GroundcoverOptions(
                    transport = TransportOptions(batchSize = 100, compression = false)
                )
            )
        )
        runtime.dispatch("presence") { it.presence() }
        runtime.dispatch("sendCustomEvent") { it.submit(custom()) }
        var done = false
        runtime.setSessionId("fixed") { done = true }
        assertTrue(done)
        assertEquals(1, platform.requests.size)
        assertEquals("fixed", runtime.sessionId)
    }

    @Test
    fun resetStopsTheSdkSoTheNextStartBeginsAfresh() {
        val platform = FakePlatform()
        val runtime = RumRuntime(makePlatform = { platform.services })
        runtime.start(aRuntimeConfig())
        runtime.reset()
        assertEquals("", runtime.sessionId)
        runtime.dispatch("presence") { it.presence() }
        runtime.dispatch("sendCustomEvent") { it.submit(custom()) }
        assertTrue(platform.requests.isEmpty())
        runtime.start(aRuntimeConfig())
        assertEquals(32, runtime.sessionId.length)
    }
}
