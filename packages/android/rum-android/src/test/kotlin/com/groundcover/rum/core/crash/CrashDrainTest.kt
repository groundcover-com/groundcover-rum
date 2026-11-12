package com.groundcover.rum.core.crash

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.BeforeSend
import com.groundcover.rum.EnrichEvent
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.platform.DeviceEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Crashes that killed a previous run: the drain that delivers each under the session it crashed
// in. Robolectric for org.json, which encodes each batch.
@RunWith(RobolectricTestRunner::class)
class CrashDrainTest {
    @Suppress("UNCHECKED_CAST")
    private fun attributesOf(event: Map<String, Any?>?) =
        event?.get("attributes") as Map<String, Any?>

    @Test
    fun sendsEachRecordAsItsOwnBatchUnderTheSessionItCrashedInAtCrashTimeThenAcksIt() {
        val store = FakeCrashStore(listOf(aRecord(), aRecord(id = "r2")))
        val (pipeline, platform) = startedWith(store)
        pipeline.nativeStarted()

        assertEquals(2, platform.requests.size)
        val request = platform.requests.first()
        // Verbatim, screen aside: never the current session's envelope.
        assertEquals(
            encodeJson(CRASHED_SESSION.filterKeys { it != "screen" }),
            encodeJson(request.sessionAttributes)
        )
        val event = request.events.single()
        assertEquals("exception", event["type"])
        assertEquals(1_700_000_000_000_000_000L, (event["timestamp"] as Number).toLong())
        val attributes = attributesOf(event)
        assertEquals(mapOf("name" to "Native", "key" to "Native-1"), attributes["screen"])
        assertEquals("java.lang.IllegalStateException", attributes["error_type"])
        assertEquals("groundcover test crash (native)", attributes["error_message"])
        assertEquals(
            "java.lang.IllegalStateException:groundcover test crash (native)",
            attributes["error_fingerprint"]
        )
        assertEquals(false, attributes["error_handled"])
        assertEquals(true, attributes["error_metadata.native"])
        assertEquals(true, attributes["error_metadata.fatal"])
        assertEquals("r1", attributes["error_metadata.crash_report_id"])
        assertEquals("jvm_handler", attributes["error_metadata.crash_source"])
        assertEquals(listOf("r1", "r2"), store.cleared)
    }

    @Test
    fun theRecordsOwnScreenWinsOverTheSnapshots() {
        val store = FakeCrashStore(
            listOf(aRecord(screen = mapOf("name" to "Checkout", "key" to "Checkout-2")))
        )
        val (pipeline, platform) = startedWith(store)
        pipeline.nativeStarted()
        assertEquals(
            mapOf("name" to "Checkout", "key" to "Checkout-2"),
            attributesOf(platform.requests.single().events.single())["screen"]
        )
    }

    @Test
    fun aRecordThatLostItsTypeAndMessageGetsTheDefaults() {
        val store = FakeCrashStore(listOf(aRecord(errorType = "", errorMessage = "")))
        val (pipeline, platform) = startedWith(store)
        pipeline.nativeStarted()
        val attributes = attributesOf(platform.requests.single().events.single())
        assertEquals("NativeCrash", attributes["error_type"])
        assertEquals("Native crash", attributes["error_message"])
    }

    @Test
    fun outOfRangeNumbersInARecordAreDropped() {
        // A time written in microseconds, and a corrupt frame.
        val record = aRecord(
            crashEpochMs = 1_700_000_000_000_000L,
            stacktrace = listOf(
                mapOf(
                    "filename" to "Crash.kt",
                    "function" to "boom",
                    "lineno" to 1e20,
                    "colno" to -3
                )
            )
        )
        val (pipeline, platform) = startedWith(FakeCrashStore(listOf(record)))
        pipeline.nativeStarted()
        val event = platform.requests.single().events.single()
        val frame = (attributesOf(event)["error_stacktrace"] as List<*>).single() as Map<*, *>
        assertEquals(0, frame["error_stacktrace[0].lineno"])
        assertEquals(0, frame["error_stacktrace[0].colno"])
        assertEquals(platform.nowMs * 1_000_000, (event["timestamp"] as Number).toLong())
    }

    @Test
    fun aCrashTimeOfZeroOrLessIsTreatedAsUnknown() {
        for (crashEpochMs in listOf(0, -5)) {
            val store = FakeCrashStore(listOf(aRecord(crashEpochMs = crashEpochMs)))
            val (pipeline, platform) = startedWith(store)
            pipeline.nativeStarted()
            val event = platform.requests.single().events.single()
            assertEquals(platform.nowMs * 1_000_000, (event["timestamp"] as Number).toLong())
        }
    }

    @Test
    fun anUndeliveredRecordStaysForTheNextLaunch() {
        val store = FakeCrashStore(listOf(aRecord()))
        val (pipeline, platform) = startedWith(store)
        platform.sender.delivers = false
        pipeline.nativeStarted()
        assertEquals(1, platform.requests.size)
        assertTrue(store.cleared.isEmpty())
    }

    @Test
    fun aRecordWithNoSessionToFileItUnderIsAckedAndDroppedNeverSentUnderThisOne() {
        val store = FakeCrashStore(
            listOf(
                aRecord(id = "none", snapshot = null),
                aRecord(id = "blank", snapshot = mapOf("session_id" to ""))
            )
        )
        val (pipeline, platform) = startedWith(store)
        pipeline.nativeStarted()
        assertTrue(platform.requests.isEmpty())
        assertEquals(listOf("none", "blank"), store.cleared)
    }

