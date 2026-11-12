package com.groundcover.rum.core.crash

import com.groundcover.rum.RumUser
import com.groundcover.rum.core.common.decodeJsonObject
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.LogLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The snapshot the pipeline keeps current for the engine to file the next crash under.
// Robolectric for org.json, which encodes it.
@RunWith(RobolectricTestRunner::class)
class SessionSnapshotTest {
    private fun decode(json: String?): Map<String, Any?> =
        json?.let { decodeJsonObject(it) }.orEmpty()

    @Test
    fun isThisSessionsEnvelopePlusTheScreenPushedOnceTheEngineStartedAndOnEveryChange() {
        val store = FakeCrashStore()
        val (pipeline, _) = startedWith(store)
        pipeline.nativeStarted()
        assertEquals(1, store.snapshots.size)
        val first = decode(store.snapshots.single())
        assertEquals(pipeline.sessionId, first["session_id"])
        assertEquals(mapOf("name" to "", "key" to ""), first["screen"])

        pipeline.identifyUser(RumUser(id = "user-123"))
        assertEquals(mapOf("id" to "user-123"), decode(store.snapshots.last())["user"])

        pipeline.setSessionId("fixed")
        assertEquals("fixed", decode(store.snapshots.last())["session_id"])
    }

    @Test
    fun isNotPushedAgainWhenNothingInItChanged() {
        val store = FakeCrashStore()
        val (pipeline, _) = startedWith(store)
        pipeline.nativeStarted()
        pipeline.presence()
        pipeline.submit(LogCapture("a", LogLevel.INFO))
        pipeline.submit(LogCapture("b", LogLevel.INFO))
        assertEquals(1, store.snapshots.size)
    }

    @Test
    fun isHeldUntilTheEngineHasStartedThenTheLatestGoesOut() {
        // The engine's start pairs the previous run's crashes with the snapshot it holds, so
        // nothing of this run may reach it first: the engine starts with sessionSnapshot instead.
        val store = FakeCrashStore()
        val (pipeline, _) = startedWith(store)
        pipeline.identifyUser(RumUser(id = "early"))
        assertTrue(store.snapshots.isEmpty())
        assertEquals(mapOf("id" to "early"), decode(pipeline.sessionSnapshot)["user"])
        pipeline.nativeStarted()
        assertEquals(1, store.snapshots.size)
        assertEquals(mapOf("id" to "early"), decode(store.snapshots.single())["user"])
    }

    @Test
    fun carriesAUserPropertyJsonHasNoFormForAsBatchesDo() {
        class Since {
            override fun toString() = "2024-01-01"
        }
        val store = FakeCrashStore()
        val (pipeline, _) = startedWith(store)
        pipeline.nativeStarted()
        pipeline.identifyUser(RumUser(id = "u2", properties = mapOf("since" to Since())))
        val user = decode(store.snapshots.last())["user"] as Map<*, *>
        assertEquals("u2", user["id"])
        assertEquals("2024-01-01", (user["properties"] as Map<*, *>)["since"])
    }

    @Test
    fun isClearedWhenThePipelineStops() {
        val store = FakeCrashStore()
        val (pipeline, _) = startedWith(store)
        pipeline.nativeStarted()
        pipeline.stop()
        assertEquals(2, store.snapshots.size)
        assertNull(store.snapshots.last())
    }

    @Test
    fun isNotClearedBeforeTheEngineStartedSinceThePreviousRunsCrashIsFiledUnderIt() {
        val store = FakeCrashStore()
        val (pipeline, _) = startedWith(store)
        pipeline.stop()
        assertTrue(store.snapshots.isEmpty())
    }

    @Test
    fun isNeverPushedForASessionNotSampled() {
        val store = FakeCrashStore()
        val (pipeline, _) = startedWith(store, aCrashConfig(sampled = false))
        assertNull(pipeline.sessionSnapshot)
        pipeline.nativeStarted()
        assertTrue(store.snapshots.isEmpty())
    }
}
