import Foundation
import Testing

@testable import GroundcoverRum

// The events pool: batching on size, on a timer and on demand; the hooks; the send gate and the
// cluster that hold a buffer, and the bound on what they hold; the batch envelope.

private let t0: Int64 = 1_800_000_000_000

func aConfig(
    cluster: String = "c",
    apiKey: String = "k",
    batchSize: Int? = nil,
    batchTimeout: TimeInterval? = nil,
    compression: Bool? = false,
    debug: Bool = false,
    beforeSend: BeforeSend? = nil,
    enrichEvent: EnrichEvent? = nil
) -> ConfigManager {
    ConfigManager(
        GroundcoverConfig(
            apiKey: apiKey, dsn: "ingest.example", cluster: cluster, environment: "e", appId: "a",
            options: GroundcoverOptions(
                debug: debug, beforeSend: beforeSend, enrichEvent: enrichEvent,
                transport: TransportOptions(
                    batchSize: batchSize, batchTimeout: batchTimeout, compression: compression))))
}

private final class PoolHarness {
    let platform = FakePlatform(nowMs: t0)
    let config: ConfigManager
    let session: SessionState
    let pool: EventsPool
    let enricher = EventEnricher(idGenerator: RandomIdGenerator(), clock: { t0 })

    init(
        _ config: ConfigManager, skip: Set<String> = [],
        device: (() throws -> [String: Any])? = nil
    ) {
        self.config = config
        session = SessionState(storage: SafeStorage(platform.storage))
        session.sessionId = "s1"
        session.setSessionStartTime(msToNs(t0))
        let platform = platform
        pool = EventsPool(
            config: config, session: session,
            transporter: Transporter(
                config: config, sender: platform.sender, executor: platform.executor),
            deviceAttributes: device ?? { ["source": "mobile-rum"] }, eventsToSkipFlush: skip,
            executor: platform.executor)
        pool.initialize()
    }

    func event(_ type: String, _ attributes: [String: Any] = [:]) -> RumEvent {
        enricher.enrich(EnrichInput(type: type, attributes: attributes))
    }
}

@Suite struct EventsPoolTests {
    @Test func flushesOnceTheBatchSizeIsReached() {
        let h = PoolHarness(aConfig(batchSize: 2))
        h.pool.addEvent(h.event("custom"))
        #expect(h.platform.requests.isEmpty)
        h.pool.addEvent(h.event("custom"))
        #expect(h.platform.requests.count == 1)
        #expect(h.platform.requests.first?.events.count == 2)
    }

    @Test func anExplicitBatchSizeOf0SendsEveryEventAndANegativeOneIsIgnored() {
        let zero = PoolHarness(aConfig(batchSize: 0))
        zero.pool.addEvent(zero.event("custom"))
        #expect(zero.platform.requests.count == 1)

        let negative = PoolHarness(aConfig(batchSize: -1))
        negative.pool.addEvent(negative.event("custom"))
        #expect(negative.platform.requests.isEmpty, "falls back to 10")
    }

    @Test func skipFlushTypesRideAlongWithTheNextFlushingEvent() {
        let h = PoolHarness(aConfig(batchSize: 1), skip: ["interaction"])
        h.pool.addEvent(h.event("interaction"))
        #expect(h.platform.requests.isEmpty)
        h.pool.addEvent(h.event("custom"))
        #expect(h.platform.types == ["interaction", "custom"])
    }

    @Test func theTimerFlushesAndStaysArmedThroughAnEmptyWindow() {
        let h = PoolHarness(aConfig(batchTimeout: 2))
        h.platform.executor.advance(byMs: 2000)
        h.pool.addEvent(h.event("custom"))
        h.platform.executor.advance(byMs: 2000)
        #expect(h.platform.requests.count == 1)
    }

    // An idle app (a reading app on a static screen, an audio app in the background) has nothing
    // to send; a timer that re-armed itself every window would wake the core queue for nothing.
    @Test func anEmptyBufferArmsNoTimerUntilTheNextEvent() {
        let h = PoolHarness(aConfig(batchTimeout: 2))
        h.platform.executor.advance(byMs: 2000)
        #expect(h.platform.executor.pendingCount == 0)

        h.pool.addEvent(h.event("custom"))
        #expect(h.platform.executor.pendingCount == 1)
        h.platform.executor.advance(byMs: 2000)
        #expect(h.platform.requests.count == 1)
        #expect(h.platform.executor.pendingCount == 0)
    }

