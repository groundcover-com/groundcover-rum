import Foundation
import Testing

@testable import GroundcoverRum

// Crashes that killed a previous run: records off the engine's disk, the drain that delivers each
// under the session it crashed in, and the snapshot the pipeline keeps current for the engine to
// file the next crash under.

/// The engine's crash store, in memory.
final class FakeCrashStore: CrashStore {
    var records: [[String: Any]]
    private(set) var snapshots: [String?] = []
    private(set) var cleared: [String] = []
    private(set) var reads = 0

    init(_ records: [[String: Any]] = []) {
        self.records = records
    }

    func updateSessionSnapshot(_ json: String?) {
        snapshots.append(json)
    }

    func pendingCrashReportsJson() -> String {
        reads += 1
        return encodeJson(records)
    }

    func clearPendingCrashReports(ids: [String]) {
        cleared += ids
        records.removeAll { ids.contains($0["id"] as? String ?? "") }
    }
}

private let crashedSession: [String: Any] = [
    "source": "mobile-rum",
    "session_id": "crashed-session",
    "session_start_time": Int64(1_690_000_000_000_000_000),
    "user": ["id": "user-123"],
    "screen": ["name": "Native", "key": "Native-1"],
]

private func aRecord(
    id: String = "r1",
    crashEpochMs: Any = 1_700_000_000_000,
    errorType: Any = "NSInvalidArgumentException",
    errorMessage: Any = "groundcover test crash (native)",
    stacktrace: Any = [["filename": "Crash.swift", "function": "boom", "lineno": 7, "colno": 0]],
    metadata: Any = ["crash_source": "kscrash"],
    snapshot: [String: Any]? = crashedSession,
    screen: Any? = nil
) -> [String: Any] {
    var record: [String: Any] = [
        "id": id, "crashEpochMs": crashEpochMs, "errorType": errorType,
        "errorMessage": errorMessage,
        "stacktrace": stacktrace, "metadata": metadata,
        "sessionSnapshotJson": snapshot.map { encodeJson($0) } ?? NSNull(),
    ]
    if let screen { record["screen"] = screen }
    return record
}

private func aCrashConfig(
    sampled: Bool = true, beforeSend: BeforeSend? = nil, enrichEvent: EnrichEvent? = nil
) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
        options: GroundcoverOptions(
            sessionSampleRate: sampled ? 1 : 0, beforeSend: beforeSend, enrichEvent: enrichEvent,
            transport: TransportOptions(batchSize: 0, compression: false)))
}

private func started(_ store: FakeCrashStore, _ config: GroundcoverConfig = aCrashConfig())
    -> (CorePipeline, FakePlatform)
{
    let platform = FakePlatform()
    var services = platform.services
    services.crashStore = store
    let pipeline = CorePipeline()
    _ = pipeline.start(config, platform: services)
    return (pipeline, platform)
}

private func decode(_ json: String??) -> [String: Any] {
    guard let json = json ?? nil else { return [:] }
    return decodeJsonObject(json) ?? [:]
}

@Suite struct CrashRecordTests {
    @Test func oneWithoutAnIdIsDroppedSinceItCouldNeverBeAcked() {
        let records = parseCrashRecords(
            encodeJson([aRecord(id: "kept"), ["errorType": "NoId"], ["id": ""], "not a record"]))
        #expect(records.map(\.id) == ["kept"])
    }

