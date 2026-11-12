import Foundation
import Testing

@testable import GroundcoverRum

// App start and time to interactive: the engine's app_start signal, the tracker that holds launch
// metrics for the first screen and measures TTI from the cold start's origin (matching the RN and
// Flutter app-start tests), the event, and markAppInteractive.

private let startMs: Double = 1_800_000_000_000

private func aCold(after: Double = 850, type: String = "cold") -> AppStartSignal {
    AppStartSignal(type: type, startMs: startMs, firstFrameMs: startMs + after)
}

private func starts(_ captures: [Capture]) -> [AppStartCapture] {
    captures.compactMap {
        guard case .appStart(let start) = $0 else { return nil }
        return start
    }
}

/// A tracker on a manual executor, recording what it submits.
private final class TrackerHarness {
    let executor = ManualExecutor()
    let marks = InteractiveMarks()
    var submitted: [Capture] = []
    private(set) var tracker: AppStartTracker!

    init(manual: Bool = false) {
        tracker = AppStartTracker(
            submit: { [unowned self] in self.submitted.append($0) }, manualTti: manual,
            marks: marks, executor: executor, diagnostics: RumDiagnostics(sink: { _ in }))
    }

    var metrics: [(AppStartMetric, Int64, String)] {
        starts(submitted).map { ($0.metric, $0.valueMs, $0.navigationType) }
    }

    /// The automatic mark, as the pipeline sets it on the first screen.
    func markAuto(_ ms: Double) {
        if marks.markAuto(nowMs: Int64(ms)) { tracker.reportTtiIfReady() }
    }
}

private func anAppStartConfig(
    enabledEvents: [RumEventName]? = nil, tti: TtiMode? = nil
) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
        options: GroundcoverOptions(
            enabledEvents: enabledEvents,
            transport: TransportOptions(batchSize: 0, compression: false),
            native: NativeOptions(tti: tti)))
}

/// A pipeline on a fake engine, with marks of its own.
private func started(
    _ config: GroundcoverConfig = anAppStartConfig(), marks: InteractiveMarks = InteractiveMarks()
) -> (CorePipeline, FakePlatform, FakeNativeEngine) {
    let platform = FakePlatform()
    let engine = FakeNativeEngine()
    var services = platform.services
    services.engine = engine
    let pipeline = CorePipeline(marks: marks)
    _ = pipeline.start(config, platform: services)
    return (pipeline, platform, engine)
}

/// The engine's cold start, 2 s before now and drawn 850 ms after that.
private func emitColdStart(_ engine: FakeNativeEngine, _ platform: FakePlatform) {
    engine.emit(
        "app_start",
        [
            "type": "cold", "startMs": platform.nowMs - 2_000,
            "firstFrameMs": platform.nowMs - 1_150,
        ])
}

/// The screen an event was stamped with, as `name/key`.
private func screen(_ attributes: [String: Any]?) -> String? {
    guard let screen = attributes?["screen"] as? [String: Any] else { return nil }
    return "\(screen["name"] ?? "")/\(screen["key"] ?? "")"
}

/// What `metric` was sent with, once the pipeline has flushed: a performance event never fills a
/// batch on its own.
private func attributes(_ platform: FakePlatform, metric: String) -> [String: Any]? {
    platform.requests.flatMap(\.events)
        .compactMap { $0["attributes"] as? [String: Any] }
        .first { $0["performance_metric_name"] as? String == metric }
}

@Suite struct AppStartSignalTests {
    @Test func carriesTheTypeAndTheTwoAnchors() {
        let start = appStartOfSignal([
            "type": "hot", "startMs": startMs, "firstFrameMs": startMs + 120,
        ])
        #expect(start?.type == "hot")
        #expect(start.map { $0.firstFrameMs - $0.startMs } == 120)
    }

