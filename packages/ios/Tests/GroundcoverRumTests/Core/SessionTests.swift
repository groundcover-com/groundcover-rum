import Foundation
import Testing

@testable import GroundcoverRum

// Session identity: the sampling verdict, bootstrap at start, the persisted state with its gap
// and cap rules, which event times can be trusted, and the lifecycle that rotates a session.

private let t0: Int64 = 1_800_000_000_000
private let minute: Int64 = 60_000

/// Ids that say which one they are, so a test can tell a rotation happened.
final class CountingIds: IdGenerator {
    private(set) var count = 0

    func generateId() -> String {
        count += 1
        return "id-\(count)"
    }

    func generateSpanId() -> String { "span" }

    func generateTraceId() -> String { "trace" }
}

/// The pool as the lifecycle drives it: what it was told to do, and in what session.
final class FakeLifecyclePool: LifecyclePool {
    var beforeEnqueue: ((RumEvent) -> Void)?
    var flushGate: (() -> Bool)?
    var buffered: [RumEvent] = []
    private(set) var flushedUnder: [String] = []
    private(set) var discards = 0
    var sessionId: () -> String = { "" }

    /// A flush that can't send (no cluster yet) leaves the buffer as it is.
    var flushCanSend = true

    func setBeforeEnqueueHook(_ hook: ((RumEvent) -> Void)?) { beforeEnqueue = hook }

    func setFlushGate(_ gate: (() -> Bool)?) { flushGate = gate }

    func flush() {
        flushedUnder.append(sessionId())
        if flushCanSend { buffered = [] }
    }

    func discardBuffer() {
        discards += 1
        buffered = []
    }

    func earliestEventTimestamp(nowNs: Int64, maxAgeNs: Int64) -> Int64? {
        earliestTrustedEventTime(buffered, nowNs: nowNs, maxAgeNs: maxAgeNs)
    }

    /// What the pool does on `addEvent`: the hook runs before the event joins the buffer.
    func add(_ event: RumEvent) {
        beforeEnqueue?(event)
        buffered.append(event)
    }
}

private func anEvent(_ type: String, timestamp: Int64? = nil, startTimestamp: Int64? = nil)
    -> RumEvent
{
    RumEvent(
        type: type, id: "e", spanId: "s", timestamp: timestamp, startTimestamp: startTimestamp)
}

@Suite struct SamplingTests {
    @Test func samplesEverythingWithNoRateOrAt1WithoutPersisting() {
        let backend = MapStorage()
        let storage = SafeStorage(backend)
        #expect(resolveSamplingDecision(storage: storage, sessionSampleRate: nil))
        #expect(resolveSamplingDecision(storage: storage, sessionSampleRate: 1))
        #expect(backend.values.isEmpty)
    }

    @Test func samplesNothingAt0EvenWhenTheRollIs0AndPersistsIt() {
        let backend = MapStorage()
        #expect(
            !resolveSamplingDecision(
                storage: SafeStorage(backend), sessionSampleRate: 0, random: { 0 }))
        #expect(backend.values[SessionKeys.sampling] == "0")
    }

    @Test func rollsAgainstTheRateAndPersistsTheVerdict() {
        let backend = MapStorage()
        #expect(
            resolveSamplingDecision(
                storage: SafeStorage(backend), sessionSampleRate: 0.5, random: { 0.4 }))
        #expect(backend.values[SessionKeys.sampling] == "1")
    }

    @Test func reusesAStoredVerdictInsteadOfReRolling() {
        let backend = MapStorage()
        backend.values[SessionKeys.sampling] = "0"
        #expect(
            !resolveSamplingDecision(
                storage: SafeStorage(backend), sessionSampleRate: 0.5, random: { 0 }))
    }

    @Test func treatsANonFiniteRateAsUnset() {
        #expect(
            resolveSamplingDecision(storage: SafeStorage(MapStorage()), sessionSampleRate: .nan))
    }
}

@Suite struct BootstrapTests {
    private let backend = MapStorage()
    private var session: SessionState { SessionState(storage: SafeStorage(backend)) }

    private func boot(_ session: SessionState, provided: String? = nil, now: Int64 = t0) {
        bootstrapSession(
            session: session, idGenerator: CountingIds(), clock: { now },
            providedSessionId: provided)
    }