    @Test func aMalformedFieldCostsWhatAMissingOneDoes() throws {
        let record = try #require(
            parseCrashRecords(
                encodeJson([
                    aRecord(
                        crashEpochMs: "yesterday", errorType: 7, errorMessage: ["a": 1],
                        stacktrace: "frames", metadata: "meta", screen: ["name": "", "key": ""])
                ])
            ).first)
        #expect(record.crashEpochMs == nil)
        #expect(record.errorType == "")
        #expect(record.errorMessage == "")
        #expect(record.frames.isEmpty)
        #expect(record.metadata.isEmpty)
        // The engines' "couldn't read one" sentinel: the snapshot's applies.
        #expect(record.screen == nil)
    }

    @Test func aCrashTimeOfZeroOrLessIsTreatedAsUnknown() throws {
        // The engine writes 0 when the crash report had no usable time.
        for ms in [0, -1] {
            let record = try #require(
                parseCrashRecords(encodeJson([aRecord(crashEpochMs: ms)])).first)
            #expect(record.crashEpochMs == nil)
        }
    }

    @Test func outOfRangeNumbersInARecordAreDropped() throws {
        // Written in the wrong unit, or corrupt: past 2262 a nanosecond timestamp overflows.
        let record = try #require(
            parseCrashRecords(
                encodeJson([
                    aRecord(
                        crashEpochMs: 1.7e15,
                        stacktrace: [["filename": "Crash.swift", "lineno": 1e20, "colno": -5]])
                ])
            ).first)
        #expect(record.crashEpochMs == nil)
        #expect(record.frames.map(\.lineno) == [0])
        #expect(record.frames.map(\.colno) == [0])
    }

    @Test func aCorruptCauseChainIsCappedAtItsHead() throws {
        let causes = (0..<40).map { ["type": "E\($0)", "message": "\($0)"] }
        let record = try #require(
            parseCrashRecords(encodeJson([aRecord(metadata: ["causes": causes])])).first)
        let kept = record.metadata["causes"] as? [[String: Any]]
        #expect(kept?.count == 20)
        #expect(kept?.first?["type"] as? String == "E0")
    }

    @Test func unreadableJsonIsNoRecords() {
        #expect(parseCrashRecords("not json").isEmpty)
        #expect(parseCrashRecords(#"{"id": "r1"}"#).isEmpty)
    }

    @Test func aFrameWithoutAFilenameIsDroppedAndTheRestFallBack() {
        let frames = stackFrames(of: [
            ["filename": "A.swift", "function": "f", "lineno": 3, "colno": 1],
            ["function": "nameless"],
            ["filename": "B.swift", "lineno": "x"],
        ])
        #expect(frames.map(\.filename) == ["A.swift", "B.swift"])
        #expect(frames.last?.function == "")
        #expect(frames.last?.lineno == 0)
    }
}