    @Test func oneThatBreaksTheContractIsDropped() {
        let payloads: [[String: Any]] = [
            ["startMs": startMs, "firstFrameMs": startMs],
            ["type": "cold", "startMs": "\(startMs)", "firstFrameMs": startMs],
            ["type": "cold", "startMs": startMs],
            // Past what nanoseconds hold, or no time at all: TTI's conversion would overflow.
            ["type": "cold", "startMs": -1e19, "firstFrameMs": -1e19 + 850],
            ["type": "cold", "startMs": 0, "firstFrameMs": 850],
            ["type": "cold", "startMs": startMs, "firstFrameMs": 1e17],
        ]
        for payload in payloads {
            #expect(appStartOfSignal(payload) == nil, "\(payload)")
        }
    }
}

@Suite struct AppStartTrackerTests {
    @Test func holdsALaunchMetricForTheScreenItLandedOn() {
        let harness = TrackerHarness()
        harness.tracker.onAppStart(aCold())
        #expect(harness.submitted.isEmpty)
        harness.tracker.screenKnown()
        #expect(harness.metrics.map(\.0) == [.cold])
        #expect(harness.metrics.first?.1 == 850)
        #expect(harness.metrics.first?.2 == "cold")
    }

    @Test func sendsItAnywayAfterFiveSecondsWhenNoScreenLands() {
        let harness = TrackerHarness()
        harness.tracker.onAppStart(aCold())
        harness.executor.advance(byMs: 4_999)
        #expect(harness.submitted.isEmpty)
        harness.executor.advance(byMs: 1)
        #expect(harness.metrics.map(\.0) == [.cold])
    }

    @Test func mapsEachStartTypeOntoItsMetricAndRejectsOneItDoesNotKnowRatherThanGuessTheSeries() {
        let harness = TrackerHarness()
        harness.tracker.screenKnown()
        for type in ["cold_prewarmed", "warm", "hot", "constructor"] {
            harness.tracker.onAppStart(aCold(type: type))
        }
        // The cold_prewarmed start anchors TTI, and no mark has landed.
        #expect(harness.metrics.map(\.0) == [.cold, .warm, .hot])
        #expect(harness.metrics.map(\.2) == ["cold_prewarmed", "warm", "hot"])
    }

    @Test func dropsAStartWhoseFirstFrameComesBeforeIt() {
        let harness = TrackerHarness()
        harness.tracker.screenKnown()
        harness.tracker.onAppStart(aCold(after: -5))
        #expect(harness.submitted.isEmpty)
    }

    @Test func reportsTtiOnceFromTheColdStartsOriginAtTheFirstScreen() {
        let harness = TrackerHarness()
        harness.tracker.onAppStart(aCold())
        harness.markAuto(startMs + 2_400)
        harness.tracker.screenKnown()
        harness.markAuto(startMs + 9_000)  // set once: ignored
        #expect(harness.metrics.map(\.0) == [.cold, .tti])
        #expect(harness.metrics.map(\.1) == [850, 2_400])
        #expect(harness.metrics.map(\.2) == ["cold", "cold"])
    }

    @Test func clampsTtiToTheFirstFrameSinceInteractiveBeforeVisibleIsImpossible() {
        let harness = TrackerHarness()
        harness.tracker.screenKnown()
        harness.markAuto(startMs + 100)
        harness.tracker.onAppStart(aCold())
        #expect(harness.metrics.last?.0 == .tti)
        #expect(harness.metrics.last?.1 == 850)
    }

    @Test func aHotOrWarmStartAnchorsNoTti() {
        let harness = TrackerHarness()
        harness.tracker.screenKnown()
        harness.markAuto(startMs + 2_000)
        harness.tracker.onAppStart(aCold(type: "hot"))
        harness.tracker.onAppStart(aCold(type: "warm"))
        #expect(!harness.metrics.contains { $0.0 == .tti })
    }

