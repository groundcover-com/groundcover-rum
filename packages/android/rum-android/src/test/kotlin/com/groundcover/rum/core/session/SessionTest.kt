package com.groundcover.rum.core.session

import com.groundcover.rum.RumEvent
import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.common.MapStorage
import com.groundcover.rum.core.common.SafeStorage
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.config.DEFAULT_SESSION_MAX_DURATION_MS
import com.groundcover.rum.core.events.earliestTrustedEventTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Session identity: the sampling verdict, bootstrap at start, the persisted state with its gap
// and cap rules, and the lifecycle that rotates a session.

private const val T0 = 1_800_000_000_000L
private const val MINUTE = 60_000L

/** Ids that say which one they are, so a test can tell a rotation happened. */
internal class CountingIds : IdGenerator {
    var count = 0
        private set

    override fun generateId() = "id-${++count}"

    override fun generateSpanId() = "span"

    override fun generateTraceId() = "trace"
}

/** The pool as the lifecycle drives it: what it was told to do, and in what session. */
internal class FakeLifecyclePool : LifecyclePool {
    var enqueueHook: ((RumEvent) -> Unit)? = null
    var sendGate: (() -> Boolean)? = null
    var buffered = mutableListOf<RumEvent>()
    val flushedUnder = mutableListOf<String>()
    var discards = 0
        private set
    var sessionId: () -> String = { "" }

    /** A flush that can't send (no cluster yet) leaves the buffer as it is. */
    var flushCanSend = true

    override fun setBeforeEnqueueHook(hook: ((RumEvent) -> Unit)?) {
        enqueueHook = hook
    }

    override fun setFlushGate(gate: (() -> Boolean)?) {
        sendGate = gate
    }

    override fun flush() {
        flushedUnder.add(sessionId())
        if (flushCanSend) buffered.clear()
    }

    override fun discardBuffer() {
        discards++
        buffered.clear()
    }

    override fun earliestEventTimestamp(nowNs: Long, maxAgeNs: Long): Long? =
        earliestTrustedEventTime(buffered, nowNs, maxAgeNs)

    /** What the pool does on `addEvent`: the hook runs before the event joins the buffer. */
    fun add(event: RumEvent) {
        enqueueHook?.invoke(event)
        buffered.add(event)
    }
}

internal fun anEvent(type: String, timestamp: Long? = null, startTimestamp: Long? = null) =
    RumEvent(
        type = type,
        id = "e",
        spanId = "s",
        timestamp = timestamp,
        startTimestamp = startTimestamp
    )

class SamplingTest {
    @Test
    fun samplesEverythingWithNoRateOrAt1WithoutPersisting() {
        val backend = MapStorage()
        val storage = SafeStorage(backend)
        assertTrue(resolveSamplingDecision(storage, sessionSampleRate = null))
        assertTrue(resolveSamplingDecision(storage, sessionSampleRate = 1.0))
        assertTrue(backend.values.isEmpty())
    }

    @Test
    fun samplesNothingAt0EvenWhenTheRollIs0AndPersistsIt() {
        val backend = MapStorage()
        assertFalse(resolveSamplingDecision(SafeStorage(backend), 0.0, random = { 0.0 }))
        assertEquals("0", backend.values[SessionKeys.SAMPLING])
    }

    @Test
    fun rollsAgainstTheRateAndPersistsTheVerdict() {
        val backend = MapStorage()
        assertTrue(resolveSamplingDecision(SafeStorage(backend), 0.5, random = { 0.4 }))
        assertEquals("1", backend.values[SessionKeys.SAMPLING])
    }

    @Test
    fun reusesAStoredVerdictInsteadOfReRolling() {
        val backend = MapStorage()
        backend.values[SessionKeys.SAMPLING] = "0"
        assertFalse(resolveSamplingDecision(SafeStorage(backend), 0.5, random = { 0.0 }))
    }

    @Test
    fun treatsANonFiniteRateAsUnset() {
        assertTrue(resolveSamplingDecision(SafeStorage(MapStorage()), Double.NaN))
    }
}

class BootstrapTest {
    private val backend = MapStorage()