@Suite struct CrashDrainTests {
    @Test func sendsEachRecordAsItsOwnBatchUnderTheSessionItCrashedInAtCrashTimeThenAcksIt() throws
    {
        let store = FakeCrashStore([aRecord(), aRecord(id: "r2")])
        let (pipeline, platform) = started(store)
        pipeline.nativeStarted()

        #expect(platform.requests.count == 2)
        let request = try #require(platform.requests.first)
        // Verbatim, screen aside: never the current session's envelope.
        #expect(
            encodeJson(request.sessionAttributes)
                == encodeJson(crashedSession.filter { $0.key != "screen" }))
        let event = try #require(request.events.first)
        #expect(event["type"] as? String == "exception")
        #expect(event["timestamp"] as? Int64 == 1_700_000_000_000_000_000)
        let attributes = try #require(event["attributes"] as? [String: Any])
        #expect(encodeJson(attributes["screen"]) == #"{"key":"Native-1","name":"Native"}"#)
        #expect(attributes["error_type"] as? String == "NSInvalidArgumentException")
        #expect(attributes["error_message"] as? String == "groundcover test crash (native)")
        #expect(
            attributes["error_fingerprint"] as? String
                == "NSInvalidArgumentException:groundcover test crash (native)")
        #expect(attributes["error_handled"] as? Bool == false)
        #expect(attributes["error_metadata.native"] as? Bool == true)
        #expect(attributes["error_metadata.fatal"] as? Bool == true)
        #expect(attributes["error_metadata.crash_report_id"] as? String == "r1")
        #expect(attributes["error_metadata.crash_source"] as? String == "kscrash")
        #expect(store.cleared == ["r1", "r2"])
    }

    @Test func theRecordsOwnScreenWinsOverTheSnapshots() {
        let store = FakeCrashStore([aRecord(screen: ["name": "Checkout", "key": "Checkout-2"])])
        let (pipeline, platform) = started(store)
        pipeline.nativeStarted()
        let attributes = platform.requests.first?.events.first?["attributes"] as? [String: Any]
        #expect(encodeJson(attributes?["screen"]) == #"{"key":"Checkout-2","name":"Checkout"}"#)
    }

    @Test func aRecordThatLostItsTypeAndMessageGetsTheDefaults() {
        let store = FakeCrashStore([aRecord(errorType: "", errorMessage: "")])
        let (pipeline, platform) = started(store)
        pipeline.nativeStarted()
        let attributes = platform.requests.first?.events.first?["attributes"] as? [String: Any]
        #expect(attributes?["error_type"] as? String == "NativeCrash")
        #expect(attributes?["error_message"] as? String == "Native crash")
    }

    @Test func anUndeliveredRecordStaysForTheNextLaunch() {
        let store = FakeCrashStore([aRecord()])
        let (pipeline, platform) = started(store)
        platform.sender.delivers = false
        pipeline.nativeStarted()
        #expect(platform.requests.count == 1)
        #expect(store.cleared.isEmpty)
    }

    @Test func aRecordWithNoSessionToFileItUnderIsAckedAndDroppedNeverSentUnderThisOne() {
        let store = FakeCrashStore([
            aRecord(id: "none", snapshot: nil), aRecord(id: "blank", snapshot: ["session_id": ""]),
        ])
        let (pipeline, platform) = started(store)
        pipeline.nativeStarted()
        #expect(platform.requests.isEmpty)
        #expect(store.cleared == ["none", "blank"])
    }

    @Test func beforeSendDecidesAndABrokenHookCantWedgeTheStore() {
        struct Boom: Error {}
        let cases: [(BeforeSend, Int)] = [
            ({ _ in false }, 0), ({ _ in throw Boom() }, 0), ({ _ in true }, 1),
        ]
        for (beforeSend, sent) in cases {
            let store = FakeCrashStore([aRecord()])
            let (pipeline, platform) = started(store, aCrashConfig(beforeSend: beforeSend))
            pipeline.nativeStarted()
            #expect(platform.requests.count == sent)
            // Dropped or sent, it is acked: retried, a broken hook stays broken.
            #expect(store.cleared == ["r1"])
        }
    }

    @Test func aThrowingEnrichEventCostsOnlyWhatItWouldHaveAdded() {
        struct Boom: Error {}
        let store = FakeCrashStore([aRecord()])
        let (pipeline, platform) = started(store, aCrashConfig(enrichEvent: { _ in throw Boom() }))
        pipeline.nativeStarted()
        let attributes = platform.requests.first?.events.first?["attributes"] as? [String: Any]
        #expect(attributes?["error_type"] as? String == "NSInvalidArgumentException")
        #expect(store.cleared == ["r1"])
    }

    @Test func anEnrichEventThatChangesTheReportAndThenThrowsLeavesItAsBuilt() throws {
        struct Boom: Error {}
        let store = FakeCrashStore([aRecord()])
        let (pipeline, platform) = started(
            store,
            aCrashConfig(enrichEvent: { event in
                event.timestamp = 1
                event.attributes["error_message"] = "unfinished enrichment"
                event.attributes["error_metadata.crash_report_id"] = nil
                event.attributes["error_stacktrace"] = []
                throw Boom()
            }))
        pipeline.nativeStarted()
        let event = try #require(platform.requests.first?.events.first)
        #expect(event["timestamp"] as? Int64 == 1_700_000_000_000_000_000)
        let attributes = try #require(event["attributes"] as? [String: Any])
        #expect(attributes["error_message"] as? String == "groundcover test crash (native)")
        #expect(attributes["error_metadata.crash_report_id"] as? String == "r1")
        #expect((attributes["error_stacktrace"] as? [Any])?.count == 1)
        #expect(store.cleared == ["r1"])
    }

    @Test func masksTheMessageAndTheCausesMessagesNeverTheMarkers() throws {
        let store = FakeCrashStore([
            aRecord(
                errorMessage: "request failed: password=secret",
                metadata: [
                    "password": "hunter2", "causes": [["type": "E", "message": "token: abc123"]],
                ])
        ])
        let (pipeline, platform) = started(store)
        pipeline.nativeStarted()
        let attributes = try #require(
            platform.requests.first?.events.first?["attributes"] as? [String: Any])
        #expect(!(attributes["error_message"] as? String ?? "secret").contains("secret"))
        #expect(attributes["error_metadata.password"] as? String != "hunter2")
        let causes = attributes["error_metadata.causes"] as? [[String: Any]]
        let causeMessage = causes?.first?["error_metadata.causes[0].message"] as? String
        #expect(causeMessage == "token: [REDACTED]")
        #expect(attributes["error_metadata.crash_report_id"] as? String == "r1")
    }

    @Test func deliversASampledSessionsCrashOnALaunchThatIsNotSampled() {
        let store = FakeCrashStore([aRecord()])
        let (pipeline, platform) = started(store, aCrashConfig(sampled: false))
        #expect(pipeline.sessionId == "")
        pipeline.nativeStarted()
        #expect(
            platform.requests.first?.sessionAttributes["session_id"] as? String == "crashed-session"
        )
        #expect(store.cleared == ["r1"])
    }

    @Test func onePassAtATimeSoASecondCallJoinsTheFirst() {
        let store = FakeCrashStore([aRecord()])
        let (pipeline, platform) = started(store)
        platform.sender.holdsCompletions = true
        final class Count { var value = 0 }
        let completions = Count()
        pipeline.nativeStarted { completions.value += 1 }
        pipeline.nativeStarted { completions.value += 1 }
        // Both callers hear the end of the one pass, and not before.
        #expect(completions.value == 0)
        platform.sender.releaseCompletions()
        #expect(completions.value == 2)
        #expect(store.reads == 1)
        #expect(platform.requests.count == 1)
        #expect(store.cleared == ["r1"])
    }

    @Test func aStoppedPipelineDrainsNothingWhenTheEngineRepliesLate() {
        for sampled in [true, false] {
            let store = FakeCrashStore([aRecord()])
            let (pipeline, platform) = started(store, aCrashConfig(sampled: sampled))
            pipeline.stop()
            pipeline.nativeStarted()
            #expect(store.reads == 0)
            #expect(platform.requests.isEmpty)
        }
    }

    @Test func theDeviceEngineIsTheCrashStoreAndAnsweredBeforeItsEngineIsBuilt() {
        // Production's crash store; with no engine built yet it holds no records.
        let store: CrashStore = DeviceEngine.shared
        #expect(store.pendingCrashReportsJson().hasPrefix("["))
    }
}