    @Test func aSizeFlushLeavesNoTimerBehind() {
        let h = PoolHarness(aConfig(batchSize: 2, batchTimeout: 2))
        h.pool.addEvent(h.event("custom"))
        h.pool.addEvent(h.event("custom"))
        #expect(h.platform.requests.count == 1)
        #expect(h.platform.executor.pendingCount == 0)
    }

    @Test func aHeldBufferKeepsItsTimer() {
        let h = PoolHarness(aConfig(batchTimeout: 2))
        var open = false
        h.pool.setFlushGate { open }
        h.pool.addEvent(h.event("custom"))
        h.platform.executor.advance(byMs: 2000)
        #expect(h.platform.requests.isEmpty)
        open = true
        h.platform.executor.advance(byMs: 2000)
        #expect(h.platform.requests.count == 1)
    }

    @Test func aZeroBatchTimeoutFallsBackToThe10SecondDefault() {
        let h = PoolHarness(aConfig(batchTimeout: 0))
        h.pool.addEvent(h.event("custom"))
        h.platform.executor.advance(byMs: 9000)
        #expect(h.platform.requests.isEmpty)
        h.platform.executor.advance(byMs: 1000)
        #expect(h.platform.requests.count == 1)
    }

    @Test func aTimeoutUnderAMillisecondFallsBackToTheDefaultToo() {
        // In seconds, 0.0001 rounds to a 0 ms timer, which would busy-flush.
        let h = PoolHarness(aConfig(batchTimeout: 0.0001))
        h.pool.addEvent(h.event("custom"))
        h.platform.executor.advance(byMs: 9000)
        #expect(h.platform.requests.isEmpty)
        h.platform.executor.advance(byMs: 1000)
        #expect(h.platform.requests.count == 1)
    }

    @Test func aTimeoutPastTheMillisecondRangeWaitsInsteadOfCrashing() {
        let h = PoolHarness(aConfig(batchTimeout: 1e17))
        h.pool.addEvent(h.event("custom"))
        h.platform.executor.advance(byMs: 86_400_000)
        #expect(h.platform.requests.isEmpty)
    }

    @Test func holdsTheBufferWithoutAClusterAndSendsOnceOneIsSet() {
        let h = PoolHarness(aConfig(cluster: ""))
        h.pool.addEvent(h.event("custom"))
        h.pool.flush()
        #expect(h.platform.requests.isEmpty)
        h.config.update(GroundcoverConfigUpdate(cluster: "later"))
        h.pool.flush()
        #expect(h.platform.requests.first?.sessionAttributes["cluster"] as? String == "later")
    }