    @Test
    fun beforeSendDecidesAndABrokenHookCantWedgeTheStore() {
        val cases = listOf(
            BeforeSend { false } to 0,
            BeforeSend { throw IllegalStateException("hook") } to 0,
            BeforeSend { true } to 1
        )
        for ((beforeSend, sent) in cases) {
            val store = FakeCrashStore(listOf(aRecord()))
            val (pipeline, platform) = startedWith(store, aCrashConfig(beforeSend = beforeSend))
            pipeline.nativeStarted()
            assertEquals(sent, platform.requests.size)
            // Dropped or sent, it is acked: retried, a broken hook stays broken.
            assertEquals(listOf("r1"), store.cleared)
        }
    }

    @Test
    fun aThrowingEnrichEventCostsOnlyWhatItWouldHaveAdded() {
        val store = FakeCrashStore(listOf(aRecord()))
        val (pipeline, platform) = startedWith(
            store,
            aCrashConfig(enrichEvent = EnrichEvent { throw IllegalStateException("hook") })
        )
        pipeline.nativeStarted()
        assertEquals(
            "java.lang.IllegalStateException",
            attributesOf(platform.requests.single().events.single())["error_type"]
        )
        assertEquals(listOf("r1"), store.cleared)
    }

    @Test
    fun anEnrichEventThatChangesTheReportAndThenThrowsLeavesItAsBuilt() {
        val store = FakeCrashStore(listOf(aRecord()))
        val (pipeline, platform) = startedWith(
            store,
            aCrashConfig(
                enrichEvent = EnrichEvent { event ->
                    event.timestamp = 1
                    event.attributes["error_message"] = "unfinished enrichment"
                    event.attributes.remove("error_metadata.crash_report_id")
                    (event.attributes["error_stacktrace"] as MutableList<*>).clear()
                    throw IllegalStateException("hook")
                }
            )
        )
        pipeline.nativeStarted()
        val event = platform.requests.single().events.single()
        assertEquals(1_700_000_000_000_000_000L, (event["timestamp"] as Number).toLong())
        val attributes = attributesOf(event)
        assertEquals("groundcover test crash (native)", attributes["error_message"])
        assertEquals("r1", attributes["error_metadata.crash_report_id"])
        assertEquals(1, (attributes["error_stacktrace"] as List<*>).size)
        assertEquals(listOf("r1"), store.cleared)
    }

    @Test
    fun masksTheMessageAndTheCausesMessagesNeverTheMarkers() {
        val store = FakeCrashStore(
            listOf(
                aRecord(
                    errorMessage = "request failed: password=secret",
                    metadata = mapOf(
                        "password" to "hunter2",
                        "causes" to listOf(mapOf("type" to "E", "message" to "token: abc123"))
                    )
                )
            )
        )
        val (pipeline, platform) = startedWith(store)
        pipeline.nativeStarted()
        val attributes = attributesOf(platform.requests.single().events.single())
        assertFalse((attributes["error_message"] as String).contains("secret"))
        assertNotEquals("hunter2", attributes["error_metadata.password"])
        val causes = attributes["error_metadata.causes"] as List<*>
        assertEquals(
            "token: [REDACTED]",
            (causes.first() as Map<*, *>)["error_metadata.causes[0].message"]
        )
        assertEquals("r1", attributes["error_metadata.crash_report_id"])
    }

    @Test
    fun deliversASampledSessionsCrashOnALaunchThatIsNotSampled() {
        val store = FakeCrashStore(listOf(aRecord()))
        val (pipeline, platform) = startedWith(store, aCrashConfig(sampled = false))
        assertEquals("", pipeline.sessionId)
        pipeline.nativeStarted()
        assertEquals(
            "crashed-session",
            platform.requests.single().sessionAttributes["session_id"]
        )
        assertEquals(listOf("r1"), store.cleared)
    }

    @Test
    fun onePassAtATimeSoASecondCallJoinsTheFirst() {
        val store = FakeCrashStore(listOf(aRecord()))
        val (pipeline, platform) = startedWith(store)
        platform.sender.holdsCompletions = true
        var completions = 0
        pipeline.nativeStarted { completions++ }
        pipeline.nativeStarted { completions++ }
        assertEquals("neither caller hears the end before the send does", 0, completions)
        platform.sender.releaseCompletions()
        assertEquals(1, store.reads)
        assertEquals(1, platform.requests.size)
        assertEquals(listOf("r1"), store.cleared)
        assertEquals("both callers hear the pass end", 2, completions)
    }

    @Test
    fun aStoppedPipelineDrainsNothingWhenTheEngineRepliesLate() {
        for (sampled in listOf(true, false)) {
            val store = FakeCrashStore(listOf(aRecord()))
            val (pipeline, platform) = startedWith(store, aCrashConfig(sampled = sampled))
            pipeline.stop()
            pipeline.nativeStarted()
            assertEquals(0, store.reads)
            assertTrue(platform.requests.isEmpty())
        }
    }

    @Test
    fun theDeviceEngineIsTheCrashStoreAndAnswersBeforeItsEngineIsBuilt() {
        // Production's crash store; with no engine built yet it holds no records.
        val store: CrashStore =
            DeviceEngine.shared(ApplicationProvider.getApplicationContext<Application>())
        assertTrue(store.pendingCrashReportsJson().startsWith("["))
    }
}
