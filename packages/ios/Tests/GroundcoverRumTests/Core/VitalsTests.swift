import Foundation
import Testing

@testable import GroundcoverRum

// Frame vitals from the native engine: the frame_segment payload (RN's vitals listener), the
// pipeline's segment path (as the Flutter SDK tests it), and the screen boundaries that close a
// segment under the screen it was drawn on.

private func aSegment(
    total: Int = 10, slow: Int = 2, screen: String = "Native",
    reason: FrameSegmentReason = .navigation, startMs: Int64 = 1_800_000_000_000,
    endMs: Int64 = 1_800_000_005_000
) -> Capture {
    .frameSegment(
        FrameSegmentCapture(
            startMs: startMs, endMs: endMs, total: total, slow: slow, frozen: 1, refreshRate: 60,
            delayMs: 26.6667, budgetMs: 16.6667, reason: reason, screenName: screen,
            screenKey: "\(screen)-1"))
}

/// The engine's `frame_segment` payload, as both engines write it.
private func aPayload(reason: String = "background") -> [String: Any] {
    [
        "segmentStartMs": 1_800_000_000_000.0, "segmentEndMs": 1_800_000_005_000.0, "total": 300,
        "slow": 4, "frozen": 1, "refreshRate": 60.0, "delayMs": 41.5, "budgetMs": 16.6667,
        "reason": reason,
    ]
}

private func aVitalsConfig(enabledEvents: [RumEventName]? = nil) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
        options: GroundcoverOptions(
            enabledEvents: enabledEvents,
            transport: TransportOptions(batchSize: 0, compression: false)))
}

/// A pipeline past the presence gate, on a fake engine.
private func started(_ config: GroundcoverConfig = aVitalsConfig()) -> (
    CorePipeline, FakePlatform, FakeNativeEngine
) {
    let platform = FakePlatform()
    let engine = FakeNativeEngine()
    var services = platform.services
    services.engine = engine
    let pipeline = CorePipeline(marks: InteractiveMarks())
    _ = pipeline.start(config, platform: services)
    pipeline.presence()
    return (pipeline, platform, engine)
}

private func performance(_ platform: FakePlatform) -> [[String: Any]] {
    platform.requests.flatMap(\.events)
        .filter { $0["type"] as? String == "performance" }
        .compactMap { $0["attributes"] as? [String: Any] }
}

/// The screen each shipped segment was stamped with.
private func shippedScreens(_ platform: FakePlatform) -> [String] {
    performance(platform).compactMap { ($0["screen"] as? [String: Any])?["name"] as? String }
}

@Suite struct FrameSegmentSignalTests {
    @Test func aPayloadIsASegmentOnTheScreenItIsGiven() throws {
        let segment = try #require(
            frameSegmentOf(aPayload(), screenName: "Native", screenKey: "Native-1"))
        #expect(segment.startMs == 1_800_000_000_000)
        #expect(segment.endMs == 1_800_000_005_000)
        #expect(segment.total == 300)
        #expect(segment.slow == 4)
        #expect(segment.frozen == 1)
        #expect(segment.delayMs == 41.5)
        #expect(segment.reason == .background)
        #expect(segment.screenName == "Native")
        #expect(segment.screenKey == "Native-1")
    }

    @Test func oneThatBreaksTheContractIsDroppedNotRepaired() {
        var broken: [[String: Any]] = []
        for key in ["segmentStartMs", "segmentEndMs", "total", "slow", "frozen", "delayMs"] {
            var payload = aPayload()
            payload[key] = nil
            broken.append(payload)
        }
        var negative = aPayload()
        negative["delayMs"] = -1
        var text = aPayload()
        text["segmentStartMs"] = "1800000000000"
        broken += [aPayload(reason: "resize"), negative, text]
        for payload in broken {
            #expect(frameSegmentOf(payload, screenName: "a", screenKey: "") == nil, "\(payload)")
        }
    }

    @Test func aSmoothSegmentsZeroDelayIsAMeasurementAndAMissingBudgetIsNoBudget() {
        var payload = aPayload()
        payload["delayMs"] = 0
        payload["budgetMs"] = nil
        let segment = frameSegmentOf(payload, screenName: "a", screenKey: "")
        #expect(segment?.delayMs == 0)
        let attributes = segment.map { shapeFrameSegmentEvent($0, metricId: "m").attributes }
        #expect(attributes?["performance_frame_budget_ms"] == nil)
        #expect(attributes?["performance_metric_value"] as? Double == 0)
    }
}