    private fun boot(provided: String? = null, now: Long = T0): SessionState {
        val session = SessionState(SafeStorage(backend))
        bootstrapSession(session, CountingIds(), { now }, provided)
        return session
    }

    @Test
    fun mintsAnIdAndAStartWhenThereIsNoSessionYet() {
        val session = boot()
        assertTrue(session.sessionId.startsWith("id-"))
        assertEquals(msToNs(T0), session.sessionStartTimeNs)
    }

    @Test
    fun continuesAPersistedCurrentSession() {
        backend.values.putAll(
            mapOf(
                SessionKeys.ID to "kept",
                SessionKeys.START_TIME to "${msToNs(T0 - MINUTE)}",
                SessionKeys.LAST_ACTIVITY to "${T0 - MINUTE}",
                SessionKeys.SAMPLING to "1"
            )
        )
        assertEquals("kept", boot().sessionId)
        assertEquals("1", backend.values[SessionKeys.SAMPLING])
    }

    @Test
    fun rotatesAPersistedSessionPastItsCapReRollingSampling() {
        backend.values.putAll(
            mapOf(
                SessionKeys.ID to "old",
                SessionKeys.START_TIME to "${msToNs(T0 - 5 * 60 * MINUTE)}",
                SessionKeys.LAST_ACTIVITY to "${T0 - MINUTE}",
                SessionKeys.SAMPLING to "1"
            )
        )
        val session = boot()
        assertNotEquals("old", session.sessionId)
        assertEquals(msToNs(T0), session.sessionStartTimeNs)
        assertNull(backend.values[SessionKeys.SAMPLING])
    }

    @Test
    fun rotatesAfterAnInactivityGapAcrossARestart() {
        backend.values.putAll(
            mapOf(
                SessionKeys.ID to "old",
                SessionKeys.START_TIME to "${msToNs(T0 - 40 * MINUTE)}",
                SessionKeys.LAST_ACTIVITY to "${T0 - 31 * MINUTE}"
            )
        )
        assertNotEquals("old", boot().sessionId)
    }

    @Test
    fun aDifferentProvidedIdStartsItsOwnClockAndReRollsSampling() {
        backend.values.putAll(
            mapOf(
                SessionKeys.ID to "old",
                SessionKeys.START_TIME to "${msToNs(T0 - MINUTE)}",
                SessionKeys.SAMPLING to "1"
            )
        )
        val session = boot(provided = "mine")
        assertEquals("mine", session.sessionId)
        assertEquals(msToNs(T0), session.sessionStartTimeNs)
        assertNull(backend.values[SessionKeys.SAMPLING])
    }

    @Test
    fun theSameIdReProvidedKeepsItsStartAndVerdict() {
        backend.values.putAll(
            mapOf(
                SessionKeys.ID to "mine",
                SessionKeys.START_TIME to "${msToNs(T0 - MINUTE)}",
                SessionKeys.LAST_ACTIVITY to "${T0 - MINUTE}",
                SessionKeys.SAMPLING to "1"
            )
        )
        assertEquals(msToNs(T0 - MINUTE), boot(provided = "mine").sessionStartTimeNs)
        assertEquals("1", backend.values[SessionKeys.SAMPLING])
    }

    @Test
    fun treatsAnImplausiblyFutureStartAsMissing() {
        backend.values.putAll(
            mapOf(SessionKeys.ID to "x", SessionKeys.START_TIME to "${msToNs(T0 + 10 * MINUTE)}")
        )
        assertEquals(msToNs(T0), boot().sessionStartTimeNs)
    }
}

class SessionStateTest {
    private val backend = MapStorage()

    private fun aSession() = SessionState(SafeStorage(backend))

    @Test
    fun readsTheIdAndStartFromStorageUntilSetInMemory() {
        val session = aSession()
        assertEquals("", session.sessionId)
        backend.values[SessionKeys.ID] = "stored"
        assertEquals("stored", session.sessionId)
        session.sessionId = "memory"
        assertEquals("memory", session.sessionId)
        assertEquals("memory", backend.values[SessionKeys.ID])
    }