    @Test func mintsAnIdAndAStartWhenThereIsNoSessionYet() {
        let session = self.session
        boot(session)
        #expect(session.sessionId.hasPrefix("id-"))
        #expect(session.sessionStartTimeNs == msToNs(t0))
    }

    @Test func continuesAPersistedCurrentSession() {
        backend.values = [
            SessionKeys.id: "kept", SessionKeys.startTime: "\(msToNs(t0 - minute))",
            SessionKeys.lastActivity: "\(t0 - minute)", SessionKeys.sampling: "1",
        ]
        let session = self.session
        boot(session)
        #expect(session.sessionId == "kept")
        #expect(backend.values[SessionKeys.sampling] == "1")
    }

    @Test func rotatesAPersistedSessionPastItsCapReRollingSampling() {
        backend.values = [
            SessionKeys.id: "old", SessionKeys.startTime: "\(msToNs(t0 - 5 * 60 * minute))",
            SessionKeys.lastActivity: "\(t0 - minute)", SessionKeys.sampling: "1",
        ]
        let session = self.session
        boot(session)
        #expect(session.sessionId != "old")
        #expect(session.sessionStartTimeNs == msToNs(t0))
        #expect(backend.values[SessionKeys.sampling] == nil)
    }

    @Test func rotatesAfterAnInactivityGapAcrossARestart() {
        backend.values = [
            SessionKeys.id: "old", SessionKeys.startTime: "\(msToNs(t0 - 40 * minute))",
            SessionKeys.lastActivity: "\(t0 - 31 * minute)",
        ]
        let session = self.session
        boot(session)
        #expect(session.sessionId != "old")
    }

    @Test func aDifferentProvidedIdStartsItsOwnClockAndReRollsSampling() {
        backend.values = [
            SessionKeys.id: "old", SessionKeys.startTime: "\(msToNs(t0 - minute))",
            SessionKeys.sampling: "1",
        ]
        let session = self.session
        boot(session, provided: "mine")
        #expect(session.sessionId == "mine")
        #expect(session.sessionStartTimeNs == msToNs(t0))
        #expect(backend.values[SessionKeys.sampling] == nil)
    }

    @Test func theSameIdReProvidedKeepsItsStartAndVerdict() {
        backend.values = [
            SessionKeys.id: "mine", SessionKeys.startTime: "\(msToNs(t0 - minute))",
            SessionKeys.lastActivity: "\(t0 - minute)", SessionKeys.sampling: "1",
        ]
        let session = self.session
        boot(session, provided: "mine")
        #expect(session.sessionStartTimeNs == msToNs(t0 - minute))
        #expect(backend.values[SessionKeys.sampling] == "1")
    }

    @Test func treatsAnImplausiblyFutureStartAsMissing() {
        backend.values = [
            SessionKeys.id: "x", SessionKeys.startTime: "\(msToNs(t0 + 10 * minute))",
        ]
        let session = self.session
        boot(session)
        #expect(session.sessionStartTimeNs == msToNs(t0))
    }
}

@Suite struct SessionStateTests {
    private let backend = MapStorage()

    private func aSession() -> SessionState { SessionState(storage: SafeStorage(backend)) }

    @Test func readsTheIdAndStartFromStorageUntilSetInMemory() {
        let session = aSession()
        #expect(session.sessionId == "")
        backend.values[SessionKeys.id] = "stored"
        #expect(session.sessionId == "stored")
        session.sessionId = "memory"
        #expect(session.sessionId == "memory")
        #expect(backend.values[SessionKeys.id] == "memory")
    }

    @Test func elapsedTimeAndTheCap() {
        let session = aSession()
        #expect(session.sessionElapsedMs(nowMs: t0) == 0)
        #expect(!session.isSessionExpired(nowMs: t0))
        session.setSessionStartTime(msToNs(t0))
        #expect(session.sessionElapsedMs(nowMs: t0 + 1000) == 1000)
        #expect(!session.isSessionExpired(nowMs: t0 + defaultSessionMaxDurationMs - 1))
        #expect(session.isSessionExpired(nowMs: t0 + defaultSessionMaxDurationMs))
    }