    @Test func inManualModeTtiWaitsForMarkAppInteractiveNeverTheScreen() {
        let harness = TrackerHarness(manual: true)
        harness.tracker.screenKnown()
        harness.markAuto(startMs + 2_000)
        harness.tracker.onAppStart(aCold())
        #expect(!harness.metrics.contains { $0.0 == .tti })
        harness.marks.markManual(nowMs: Int64(startMs) + 12_000)
        harness.tracker.reportTtiIfReady()
        #expect(harness.metrics.last?.0 == .tti)
        #expect(harness.metrics.last?.1 == 12_000)
    }

    @Test func eachMarkIsSetOnceAndTheResetClearsBoth() {
        let marks = InteractiveMarks()
        #expect(marks.markManual(nowMs: 1))
        #expect(!marks.markManual(nowMs: 2))
        #expect(marks.markAuto(nowMs: 3))
        #expect(marks.mark(manual: true) == 1)
        #expect(marks.mark(manual: false) == 3)
        marks.reset()
        #expect(marks.mark(manual: true) == nil)
        #expect(marks.mark(manual: false) == nil)
    }
}

@Suite struct AppStartPipelineTests {
    @Test func theEventIsAPerformanceMetricWithAFreshIdUnderTheAppStartGate() {
        let (pipeline, platform, _) = started()
        pipeline.presence()
        pipeline.submit(
            .appStart(
                AppStartCapture(metric: .cold, valueMs: 850, navigationType: "cold_prewarmed")))
        pipeline.flush()
        let event = platform.requests.flatMap(\.events).first
        #expect(event?["type"] as? String == "performance")
        let attributes = event?["attributes"] as? [String: Any]
        #expect(attributes?["performance_metric_name"] as? String == "app_start_cold")
        #expect(attributes?["performance_metric_value"] as? Int == 850)
        #expect((attributes?["performance_metric_id"] as? String)?.isEmpty == false)
        #expect(attributes?["performance_metric_navigation_type"] as? String == "cold_prewarmed")

        let (off, offPlatform, _) = started(anAppStartConfig(enabledEvents: [.logs]))
        off.presence()
        off.submit(.appStart(AppStartCapture(metric: .cold, valueMs: 850, navigationType: "cold")))
        off.flush()
        #expect(offPlatform.requests.isEmpty)
    }

    @Test func routesTheEnginesAppStartReleasedByTheFirstScreenWhichIsTheAutomaticTtiMark() {
        let (pipeline, platform, engine) = started()
        pipeline.presence()
        withExtendedLifetime(pipeline) { emitColdStart(engine, platform) }
        pipeline.flush()
        #expect(platform.requests.isEmpty)
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        pipeline.flush()
        let cold = attributes(platform, metric: "app_start_cold")
        let tti = attributes(platform, metric: "app_start_tti")
        #expect(cold?["performance_metric_value"] as? Int == 850)
        // Landing now, 2 s after the start.
        #expect(tti?["performance_metric_value"] as? Int == 2_000)
    }

    @Test func stampsTheColdStartAndTtiItReleasesWithTheScreenByAScreenOrAManualNavigation() {
        let lands: [Capture] = [
            .navigation(.screen(name: "Home", key: "Home-1")),
            .navigation(.start(screen: "Home", key: "Home-1", metadata: nil)),
        ]
        for land in lands {
            let (pipeline, platform, engine) = started()
            pipeline.presence()
            withExtendedLifetime(pipeline) { emitColdStart(engine, platform) }
            pipeline.submit(land)
            pipeline.flush()
            for metric in ["app_start_cold", "app_start_tti"] {
                #expect(screen(attributes(platform, metric: metric)) == "Home/Home-1", "\(metric)")
            }
        }
    }