@Suite struct FrameSegmentPipelineTests {
    @Test func shipsOneFramesDelayTotalPerSegmentAtItsEndUnderTheScreenItWasDrawnOn() throws {
        let (pipeline, platform, _) = started()
        pipeline.submit(.navigation(.screen(name: "Logs", key: "Logs-1")))
        pipeline.submit(aSegment())
        pipeline.flush()
        let event = try #require(
            platform.requests.flatMap(\.events).first { $0["type"] as? String == "performance" })
        #expect(event["timestamp"] as? Int64 == 1_800_000_005_000_000_000)
        let attributes = try #require(event["attributes"] as? [String: Any])
        #expect(encodeJson(attributes["screen"]) == #"{"key":"Native-1","name":"Native"}"#)
        #expect(attributes["performance_metric_name"] as? String == "frames_delay_total")
        #expect(attributes["performance_metric_value"] as? Double == 26.67)
        #expect(attributes["performance_metric_id"] is String)
        #expect(attributes["performance_metric_navigation_type"] as? String == "")
        #expect(attributes["performance_refresh_rate_hz"] as? Double == 60)
        #expect(attributes["performance_frame_budget_ms"] as? Double == 16.67)
        #expect(attributes["performance_segment_reason"] as? String == "navigation")
        #expect(attributes["start_timestamp"] as? Int64 == 1_800_000_000_000_000_000)
        #expect(attributes["end_timestamp"] as? Int64 == 1_800_000_005_000_000_000)
        #expect(attributes["performance_frames_slow"] as? Int == 2)
        #expect(attributes["performance_frames_frozen"] as? Int == 1)
        // No count and no rate: platforms don't count the same frames.
        #expect(attributes["performance_frames_total"] == nil)
    }

    @Test func dropsAnEmptySegment() {
        let (pipeline, platform, _) = started()
        pipeline.submit(aSegment(total: 0))
        pipeline.flush()
        #expect(performance(platform).isEmpty)
    }

    @Test func dropsASegmentThatStartedBeforeASessionRotation() {
        let (pipeline, platform, _) = started()
        platform.nowMs += 60_000
        pipeline.setSessionId("next")
        // A user is there, so the new session's batches can ship.
        pipeline.presence()
        // Started under the session that rotated away, and the pool stamps the session at send
        // time, so it would ship under the new one.
        pipeline.submit(aSegment())
        pipeline.submit(
            aSegment(screen: "Logs", startMs: platform.nowMs, endMs: platform.nowMs + 5_000))
        pipeline.flush()
        #expect(shippedScreens(platform) == ["Logs"])
    }

    @Test func keepsTheFirstSegmentDrawnWhollyInTheSessionAfterARotation() {
        let (pipeline, platform, _) = started()
        pipeline.submit(aSegment())
        // Away for longer than the inactivity gap, back to a new session.
        platform.nowMs += 40 * 60_000
        pipeline.setSessionId("next")
        pipeline.presence()
        pipeline.submit(
            aSegment(screen: "Logs", startMs: platform.nowMs, endMs: platform.nowMs + 5_000))
        pipeline.flush()
        #expect(shippedScreens(platform) == ["Native", "Logs"])
    }

    @Test func dropsASegmentWhileTheSessionIsInactive() {
        let (pipeline, platform, _) = started()
        // Past the 30-minute inactivity gap, with no new presence.
        platform.nowMs += 31 * 60_000
        pipeline.submit(aSegment())
        pipeline.flush()
        #expect(performance(platform).isEmpty)
    }

    @Test func keepsTheFirstSegmentAfterAReturnThatRotatedTheSession() {
        // The engine restarts its segment as the app returns; the session rotates a moment later,
        // when the return reaches the core queue. That segment holds only post-return frames.
        let (pipeline, platform, _) = started()
        pipeline.lifecycle(.background)
        let leftAt = platform.nowMs
        platform.nowMs += 40 * 60_000
        let restartedAt = platform.nowMs - 300
        pipeline.lifecycle(.foreground)
        pipeline.submit(
            aSegment(screen: "Logs", startMs: restartedAt, endMs: platform.nowMs + 5_000))
        // One that started before the app left measured the old session, and stays dropped.
        pipeline.submit(aSegment(startMs: leftAt - 1_000, endMs: leftAt))
        pipeline.flush()
        #expect(shippedScreens(platform) == ["Logs"])
    }

    @Test func enabledEventsWithoutVitalsSendsNone() {
        let (pipeline, platform, _) = started(aVitalsConfig(enabledEvents: [.logs]))
        pipeline.submit(aSegment())
        pipeline.flush()
        #expect(platform.requests.isEmpty)
    }
}