    @Test func theCapComesFromTheConfigurationAsItIsNow() {
        var capMs: Int64? = minute
        let session = SessionState(storage: SafeStorage(backend), maxDurationMs: { capMs })
        session.setSessionStartTime(msToNs(t0))
        #expect(session.isSessionExpired(nowMs: t0 + minute))
        capMs = 2 * minute
        #expect(!session.isSessionExpired(nowMs: t0 + minute))
    }

    @Test func persistsTheFirstActivityStampThenThrottlesToOnceAMinute() {
        let session = aSession()
        session.recordActivity(atMs: t0)
        #expect(backend.values[SessionKeys.lastActivity] == "\(t0)")
        session.recordActivity(atMs: t0 + 1000)
        #expect(backend.values[SessionKeys.lastActivity] == "\(t0)")
        #expect(session.lastActivityMs == t0 + 1000)
        session.recordActivity(atMs: t0 + minute)
        #expect(backend.values[SessionKeys.lastActivity] == "\(t0 + minute)")
    }

    @Test func persistLastActivityWritesTheExactClockButNeverAfterAReset() {
        let session = aSession()
        session.recordActivity(atMs: t0)
        session.recordActivity(atMs: t0 + 1000)
        session.persistLastActivity()
        #expect(backend.values[SessionKeys.lastActivity] == "\(t0 + 1000)")
        session.setSessionStartTime(msToNs(t0 + 2000))
        session.persistLastActivity()
        #expect(backend.values[SessionKeys.lastActivity] == nil)
    }

    @Test func aNewStartLeavesTheSessionUnconfirmed() {
        let session = aSession()
        session.recordActivity(atMs: t0)
        #expect(session.hasUserActivity)
        session.setSessionStartTime(msToNs(t0))
        #expect(!session.hasUserActivity)
    }

    @Test func aConfirmedSessionReadBackFromStorageStaysConfirmed() {
        backend.values[SessionKeys.lastActivity] = "\(t0)"
        #expect(aSession().hasUserActivity)
    }

    @Test func inactivityRunsFromTheLastActivityOrFromBirthWhenUnstamped() {
        let session = aSession()
        #expect(!session.isSessionInactive(nowMs: t0))
        session.setSessionStartTime(msToNs(t0))
        #expect(!session.isSessionInactive(nowMs: t0 + 29 * minute))
        #expect(session.isSessionInactive(nowMs: t0 + 30 * minute))
        session.recordActivity(atMs: t0 + 20 * minute)
        #expect(!session.isSessionInactive(nowMs: t0 + 30 * minute))
        #expect(session.isSessionInactive(nowMs: t0 + 50 * minute))
    }

    @Test func clearSessionStateRemovesEveryKeyAndTheInMemoryMirrors() {
        let session = aSession()
        session.sessionId = "x"
        session.setSessionStartTime(msToNs(t0))
        session.recordActivity(atMs: t0)
        backend.values[SessionKeys.sampling] = "1"
        session.clearSessionState()
        #expect(backend.values.isEmpty)
        #expect(session.sessionId == "")
        #expect(!session.hasUserActivity)
    }
}

@Suite struct EventTimeTests {
    private let now: Int64 = 1_800_000_000_000_000_000
    private let window: Int64 = 3600 * 1_000_000_000

    @Test func trustsOnlyTimesInsideTheWindowEndingNow() {
        #expect(isTrustedEventTime(now, nowNs: now, maxAgeNs: window))
        #expect(isTrustedEventTime(now - window + 1, nowNs: now, maxAgeNs: window))
        #expect(!isTrustedEventTime(now - window, nowNs: now, maxAgeNs: window))
        #expect(!isTrustedEventTime(now + 1, nowNs: now, maxAgeNs: window))
        #expect(!isTrustedEventTime(0, nowNs: now, maxAgeNs: window))
        #expect(!isTrustedEventTime(nil, nowNs: now, maxAgeNs: window))
        // Milliseconds read as nanoseconds land in 1970.
        #expect(!isTrustedEventTime(1_800_000_000_000, nowNs: now, maxAgeNs: window))
    }

    @Test func theEarliestTrustedTimeReadsTimestampAndStartTimestamp() {
        let events: [RumEvent?] = [
            anEvent("x", timestamp: now - 10), anEvent("x", startTimestamp: now - 20), nil,
            anEvent("x", timestamp: 5),
        ]
        #expect(earliestTrustedEventTime(events, nowNs: now, maxAgeNs: window) == now - 20)
        #expect(earliestTrustedEventTime([anEvent("x")], nowNs: now, maxAgeNs: window) == nil)
    }
}