    @Test func whileGatedHoldsUpTo500EventsAndDropsTheNewest() {
        let h = PoolHarness(aConfig())
        h.pool.setFlushGate { false }
        for index in 0..<(maxGatedBufferEvents + 5) {
            h.pool.addEvent(h.event("custom", ["i": index]))
        }
        h.pool.setFlushGate(nil)
        h.pool.flush()
        let sent = h.platform.requests.first?.events ?? []
        #expect(sent.count == maxGatedBufferEvents)
        #expect(
            (sent.last?["attributes"] as? [String: Any])?["i"] as? Int == maxGatedBufferEvents - 1)
    }

    @Test func withoutAClusterHoldsUpTo500EventsAndDropsTheNewest() {
        // A missing cluster must not let the buffer grow without bound.
        let h = PoolHarness(aConfig(cluster: ""))
        for index in 0..<(maxGatedBufferEvents + 5) {
            h.pool.addEvent(h.event("custom", ["i": index]))
        }
        #expect(h.platform.requests.isEmpty)
        h.config.update(GroundcoverConfigUpdate(cluster: "later"))
        h.pool.flush()
        let sent = h.platform.requests.first?.events ?? []
        #expect(sent.count == maxGatedBufferEvents)
        #expect(
            (sent.last?["attributes"] as? [String: Any])?["i"] as? Int == maxGatedBufferEvents - 1)
    }

    @Test func beforeSendDropsWhatItRejectsAndAThrowingHookDropsTheEvent() {
        struct Boom: Error {}
        let h = PoolHarness(
            aConfig(beforeSend: { event in
                if event.attributes["boom"] as? Bool == true { throw Boom() }
                return event.attributes["drop"] as? Bool != true
            }))
        h.pool.addEvent(h.event("custom", ["drop": true]))
        h.pool.addEvent(h.event("custom", ["boom": true]))
        h.pool.addEvent(h.event("custom", ["keep": true]))
        h.pool.flush()
        #expect(h.platform.requests.first?.events.count == 1)
    }

    @Test func enrichEventSeesDotFlattenedAttributesAndItsResultShips() {
        final class Seen: @unchecked Sendable { var value: Any? }
        let seen = Seen()
        let h = PoolHarness(
            aConfig(enrichEvent: { event in
                seen.value = event.attributes["nested.key"]
                event.attributes["added"] = 1
                return event
            }))
        h.pool.addEvent(h.event("custom", ["nested": ["key": "v"]]))
        h.pool.flush()
        #expect(seen.value as? String == "v")
        let attributes = h.platform.requests.first?.events.first?["attributes"] as? [String: Any]
        #expect(attributes?["added"] as? Int == 1)
    }

    @Test func whatAHookPutsInShipsAsJsonAndTheBatchIsKept() {
        struct Profile: CustomStringConvertible { var description: String { "profile #7" } }
        let loop = NSMutableDictionary(dictionary: ["a": 1])
        loop["self"] = loop
        let h = PoolHarness(
            aConfig(enrichEvent: { event in
                event.attributes["profile"] = Profile()
                event.attributes["loop"] = loop
                return event
            }))
        h.pool.addEvent(h.event("custom", ["keep": true]))
        h.pool.flush()
        let attributes = h.platform.requests.first?.events.first?["attributes"] as? [String: Any]
        #expect(attributes?["keep"] as? Bool == true)
        #expect(attributes?["profile"] as? String == "profile #7")
        #expect((attributes?["loop"] as? [String: Any])?["self"] as? String == "[Circular]")
    }

    @Test func hooksRunInTheUserHookScope() {
        final class Seen: @unchecked Sendable { var running: [Bool] = [] }
        let seen = Seen()
        let h = PoolHarness(
            aConfig(
                beforeSend: { _ in
                    seen.running.append(UserHook.isRunning)
                    return true
                },
                enrichEvent: { event in
                    seen.running.append(UserHook.isRunning)
                    return event
                }))
        h.pool.addEvent(h.event("custom"))
        #expect(seen.running == [true, true])
        #expect(!UserHook.isRunning)
    }

    @Test func flushSyncDiscardsAGatedBufferInsteadOfCarryingItAcrossAnIdChange() {
        let h = PoolHarness(aConfig())
        h.pool.setFlushGate { false }
        h.pool.addEvent(h.event("custom"))
        h.pool.flushSync()
        h.pool.setFlushGate(nil)
        h.pool.flush()
        #expect(h.platform.requests.isEmpty)
    }

    @Test func flushSyncClearsTheBufferBeforeItsSendSoAnEventAddedMeanwhileIsKept() {
        let h = PoolHarness(aConfig(batchSize: 100))
        h.pool.addEvent(h.event("custom", ["n": 1]))
        h.platform.sender.onSend = { [unowned h] in
            h.platform.sender.onSend = nil
            h.pool.addEvent(h.event("custom", ["n": 2]))
        }
        h.pool.flushSync()
        h.pool.flush()
        #expect(h.platform.requests.count == 2)
        #expect(
            (h.platform.requests.last?.events.first?["attributes"] as? [String: Any])?["n"] as? Int
                == 2)
    }

    @Test func theEnvelopePutsSessionIdentityOverAnythingTheDeviceProvides() {
        let h = PoolHarness(
            aConfig(),
            device: { ["source": "mobile-rum", "session_id": "spoofed", "cluster": "spoofed"] })
        let attributes = h.pool.sessionAttributes()
        #expect(attributes["session_id"] as? String == "s1")
        #expect(attributes["cluster"] as? String == "c")
        #expect(attributes["source"] as? String == "mobile-rum")
        #expect(attributes["session_start_time"] as? Int64 == msToNs(t0))
        #expect((attributes["user"] as? [String: Any])?.isEmpty == true)
        #expect(attributes["service.name"] as? String == "a")
        #expect(attributes["namespace"] as? String == "")
        #expect(attributes["releaseId"] as? String == "")
    }

    @Test func aThrowingDeviceProviderCostsOnlyTheDevicePart() {
        struct Boom: Error {}
        let h = PoolHarness(aConfig(), device: { throw Boom() })
        let attributes = h.pool.sessionAttributes()
        #expect(attributes["session_id"] as? String == "s1")
        #expect(attributes["source"] == nil)
    }

    @Test func theEnvelopeCarriesOnlyTheUserFieldsSet() {
        let config = ConfigManager(
            GroundcoverConfig(
                apiKey: "k", dsn: "d", cluster: "c", environment: "e", appId: "a",
                user: RumUser(id: "u1", email: "a@b")))
        let h = PoolHarness(config)
        #expect(encodeJson(h.pool.sessionAttributes()["user"]) == #"{"email":"a@b","id":"u1"}"#)
    }
}
