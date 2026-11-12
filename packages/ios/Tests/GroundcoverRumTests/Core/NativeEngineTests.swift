import Foundation
import Testing

@testable import GroundcoverRum

// The native engine as the pipeline starts it: the option resolvers, the engine's config, and the
// start itself, for sampled and unsampled sessions.

private func anEngineConfig(
    sampled: Bool = true,
    options: GroundcoverOptions = GroundcoverOptions(
        transport: TransportOptions(batchSize: 0, compression: false))
) -> GroundcoverConfig {
    var options = options
    options.sessionSampleRate = sampled ? 1 : 0
    return GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
        options: options)
}

private func resolved(_ options: GroundcoverOptions = GroundcoverOptions()) -> ResolvedOptions {
    ConfigManager(anEngineConfig(options: options)).config.options
}

private func decode(_ json: String) -> [String: Any] {
    decodeJsonObject(json) ?? [:]
}

private func started(
    _ config: GroundcoverConfig = anEngineConfig(),
    engine: FakeNativeEngine = FakeNativeEngine(),
    store: FakeCrashStore? = nil,
    diagnostics: RumDiagnostics = .shared
) -> (CorePipeline, FakePlatform) {
    let platform = FakePlatform()
    var services = platform.services
    services.engine = engine
    services.crashStore = store
    let pipeline = CorePipeline(diagnostics: diagnostics)
    _ = pipeline.start(config, platform: services)
    return (pipeline, platform)
}

private final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []
    func append(_ line: String) {
        lock.lock()
        stored.append(line)
        lock.unlock()
    }
    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

@Suite struct NativeOptionsTests {
    @Test func theHangThresholdDefaultsToTwoSeconds() {
        #expect(resolveHangThresholdMs(nil) == 2_000)
        #expect(resolveHangThresholdMs(1.5) == 1_500)
    }

    @Test func outOfRangeFallsBackToTheDefaultRatherThanReachingTheEngine() {
        #expect(resolveHangThresholdMs(0.1) == 2_000)
        #expect(resolveHangThresholdMs(120) == 2_000)
        #expect(resolveHangThresholdMs(.nan) == 2_000)
        #expect(resolveVitalsMaxSegmentMs(nil) == 60_000)
        #expect(resolveVitalsMaxSegmentMs(2) == 2_000)
        #expect(resolveVitalsMaxSegmentMs(0.5) == 60_000)
        #expect(resolveVitalsMaxSegmentMs(360) == 60_000)
    }

    @Test func wholeMillisecondsRoundedSoBothEnginesReadOneValue() {
        #expect(resolveHangThresholdMs(1.5006) == 1_501)
    }
}

@Suite struct EngineConfigTests {
    @Test func aRecordedSessionArmsCrashesHangsAppStartAndVitalsNeverGestures() {
        let json = decode(engineConfigJson(resolved(), recording: true, snapshotJson: nil))
        #expect(
            encodeJson(json["features"])
                == #"{"appStart":true,"crashes":true,"gestures":false,"hangs":true,"vitals":true}"#)
        #expect(
            encodeJson(json["thresholds"])
                == #"{"hangThresholdMs":2000,"vitalsMaxSegmentMs":60000}"#)
        #expect(json["clearSnapshotAfterHarvest"] as? Bool == false)
    }