/// A lifecycle over a fake pool, on a clock the test moves.
private final class LifecycleDriver {
    let backend = MapStorage()
    let pool = FakeLifecyclePool()
    let ids = CountingIds()
    var nowMs = t0
    var capMs: Int64?
    lazy var session = SessionState(
        storage: SafeStorage(backend), maxDurationMs: { [unowned self] in capMs })
    lazy var lifecycle = SessionLifecycle(
        session: session, pool: pool, idGenerator: ids, clock: { [unowned self] in nowMs },
        activityEventTypes: ["interaction"], ignoredEventTypes: ["performance"])

    init(capMs: Int64? = nil) {
        self.capMs = capMs
        session.sessionId = "first"
        session.setSessionStartTime(msToNs(t0))
        pool.sessionId = { [unowned self] in session.sessionId }
        lifecycle.install()
    }
}

@Suite struct SessionLifecycleTests {
    @Test func anInteractionConfirmsTheSessionAndOpensTheSendGate() throws {
        let driver = LifecycleDriver()
        let gate = try #require(driver.pool.flushGate)
        driver.pool.add(anEvent("custom"))
        #expect(!gate(), "held until presence")
        driver.pool.add(anEvent("interaction"))
        #expect(driver.session.hasUserActivity)
        #expect(gate())
    }

    @Test func backgroundTrafficNeverConfirmsASession() {
        let driver = LifecycleDriver()
        for type in ["network", "custom", "log", "navigation", "performance"] {
            driver.pool.add(anEvent(type))
        }
        #expect(!driver.session.hasUserActivity)
    }

    @Test func rotatesOnceTheCapIsReachedButNotForAHeartbeatType() {
        let driver = LifecycleDriver(capMs: minute)
        driver.nowMs = t0 + minute
        driver.pool.add(anEvent("performance"))
        #expect(driver.session.sessionId == "first")
        driver.pool.add(anEvent("custom"))
        #expect(driver.session.sessionId != "first")
    }

    @Test func rotatesOnTheFirstInteractionAfterAGapExactlyOnce() {
        let driver = LifecycleDriver()
        driver.lifecycle.reconcile(nowMs: t0, userPresent: true)
        driver.nowMs = t0 + 31 * minute
        driver.pool.add(anEvent("custom"))
        #expect(driver.session.sessionId == "first", "only presence ends a gap")
        driver.pool.add(anEvent("interaction"))
        let rotated = driver.session.sessionId
        #expect(rotated != "first")
        driver.pool.add(anEvent("interaction"))
        #expect(driver.session.sessionId == rotated)
    }

    @Test func aConfirmedSessionFlushesItsBufferUnderTheOldId() {
        let driver = LifecycleDriver(capMs: minute)
        driver.lifecycle.reconcile(nowMs: t0, userPresent: true)
        driver.pool.add(anEvent("custom"))
        driver.nowMs = t0 + minute
        driver.pool.add(anEvent("custom"))
        #expect(driver.pool.flushedUnder == ["first"])
        #expect(driver.pool.discards == 0)
    }

    @Test func anUnconfirmedSessionDiscardsItsBufferOnRotation() {
        let driver = LifecycleDriver(capMs: minute)
        driver.pool.add(anEvent("custom"))
        driver.nowMs = t0 + minute
        driver.lifecycle.reconcile(nowMs: t0 + minute, userPresent: false)
        #expect(driver.pool.discards == 1)
        #expect(driver.pool.flushedUnder.isEmpty)
    }

    @Test func aRotationStartsAFreshUnconfirmedSessionAndRedrawsTheSamplingVerdict() {
        let driver = LifecycleDriver(capMs: minute)
        driver.backend.values[SessionKeys.sampling] = "1"
        driver.lifecycle.reconcile(nowMs: t0, userPresent: true)
        driver.nowMs = t0 + minute
        driver.lifecycle.reconcile(nowMs: t0 + minute, userPresent: false)
        #expect(driver.session.sessionId == "id-1")
        #expect(driver.session.sessionStartTimeNs == msToNs(t0 + minute))
        #expect(!driver.session.hasUserActivity)
        #expect(driver.backend.values[SessionKeys.sampling] == nil)
    }