    @Test
    fun elapsedTimeAndTheCap() {
        val session = aSession()
        assertEquals(0L, session.sessionElapsedMs(T0))
        assertFalse(session.isSessionExpired(T0))
        session.setSessionStartTime(msToNs(T0))
        assertEquals(1000L, session.sessionElapsedMs(T0 + 1000))
        assertFalse(session.isSessionExpired(T0 + DEFAULT_SESSION_MAX_DURATION_MS - 1))
        assertTrue(session.isSessionExpired(T0 + DEFAULT_SESSION_MAX_DURATION_MS))
    }

    @Test
    fun theCapComesFromTheConfigurationAsItIsNow() {
        var capMs: Long? = MINUTE
        val session = SessionState(SafeStorage(backend), maxDurationMs = { capMs })
        session.setSessionStartTime(msToNs(T0))
        assertTrue(session.isSessionExpired(T0 + MINUTE))
        capMs = 2 * MINUTE
        assertFalse(session.isSessionExpired(T0 + MINUTE))
    }

    @Test
    fun persistsTheFirstActivityStampThenThrottlesToOnceAMinute() {
        val session = aSession()
        session.recordActivity(T0)
        assertEquals("$T0", backend.values[SessionKeys.LAST_ACTIVITY])
        session.recordActivity(T0 + 1000)
        assertEquals("$T0", backend.values[SessionKeys.LAST_ACTIVITY])
        assertEquals(T0 + 1000, session.lastActivityMs)
        session.recordActivity(T0 + MINUTE)
        assertEquals("${T0 + MINUTE}", backend.values[SessionKeys.LAST_ACTIVITY])
    }

    @Test
    fun persistLastActivityWritesTheExactClockButNeverAfterAReset() {
        val session = aSession()
        session.recordActivity(T0)
        session.recordActivity(T0 + 1000)
        session.persistLastActivity()
        assertEquals("${T0 + 1000}", backend.values[SessionKeys.LAST_ACTIVITY])
        session.setSessionStartTime(msToNs(T0 + 2000))
        session.persistLastActivity()
        assertNull(backend.values[SessionKeys.LAST_ACTIVITY])
    }

    @Test
    fun aNewStartLeavesTheSessionUnconfirmed() {
        val session = aSession()
        session.recordActivity(T0)
        assertTrue(session.hasUserActivity)
        session.setSessionStartTime(msToNs(T0))
        assertFalse(session.hasUserActivity)
    }

    @Test
    fun aConfirmedSessionReadBackFromStorageStaysConfirmed() {
        backend.values[SessionKeys.LAST_ACTIVITY] = "$T0"
        assertTrue(aSession().hasUserActivity)
    }

    @Test
    fun inactivityRunsFromTheLastActivityOrFromBirthWhenUnstamped() {
        val session = aSession()
        assertFalse(session.isSessionInactive(T0))
        session.setSessionStartTime(msToNs(T0))
        assertFalse(session.isSessionInactive(T0 + 29 * MINUTE))
        assertTrue(session.isSessionInactive(T0 + 30 * MINUTE))
        session.recordActivity(T0 + 20 * MINUTE)
        assertFalse(session.isSessionInactive(T0 + 30 * MINUTE))
        assertTrue(session.isSessionInactive(T0 + 50 * MINUTE))
    }

    @Test
    fun clearSessionStateRemovesEveryKeyAndTheInMemoryMirrors() {
        val session = aSession()
        session.sessionId = "x"
        session.setSessionStartTime(msToNs(T0))
        session.recordActivity(T0)
        backend.values[SessionKeys.SAMPLING] = "1"
        session.clearSessionState()
        assertTrue(backend.values.isEmpty())
        assertEquals("", session.sessionId)
        assertFalse(session.hasUserActivity)
    }
}

/** A lifecycle over a fake pool, on a clock the test moves. */
private class LifecycleDriver(var capMs: Long? = null) {
    val backend = MapStorage()
    val pool = FakeLifecyclePool()
    val ids = CountingIds()
    var nowMs = T0
    val session = SessionState(SafeStorage(backend), maxDurationMs = { capMs })
    val lifecycle = SessionLifecycle(
        session = session,
        pool = pool,
        idGenerator = ids,
        clock = { nowMs },
        activityEventTypes = setOf("interaction"),
        ignoredEventTypes = setOf("performance")
    )