    @Test func withNavigationEventsOffTheScreenStillStampsEveryEventAndLaunchMetricsWaitForIt() {
        let (pipeline, platform, engine) = started(
            anAppStartConfig(enabledEvents: [.logs, .appStart]))
        pipeline.presence()
        withExtendedLifetime(pipeline) { emitColdStart(engine, platform) }
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        pipeline.submit(.log(LogCapture(message: "after landing", level: .info)))
        pipeline.flush()
        let events = platform.requests.flatMap(\.events)
        #expect(!events.contains { $0["type"] as? String == "navigation" })
        let screens = events.map { event -> String in
            let attributes = event["attributes"] as? [String: Any] ?? [:]
            let metric = attributes["performance_metric_name"] as? String ?? ""
            return "\(event["type"] ?? ""):\(metric):\(screen(attributes) ?? "")"
        }
        #expect(
            screens == [
                "performance:app_start_cold:Home/Home-1", "performance:app_start_tti:Home/Home-1",
                "log::Home/Home-1",
            ])
    }

    @Test func inManualModeTheAppsMarkReleasesTtiAndTheScreenDoesnt() {
        let marks = InteractiveMarks()
        let (pipeline, platform, engine) = started(anAppStartConfig(tti: .manual), marks: marks)
        pipeline.presence()
        withExtendedLifetime(pipeline) { emitColdStart(engine, platform) }
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        pipeline.flush()
        #expect(attributes(platform, metric: "app_start_cold") != nil)
        #expect(attributes(platform, metric: "app_start_tti") == nil)
        marks.markManual(nowMs: platform.nowMs + 500)
        pipeline.interactiveMarked()
        pipeline.flush()
        let tti = attributes(platform, metric: "app_start_tti")
        #expect(tti?["performance_metric_value"] as? Int == 2_500)
    }
}

extension SharedStateTests {
    @Suite struct MarkAppInteractiveTests {
        @Test func countsBeforeStartWithWhenItWasCalledAndOnlyTheFirstCallCounts() throws {
            InteractiveMarks.shared.reset()
            defer { GroundcoverRumTesting.reset() }
            Groundcover.markAppInteractive()
            let mark = InteractiveMarks.shared.mark(manual: true)
            #expect(mark != nil)
            let platform = FakePlatform(nowMs: 1_234)
            let previous = RumRuntime.shared.replacePlatform { _ in platform.services }
            defer { RumRuntime.shared.replacePlatform(previous) }
            try Groundcover.start(anAppStartConfig())
            Groundcover.markAppInteractive()
            #expect(InteractiveMarks.shared.mark(manual: true) == mark)
        }

        @Test func inManualModeTheCallReleasesTtiOntoTheWire() throws {
            InteractiveMarks.shared.reset()
            defer { GroundcoverRumTesting.reset() }
            let platform = FakePlatform()
            let engine = FakeNativeEngine()
            let previous = RumRuntime.shared.replacePlatform { _ in
                var services = platform.services
                services.engine = engine
                return services
            }
            defer { RumRuntime.shared.replacePlatform(previous) }
            try Groundcover.start(anAppStartConfig(tti: .manual))
            RumRuntime.shared.dispatch("presence") { $0.presence() }
            emitColdStart(engine, platform)
            Groundcover.startNavigation("Home", key: "Home-1")
            #expect(attributes(platform, metric: "app_start_tti") == nil)
            Groundcover.markAppInteractive()
            RumRuntime.shared.dispatch("flush") { $0.flush() }
            // Marked now, 2 s after the start.
            let tti = attributes(platform, metric: "app_start_tti")
            #expect(tti?["performance_metric_value"] as? Int == 2_000)
        }

        @Test func afterStartReadsTheClockTheAutomaticMarkDoesAndTheResetClearsIt() throws {
            InteractiveMarks.shared.reset()
            let platform = FakePlatform(nowMs: 1_234)
            let previous = RumRuntime.shared.replacePlatform { _ in platform.services }
            defer { RumRuntime.shared.replacePlatform(previous) }
            try Groundcover.start(anAppStartConfig())
            Groundcover.markAppInteractive()
            #expect(InteractiveMarks.shared.mark(manual: true) == 1_234)
            GroundcoverRumTesting.reset()
            #expect(InteractiveMarks.shared.mark(manual: true) == nil)
            #expect(InteractiveMarks.shared.mark(manual: false) == nil)
        }
    }
}