@Suite struct FrameSegmentBoundaryTests {
    @Test func aScreenChangeClosesTheSegmentUnderTheScreenLeftNotTheOneArrivedAt() {
        let (pipeline, platform, engine) = started()
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        engine.openSegment = aPayload(reason: "navigation")
        withExtendedLifetime(pipeline) {
            pipeline.submit(.navigation(.screen(name: "Logs", key: "Logs-1")))
        }
        pipeline.flush()
        #expect(engine.calls.filter { $0 == "flushFrameSegment" }.count == 1)
        let attributes = performance(platform).first
        #expect(encodeJson(attributes?["screen"]) == #"{"key":"Home-1","name":"Home"}"#)
        #expect(attributes?["performance_segment_reason"] as? String == "navigation")
    }

    @Test func theFirstScreenClosesNothingSinceTheLaunchIsItsOwn() {
        let (pipeline, _, engine) = started()
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        // The same screen again is no change either.
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        #expect(!engine.calls.contains("flushFrameSegment"))
    }

    @Test func aManualNavigationClosesTheSegmentToo() {
        let (pipeline, platform, engine) = started()
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        engine.openSegment = aPayload(reason: "navigation")
        withExtendedLifetime(pipeline) {
            pipeline.submit(.navigation(.start(screen: "Checkout", key: "", metadata: nil)))
        }
        pipeline.flush()
        #expect(shippedScreens(platform) == ["Home"])
    }

    @Test func withVitalsOffAScreenChangeAsksTheEngineForNothing() {
        let (pipeline, _, engine) = started(aVitalsConfig(enabledEvents: [.navigation]))
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        pipeline.submit(.navigation(.screen(name: "Logs", key: "Logs-1")))
        #expect(!engine.calls.contains("flushFrameSegment"))
    }

    @Test func theEnginesBackgroundSegmentIsSentAtOnceSinceTheAppMayNeverRun() {
        // It arrives a moment after the background flush; the batch timer may never fire.
        let platform = FakePlatform()
        let engine = FakeNativeEngine()
        var services = platform.services
        services.engine = engine
        let pipeline = CorePipeline(marks: InteractiveMarks())
        _ = pipeline.start(
            GroundcoverConfig(
                apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
                options: GroundcoverOptions(
                    transport: TransportOptions(
                        batchSize: 100, batchTimeout: 300, compression: false))),
            platform: services)
        pipeline.presence()
        pipeline.submit(.navigation(.screen(name: "Native", key: "Native-1")))
        pipeline.lifecycle(.background)
        let sentBefore = platform.requests.count
        withExtendedLifetime(pipeline) { engine.emit("frame_segment", aPayload()) }
        #expect(platform.requests.count == sentBefore + 1)
        #expect(
            performance(platform).first?["performance_segment_reason"] as? String == "background")
    }

    @Test func aSegmentTheEngineClosesItselfTakesTheScreenCurrentNow() {
        let (pipeline, platform, engine) = started()
        pipeline.submit(.navigation(.screen(name: "Native", key: "Native-1")))
        withExtendedLifetime(pipeline) { engine.emit("frame_segment", aPayload()) }
        pipeline.flush()
        let attributes = performance(platform).first
        #expect(encodeJson(attributes?["screen"]) == #"{"key":"Native-1","name":"Native"}"#)
        #expect(attributes?["performance_segment_reason"] as? String == "background")
    }
}