    @Test func aSessionNotSampledStillArmsCrashesAndClearsThePreviousRunsEnvelopeAfterTheHarvest() {
        let json = decode(engineConfigJson(resolved(), recording: false, snapshotJson: nil))
        #expect(
            encodeJson(json["features"])
                == #"{"appStart":false,"crashes":true,"gestures":false,"hangs":false,"vitals":false}"#
        )
        #expect(json["clearSnapshotAfterHarvest"] as? Bool == true)
        #expect(json["snapshotJson"] == nil)
    }

    @Test func carriesThisSessionsSnapshotWhichTheEngineInstallsRightAfterItsHarvest() {
        let json = decode(
            engineConfigJson(resolved(), recording: true, snapshotJson: #"{"session_id":"s1"}"#))
        #expect(json["snapshotJson"] as? String == #"{"session_id":"s1"}"#)
    }

    @Test func enabledEventsSwitchesEachFeatureOff() {
        let options = resolved(
            GroundcoverOptions(
                enabledEvents: [.hangs], native: NativeOptions(hangThreshold: 1)))
        let json = decode(engineConfigJson(options, recording: true, snapshotJson: nil))
        #expect(
            encodeJson(json["features"])
                == #"{"appStart":false,"crashes":false,"gestures":false,"hangs":true,"vitals":false}"#
        )
        #expect((json["thresholds"] as? [String: Any])?["hangThresholdMs"] as? Int == 1_000)
    }

    @Test func theEngineReadsTheConfigAsItIsWritten() throws {
        // The engine decodes its config on its own: a key spelt differently on either side is a
        // feature that silently never arms.
        let options = resolved(
            GroundcoverOptions(
                enabledEvents: [.crashes, .vitals],
                native: NativeOptions(hangThreshold: 1, vitalsMaxSegment: 5)))
        let config = try GCRumEngineConfig.decode(
            from: engineConfigJson(options, recording: true, snapshotJson: #"{"session_id":"s1"}"#))
        #expect(config.features.crashes)
        #expect(!config.features.hangs)
        #expect(!config.features.appStart)
        #expect(config.features.vitals)
        #expect(!config.features.gestures)
        #expect(config.thresholds.hangThresholdMs == 1_000)
        #expect(config.thresholds.vitalsMaxSegmentMs == 5_000)
        #expect(config.snapshotJson == #"{"session_id":"s1"}"#)
        #expect(config.clearSnapshotAfterHarvest == false)
    }
}

@Suite struct EngineStartTests {
    @Test func startsTheEngineOnceThePipelineHasDecidedTheSession() {
        let engine = FakeNativeEngine()
        let (pipeline, _) = started(engine: engine, store: FakeCrashStore())
        #expect(engine.calls == ["start"])
        #expect(engine.features["hangs"] as? Bool == true)
        let snapshot = decode(engine.config["snapshotJson"] as? String ?? "")
        #expect(snapshot["session_id"] as? String == pipeline.sessionId)
    }

    @Test func startsTheEngineForASessionNotSampledTooCrashesOnly() {
        let engine = FakeNativeEngine()
        _ = started(anEngineConfig(sampled: false), engine: engine)
        #expect(engine.calls == ["start"])
        #expect(engine.features["crashes"] as? Bool == true)
        #expect(engine.features["hangs"] as? Bool == false)
        #expect(engine.config["clearSnapshotAfterHarvest"] as? Bool == true)
    }

    @Test func drainsOnceTheEngineHasStartedSinceItsStartIsTheHarvest() {
        let engine = FakeNativeEngine()
        engine.holdsStart = true
        let store = FakeCrashStore()
        let (pipeline, _) = started(engine: engine, store: store)
        #expect(store.reads == 0)
        withExtendedLifetime(pipeline) { engine.finishStart() }
        #expect(store.reads == 1)
    }

    @Test func drainsForASessionNotSampledToo() {
        let store = FakeCrashStore()
        _ = started(anEngineConfig(sampled: false), store: store)
        #expect(store.reads == 1)
    }

    @Test func aStopBeforeTheEngineRepliedDrainsNothing() {
        let engine = FakeNativeEngine()
        engine.holdsStart = true
        let store = FakeCrashStore()
        let (pipeline, _) = started(engine: engine, store: store)
        pipeline.stop()
        withExtendedLifetime(pipeline) { engine.finishStart() }
        #expect(store.reads == 0)
    }

    @Test func nothingOfThisRunReachesTheEngineBeforeItsStartReplied() {
        let engine = FakeNativeEngine()
        engine.holdsStart = true
        let store = FakeCrashStore()
        let (pipeline, _) = started(engine: engine, store: store)
        // A change while the engine is still starting waits for it too.
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        #expect(store.snapshots.isEmpty)
        withExtendedLifetime(pipeline) { engine.finishStart() }
        let latest = decode(store.snapshots.last.flatMap { $0 } ?? "")
        #expect(encodeJson(latest["screen"]) == #"{"key":"Home-1","name":"Home"}"#)
    }

    @Test func warnsWhenCrashCaptureWasAskedForAndIsUnavailable() {
        let lines = Lines()
        let engine = FakeNativeEngine()
        engine.status = NativeEngineStatus(crashesUnavailable: "KSCrash is already installed")
        _ = started(engine: engine, diagnostics: RumDiagnostics(sink: lines.append))
        let warnings = lines.all.filter { $0.contains("native crash capture is unavailable") }
        #expect(warnings.count == 1)
        #expect(warnings.first?.contains("KSCrash is already installed") == true)
    }

    @Test func doesntWarnForASessionNotSampledWhichReportsNothingAnyway() {
        let lines = Lines()
        let engine = FakeNativeEngine()
        engine.status = NativeEngineStatus(crashesUnavailable: "KSCrash is already installed")
        _ = started(
            anEngineConfig(sampled: false), engine: engine,
            diagnostics: RumDiagnostics(sink: lines.append))
        #expect(lines.all.filter { $0.contains("native crash capture is unavailable") }.isEmpty)
    }

    @Test func stoppingThePipelineStopsTheEngine() {
        for sampled in [true, false] {
            let engine = FakeNativeEngine()
            let (pipeline, _) = started(anEngineConfig(sampled: sampled), engine: engine)
            pipeline.stop()
            #expect(engine.calls == ["start", "stop"])
        }
    }

    @Test func theTestingResetStopsTheEngineAndAStartAfterItStartsItAfresh() throws {
        let engine = FakeNativeEngine()
        let platform = FakePlatform()
        let runtime = RumRuntime(makePlatform: { _ in
            var services = platform.services
            services.engine = engine
            return services
        })
        try runtime.start(anEngineConfig())
        runtime.reset()
        #expect(engine.calls == ["start", "stop"])
        try runtime.start(anEngineConfig())
        #expect(engine.calls == ["start", "stop", "start"])
    }
}
