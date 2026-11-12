import Foundation
import Testing

@testable import GroundcoverRum

// Hangs from the native engine: signal validation, the event (matching the RN and Flutter hang
// tests), and the pipeline that ships them.

private func aHang(
    kind: HangKind = .anr, startedAtMs: Double = 1_700_000_000_000, durationMs: Double = 5_210,
    frames: [ErrorFrame] = []
) -> HangCapture {
    HangCapture(kind: kind, startedAtMs: startedAtMs, durationMs: durationMs, frames: frames)
}

private func hangOf(_ payload: [String: Any]) -> HangCapture? {
    guard case .hang(let hang) = captureOfSignal("hang", payload) else { return nil }
    return hang
}

private let aHangPayload: [String: Any] = [
    "kind": "app_hang", "startedAtMs": 1_700_000_000_000, "durationMs": 3_000,
]

private func shaped(_ hang: HangCapture) -> [String: Any] {
    shapeHangEvent(hang).attributes
}

private func aHangConfig(
    sampled: Bool = true, enabledEvents: [RumEventName]? = nil,
    transport: TransportOptions = TransportOptions(batchSize: 0, compression: false)
) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
        options: GroundcoverOptions(
            enabledEvents: enabledEvents, sessionSampleRate: sampled ? 1 : 0,
            transport: transport))
}

/// A pipeline past the presence gate, on a fake engine.
private func started(
    _ config: GroundcoverConfig = aHangConfig(), engine: FakeNativeEngine = FakeNativeEngine()
) -> (CorePipeline, FakePlatform) {
    let platform = FakePlatform()
    var services = platform.services
    services.engine = engine
    let pipeline = CorePipeline()
    _ = pipeline.start(config, platform: services)
    pipeline.presence()
    return (pipeline, platform)
}

private func events(_ platform: FakePlatform) -> [[String: Any]] {
    platform.requests.flatMap(\.events)
}

@Suite struct HangSignalTests {
    @Test func aHangSignalIsAHangCaptureWithItsStack() {
        let hang = hangOf([
            "kind": "anr", "startedAtMs": 1_700_000_000_000, "durationMs": 3_010,
            "mainThreadStack": [
                [
                    "filename": "com.acme.Checkout", "function": "computeTotals", "lineno": 142,
                    "colno": 0,
                ]
            ],
        ])
        #expect(hang?.kind == .anr)
        #expect(hang?.durationMs == 3_010)
        #expect(hang?.frames.map(\.function) == ["computeTotals"])
    }

    @Test func iosAppHangCarriesNoStack() {
        let hang = hangOf([
            "kind": "app_hang", "startedAtMs": 1_700_000_000_000.25, "durationMs": 2_500.5,
        ])
        #expect(hang?.kind == .appHang)
        #expect(hang?.startedAtMs == 1_700_000_000_000.25)
        #expect(hang?.frames.isEmpty == true)
    }

    @Test func aSignalThatBreaksTheContractIsDroppedNotRepaired() {
        let payloads: [[String: Any]] = [
            ["kind": "anr", "durationMs": 3_000],
            ["kind": "anr", "startedAtMs": "1700000000000", "durationMs": 3_000],
            ["kind": "anr", "startedAtMs": 1_700_000_000_000, "durationMs": NSNull()],
            ["kind": "anr", "startedAtMs": 1_700_000_000_000, "durationMs": true],
            // Past what nanoseconds hold, or no time at all: placing it would overflow or lie.
            ["kind": "anr", "startedAtMs": 1e17, "durationMs": 3_000],
            ["kind": "anr", "startedAtMs": 0, "durationMs": 3_000],
        ]
        for payload in payloads {
            #expect(captureOfSignal("hang", payload) == nil, "\(payload)")
        }
    }

    @Test func kindsWithNothingToCaptureYieldNothing() {
        #expect(captureOfSignal("ping", [:]) == nil)
        #expect(captureOfSignal("gesture", ["kind": "tap"]) == nil)
    }
}