    init {
        session.sessionId = "first"
        session.setSessionStartTime(msToNs(T0))
        pool.sessionId = { session.sessionId }
        lifecycle.install()
    }
}

class SessionLifecycleTest {
    @Test
    fun anInteractionConfirmsTheSessionAndOpensTheSendGate() {
        val driver = LifecycleDriver()
        val gate = driver.pool.sendGate!!
        driver.pool.add(anEvent("custom"))
        assertFalse("held until presence", gate())
        driver.pool.add(anEvent("interaction"))
        assertTrue(driver.session.hasUserActivity)
        assertTrue(gate())
    }

    @Test
    fun backgroundTrafficNeverConfirmsASession() {
        val driver = LifecycleDriver()
        for (type in listOf("network", "custom", "log", "navigation", "performance")) {
            driver.pool.add(anEvent(type))
        }
        assertFalse(driver.session.hasUserActivity)
    }

    @Test
    fun rotatesOnceTheCapIsReachedButNotForAHeartbeatType() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.nowMs = T0 + MINUTE
        driver.pool.add(anEvent("performance"))
        assertEquals("first", driver.session.sessionId)
        driver.pool.add(anEvent("custom"))
        assertNotEquals("first", driver.session.sessionId)
    }

    @Test
    fun rotatesOnTheFirstInteractionAfterAGapExactlyOnce() {
        val driver = LifecycleDriver()
        driver.lifecycle.reconcile(T0, userPresent = true)
        driver.nowMs = T0 + 31 * MINUTE
        driver.pool.add(anEvent("custom"))
        assertEquals("only presence ends a gap", "first", driver.session.sessionId)
        driver.pool.add(anEvent("interaction"))
        val rotated = driver.session.sessionId
        assertNotEquals("first", rotated)
        driver.pool.add(anEvent("interaction"))
        assertEquals(rotated, driver.session.sessionId)
    }

    @Test
    fun aConfirmedSessionFlushesItsBufferUnderTheOldId() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.lifecycle.reconcile(T0, userPresent = true)
        driver.pool.add(anEvent("custom"))
        driver.nowMs = T0 + MINUTE
        driver.pool.add(anEvent("custom"))
        assertEquals(listOf("first"), driver.pool.flushedUnder)
        assertEquals(0, driver.pool.discards)
    }

    @Test
    fun anUnconfirmedSessionDiscardsItsBufferOnRotation() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.pool.add(anEvent("custom"))
        driver.nowMs = T0 + MINUTE
        driver.lifecycle.reconcile(T0 + MINUTE, userPresent = false)
        assertEquals(1, driver.pool.discards)
        assertTrue(driver.pool.flushedUnder.isEmpty())
    }

    @Test
    fun aRotationStartsAFreshUnconfirmedSessionAndRedrawsTheSamplingVerdict() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.backend.values[SessionKeys.SAMPLING] = "1"
        driver.lifecycle.reconcile(T0, userPresent = true)
        driver.nowMs = T0 + MINUTE
        driver.lifecycle.reconcile(T0 + MINUTE, userPresent = false)
        assertEquals("id-1", driver.session.sessionId)
        assertEquals(msToNs(T0 + MINUTE), driver.session.sessionStartTimeNs)
        assertFalse(driver.session.hasUserActivity)
        assertNull(driver.backend.values[SessionKeys.SAMPLING])
    }

    @Test
    fun stampsTheRotatedSessionsStartFromTheTriggeringEvent() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.nowMs = T0 + MINUTE + 10
        driver.lifecycle.reconcile(
            T0 + MINUTE + 10,
            userPresent = false,
            triggeringEvent = anEvent("custom", timestamp = msToNs(T0 + MINUTE))
        )
        assertEquals(msToNs(T0 + MINUTE), driver.session.sessionStartTimeNs)
    }

    @Test
    fun aNetworkEventStartsItFromItsStartTimestamp() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.nowMs = T0 + MINUTE + 10
        driver.lifecycle.reconcile(
            T0 + MINUTE + 10,
            userPresent = false,
            triggeringEvent = anEvent("network", startTimestamp = msToNs(T0 + MINUTE + 5))
        )
        assertEquals(msToNs(T0 + MINUTE + 5), driver.session.sessionStartTimeNs)
    }

    @Test
    fun anEarlierEventStillInThePoolBackdatesTheNewStart() {
        // A session must never start after an event it carries: what the flush left in the pool
        // ships under the new id.
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.lifecycle.reconcile(T0, userPresent = true)
        driver.pool.flushCanSend = false
        driver.nowMs = T0 + MINUTE + 10
        driver.pool.buffered = mutableListOf(anEvent("custom", timestamp = msToNs(T0 + MINUTE + 2)))
        driver.lifecycle.rotateIfStale(T0 + MINUTE + 10, "test")
        assertEquals(msToNs(T0 + MINUTE + 2), driver.session.sessionStartTimeNs)
    }

    @Test
    fun stampsFromTheClockWhenNoEventDroveIt() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.nowMs = T0 + 2 * MINUTE
        driver.lifecycle.rotateIfStale(T0 + 2 * MINUTE, "test")
        assertEquals(msToNs(T0 + 2 * MINUTE), driver.session.sessionStartTimeNs)
    }

    @Test
    fun ignoresImplausibleTriggerTimesInsteadOfStartingIn1970() {
        val driver = LifecycleDriver(capMs = MINUTE)
        val now = T0 + MINUTE
        driver.nowMs = now
        for (bogus in listOf(0L, -5L, T0, msToNs(now) + 1, msToNs(now - 31 * MINUTE))) {
            driver.session.setSessionStartTime(msToNs(T0))
            driver.lifecycle.reconcile(
                now,
                userPresent = false,
                triggeringEvent = anEvent("custom", timestamp = bogus)
            )
            assertEquals("$bogus", msToNs(now), driver.session.sessionStartTimeNs)
        }
    }

    @Test
    fun doesNotRotateOnEveryEventWhenEventsCarryBogusOldTimes() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.nowMs = T0 + MINUTE
        driver.pool.add(anEvent("custom", timestamp = 1))
        val rotated = driver.session.sessionId
        driver.pool.add(anEvent("custom", timestamp = 1))
        driver.pool.add(anEvent("custom", timestamp = 1))
        assertEquals(rotated, driver.session.sessionId)
    }

    @Test
    fun rotateIfStaleRotatesAGappedOrCappedSessionNeverACurrentOne() {
        val driver = LifecycleDriver(capMs = MINUTE)
        driver.lifecycle.rotateIfStale(T0 + 1000, "current")
        assertEquals("first", driver.session.sessionId)
        driver.lifecycle.rotateIfStale(T0 + MINUTE, "capped")
        assertNotEquals("first", driver.session.sessionId)
    }

    @Test
    fun uninstallClearsTheHookAndTheGateAfterTheHostTeardown() {
        val driver = LifecycleDriver()
        var gateDuringTeardown = false
        driver.lifecycle.uninstall { gateDuringTeardown = driver.pool.sendGate != null }
        assertNull(driver.pool.enqueueHook)
        assertNull(driver.pool.sendGate)
        assertTrue("an unconfirmed session's final batch stays held", gateDuringTeardown)
    }

    @Test
    fun aStepThatThrowsDoesNotStopTheRotation() {
        val driver = LifecycleDriver(capMs = MINUTE)
        val failing = object : LifecyclePool by driver.pool {
            override fun discardBuffer() = throw IllegalStateException("pool down")
        }
        val lifecycle = SessionLifecycle(
            driver.session,
            failing,
            driver.ids,
            { driver.nowMs },
            setOf("interaction"),
            setOf("performance")
        )
        lifecycle.rotate("test")
        assertEquals("id-1", driver.session.sessionId)
        assertFalse(lifecycle.isRotating)
    }
}