    @Test func stampsTheRotatedSessionsStartFromTheTriggeringEvent() {
        let driver = LifecycleDriver(capMs: minute)
        driver.nowMs = t0 + minute + 10
        driver.lifecycle.reconcile(
            nowMs: t0 + minute + 10, userPresent: false,
            triggeringEvent: anEvent("custom", timestamp: msToNs(t0 + minute)))
        #expect(driver.session.sessionStartTimeNs == msToNs(t0 + minute))
    }

    @Test func aNetworkEventStartsItFromItsStartTimestamp() {
        let driver = LifecycleDriver(capMs: minute)
        driver.nowMs = t0 + minute + 10
        driver.lifecycle.reconcile(
            nowMs: t0 + minute + 10, userPresent: false,
            triggeringEvent: anEvent("network", startTimestamp: msToNs(t0 + minute + 5)))
        #expect(driver.session.sessionStartTimeNs == msToNs(t0 + minute + 5))
    }

    @Test func anEarlierEventStillInThePoolBackdatesTheNewStart() {
        // A session must never start after an event it carries: what the flush left in the pool
        // ships under the new id.
        let driver = LifecycleDriver(capMs: minute)
        driver.lifecycle.reconcile(nowMs: t0, userPresent: true)
        driver.pool.flushCanSend = false
        driver.nowMs = t0 + minute + 10
        driver.pool.buffered = [anEvent("custom", timestamp: msToNs(t0 + minute + 2))]
        driver.lifecycle.rotateIfStale(nowMs: t0 + minute + 10, reason: "test")
        #expect(driver.session.sessionStartTimeNs == msToNs(t0 + minute + 2))
    }

    @Test func stampsFromTheClockWhenNoEventDroveIt() {
        let driver = LifecycleDriver(capMs: minute)
        driver.nowMs = t0 + 2 * minute
        driver.lifecycle.rotateIfStale(nowMs: t0 + 2 * minute, reason: "test")
        #expect(driver.session.sessionStartTimeNs == msToNs(t0 + 2 * minute))
    }

    @Test func ignoresImplausibleTriggerTimesInsteadOfStartingIn1970() {
        let driver = LifecycleDriver(capMs: minute)
        let now = t0 + minute
        driver.nowMs = now
        for bogus in [0, -5, t0, msToNs(now) + 1, msToNs(now - 31 * minute)] {
            driver.session.setSessionStartTime(msToNs(t0))
            driver.lifecycle.reconcile(
                nowMs: now, userPresent: false, triggeringEvent: anEvent("custom", timestamp: bogus)
            )
            #expect(driver.session.sessionStartTimeNs == msToNs(now), "\(bogus)")
        }
    }

    @Test func doesNotRotateOnEveryEventWhenEventsCarryBogusOldTimes() {
        let driver = LifecycleDriver(capMs: minute)
        driver.nowMs = t0 + minute
        driver.pool.add(anEvent("custom", timestamp: 1))
        let rotated = driver.session.sessionId
        driver.pool.add(anEvent("custom", timestamp: 1))
        driver.pool.add(anEvent("custom", timestamp: 1))
        #expect(driver.session.sessionId == rotated)
    }

    @Test func rotateIfStaleRotatesAGappedOrCappedSessionNeverACurrentOne() {
        let driver = LifecycleDriver(capMs: minute)
        driver.lifecycle.rotateIfStale(nowMs: t0 + 1000, reason: "current")
        #expect(driver.session.sessionId == "first")
        driver.lifecycle.rotateIfStale(nowMs: t0 + minute, reason: "capped")
        #expect(driver.session.sessionId != "first")
    }

    @Test func uninstallClearsTheHookAndTheGateAfterTheHostTeardown() {
        let driver = LifecycleDriver()
        var gateDuringTeardown = false
        driver.lifecycle.uninstall(hostTeardown: {
            gateDuringTeardown = driver.pool.flushGate != nil
        })
        #expect(driver.pool.beforeEnqueue == nil)
        #expect(driver.pool.flushGate == nil)
        #expect(gateDuringTeardown, "an unconfirmed session's final batch stays held")
    }
}