@Suite struct SessionSnapshotTests {
    @Test func isThisSessionsEnvelopePlusTheScreenPushedOnceTheEngineStartedAndOnEveryChange() {
        let store = FakeCrashStore()
        let (pipeline, _) = started(store)
        pipeline.nativeStarted()
        #expect(store.snapshots.count == 1)
        let first = decode(store.snapshots.first)
        #expect(first["session_id"] as? String == pipeline.sessionId)
        #expect(encodeJson(first["screen"]) == #"{"key":"","name":""}"#)

        pipeline.identifyUser(RumUser(id: "user-123"))
        #expect(encodeJson(decode(store.snapshots.last)["user"]) == #"{"id":"user-123"}"#)

        pipeline.setSessionId("fixed")
        #expect(decode(store.snapshots.last)["session_id"] as? String == "fixed")
    }

    @Test func isNotPushedAgainWhenNothingInItChanged() {
        let store = FakeCrashStore()
        let (pipeline, _) = started(store)
        pipeline.nativeStarted()
        pipeline.presence()
        pipeline.submit(.log(LogCapture(message: "a", level: .info)))
        pipeline.submit(.log(LogCapture(message: "b", level: .info)))
        #expect(store.snapshots.count == 1)
    }

    @Test func isHeldUntilTheEngineHasStartedThenTheLatestGoesOut() {
        // The engine's start pairs the previous run's crashes with the snapshot it holds, so
        // nothing of this run may reach it first: the engine starts with sessionSnapshot instead.
        let store = FakeCrashStore()
        let (pipeline, _) = started(store)
        pipeline.identifyUser(RumUser(id: "early"))
        #expect(store.snapshots.isEmpty)
        #expect(encodeJson(decode(pipeline.sessionSnapshot)["user"]) == #"{"id":"early"}"#)
        pipeline.nativeStarted()
        #expect(store.snapshots.count == 1)
        #expect(encodeJson(decode(store.snapshots.first)["user"]) == #"{"id":"early"}"#)
    }

    @Test func carriesAUserPropertyJsonHasNoFormForAsBatchesDo() {
        struct Since: CustomStringConvertible { var description: String { "2024-01-01" } }
        let store = FakeCrashStore()
        let (pipeline, _) = started(store)
        pipeline.nativeStarted()
        pipeline.identifyUser(RumUser(id: "u2", properties: ["since": Since()]))
        let user = decode(store.snapshots.last)["user"] as? [String: Any]
        #expect(user?["id"] as? String == "u2")
        #expect((user?["properties"] as? [String: Any])?["since"] as? String == "2024-01-01")
    }

    @Test func isClearedWhenThePipelineStops() {
        let store = FakeCrashStore()
        let (pipeline, _) = started(store)
        pipeline.nativeStarted()
        pipeline.stop()
        #expect(store.snapshots.count == 2)
        #expect(store.snapshots.last == .some(nil))
    }

    @Test func isNotClearedBeforeTheEngineStartedSinceThePreviousRunsCrashIsFiledUnderIt() {
        let store = FakeCrashStore()
        let (pipeline, _) = started(store)
        pipeline.stop()
        #expect(store.snapshots.isEmpty)
    }

    @Test func isNeverPushedForASessionNotSampled() {
        let store = FakeCrashStore()
        let (pipeline, _) = started(store, aCrashConfig(sampled: false))
        #expect(pipeline.sessionSnapshot == nil)
        pipeline.nativeStarted()
        #expect(store.snapshots.isEmpty)
    }
}