@Suite struct HangEventTests {
    @Test func isAnExceptionTheShapeACrashOrAnErrorUses() {
        let input = shapeHangEvent(aHang())
        #expect(input.type == "exception")
        let attributes = input.attributes
        #expect(attributes["error_type"] as? String == "ANR")
        #expect(attributes["error_message"] as? String == "Main thread blocked for 5210ms")
        // Nobody handled it: the user watched a frozen app.
        #expect(attributes["error_handled"] as? Bool == false)
        #expect(
            encodeJson(attributes["error_metadata"])
                == #"{"hang_duration_ms":5210,"hang_started_at":1700000000000,"native":true,"recovered":true}"#
        )
    }

    @Test func isPlacedAtTheStallsOnsetNotWhenItsRecoveryArrived() {
        #expect(
            shapeHangEvent(aHang(startedAtMs: 1_699_000_000_000.5)).timestamp
                == 1_699_000_000_000_500_000)
    }

    @Test func usesEachPlatformsOwnNameForTheStall() {
        #expect(shaped(aHang(kind: .appHang))["error_type"] as? String == "AppHang")
    }

    @Test func fingerprintsByDurationBucketSoRepeatsGroupIntoOneIssue() {
        #expect(shaped(aHang(durationMs: 5_210))["error_fingerprint"] as? String == "ANR:5s")
        #expect(shaped(aHang(durationMs: 5_940))["error_fingerprint"] as? String == "ANR:5s")
        #expect(shaped(aHang(durationMs: 700))["error_fingerprint"] as? String == "ANR:<1s")
        #expect(shaped(aHang(durationMs: 120_000))["error_fingerprint"] as? String == "ANR:30s+")
    }

    @Test func carriesTheMainThreadStackWhenThereIsOne() {
        let frame = ErrorFrame(
            filename: "com.acme.Checkout", function: "computeTotals", lineno: 142, colno: 0)
        let stack = shaped(aHang(frames: [frame]))["error_stacktrace"]
        #expect(
            encodeJson(stack)
                == #"[{"colno":0,"filename":"com.acme.Checkout","function":"computeTotals","lineno":142}]"#
        )
    }
}

@Suite struct HangPipelineTests {
    @Test func sendsAHangAtOnceWhateverTheBatchSettingsSinceAHangOftenComesJustBeforeAKill() {
        let (pipeline, platform) = started(
            aHangConfig(
                transport: TransportOptions(batchSize: 100, batchTimeout: 300, compression: false)))
        pipeline.submit(.hang(aHang()))
        #expect(platform.types == ["exception"])
        let attributes = events(platform).first?["attributes"] as? [String: Any]
        #expect(attributes?["error_type"] as? String == "ANR")
        #expect(attributes?["error_metadata.recovered"] as? Bool == true)
    }

    @Test func dropsHangsThatEnabledEventsLeavesOut() {
        let (pipeline, platform) = started(aHangConfig(enabledEvents: [.logs]))
        pipeline.submit(.hang(aHang()))
        pipeline.flush()
        #expect(platform.requests.isEmpty)
    }

    @Test func routesTheEnginesHangsAndNothingElse() {
        let engine = FakeNativeEngine()
        let (pipeline, platform) = started(engine: engine)
        final class Count { var value = 0 }
        let work = Count()
        pipeline.onEngineWork = { work.value += 1 }
        withExtendedLifetime(pipeline) {
            engine.emit("hang", aHangPayload)
            engine.emit("ping", [:])
            engine.emit("hang", ["kind": "app_hang"])
        }
        #expect(platform.types == ["exception"])
        // The runtime hears of the work, which can have rotated the session.
        #expect(work.value == 1)
    }

    @Test func aSessionNotSampledReportsNoHang() {
        let engine = FakeNativeEngine()
        let (pipeline, platform) = started(aHangConfig(sampled: false), engine: engine)
        withExtendedLifetime(pipeline) { engine.emit("hang", aHangPayload) }
        #expect(platform.requests.isEmpty)
    }

    @Test func aStoppedPipelineStopsListeningToTheEngine() {
        let engine = FakeNativeEngine()
        let (pipeline, _) = started(engine: engine)
        #expect(engine.onSignal != nil)
        pipeline.stop()
        #expect(engine.onSignal == nil)
    }
}
