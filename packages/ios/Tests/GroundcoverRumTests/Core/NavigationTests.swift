import Foundation
import Testing

@testable import GroundcoverRum

// The navigation tracker on its own, mirroring the Dart tracker's tests, and the screen the
// pipeline stamps on every event and on the crash snapshot.

private let privacy = resolvePrivacy(nil)

@Suite struct NavigationTrackerTests {
    @Test func aScreenChangeReportsTheScreenLeftAndHowLongItShowed() throws {
        let tracker = NavigationTracker()
        let first = try #require(
            tracker.handle(.screen(name: "Home", key: "Home-1"), nowMs: 1000, privacy: privacy))
        #expect(first.attributes["duration_ms"] as? Int64 == 0)
        #expect(first.attributes["from_screen"] == nil)
        let second = try #require(
            tracker.handle(.screen(name: "Detail", key: "Detail-2"), nowMs: 1400, privacy: privacy))
        #expect(second.attributes["from_screen"] as? String == "Home")
        #expect(second.attributes["from_key"] as? String == "Home-1")
        #expect(second.attributes["duration_ms"] as? Int64 == 400)
        #expect(second.attributes["start_timestamp"] as? Int64 == msToNs(1000))
        #expect(second.attributes["end_timestamp"] as? Int64 == msToNs(1400))
        #expect(tracker.screenName == "Detail" && tracker.screenKey == "Detail-2")
    }

    @Test func theSameScreenAgainOrABlankOneReportsNothing() {
        let tracker = NavigationTracker()
        _ = tracker.handle(.screen(name: "Home", key: "Home-1"), nowMs: 1000, privacy: privacy)
        #expect(
            tracker.handle(.screen(name: "Home", key: "Home-1"), nowMs: 1200, privacy: privacy)
                == nil)
        #expect(tracker.handle(.screen(name: "", key: "x"), nowMs: 1300, privacy: privacy) == nil)
    }

    @Test func aManualNavigationStampsItsScreenAtOnceAndReportsAtItsEnd() throws {
        let tracker = NavigationTracker()
        #expect(
            tracker.handle(
                .start(screen: "Manual", key: "m-1", metadata: ["a": 1]), nowMs: 100,
                privacy: privacy) == nil)
        #expect(tracker.screenName == "Manual" && tracker.screenKey == "m-1")
        let end = try #require(
            tracker.handle(.end(metadata: ["b": 2]), nowMs: 350, privacy: privacy))
        #expect(end.attributes["duration_ms"] as? Int64 == 250)
        #expect(encodeJson(end.attributes["metadata"]) == #"{"a":1,"b":2}"#)
    }

    @Test func aBlankManualKeyIsNoKeyAsRNReadsIt() {
        let tracker = NavigationTracker()
        _ = tracker.handle(
            .start(screen: "Checkout", key: "  ", metadata: nil), nowMs: 100, privacy: privacy)
        #expect(tracker.screenKey == "")
    }

    @Test func aManualNavigationWithABlankScreenOrNoStartReportsNothing() {
        let tracker = NavigationTracker()
        _ = tracker.handle(
            .start(screen: "  ", key: "", metadata: nil), nowMs: 100, privacy: privacy)
        #expect(tracker.handle(.end(metadata: nil), nowMs: 200, privacy: privacy) == nil)
        #expect(tracker.handle(.end(metadata: nil), nowMs: 300, privacy: privacy) == nil)
        #expect(tracker.screenName == "")
    }
}

private func aConfig(_ options: GroundcoverOptions) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
        options: options)
}

private let noBatching = GroundcoverOptions(
    transport: TransportOptions(batchSize: 0, compression: false))

@Suite struct ScreenStampTests {
    private func started(_ options: GroundcoverOptions = noBatching) -> (
        CorePipeline, FakePlatform
    ) {
        let platform = FakePlatform()
        let pipeline = CorePipeline()
        _ = pipeline.start(aConfig(options), platform: platform.services)
        pipeline.presence()
        return (pipeline, platform)
    }

    @Test func everyEventAfterAScreenCarriesItAndTheNavigationIsSent() {
        let (pipeline, platform) = started()
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        pipeline.submit(.custom(CustomEventCapture(name: "c", attributes: [:])))
        let events = platform.requests.flatMap(\.events)
        #expect(events.map { $0["type"] as? String } == ["navigation", "custom"])
        for event in events {
            let screen = (event["attributes"] as? [String: Any])?["screen"]
            #expect(encodeJson(screen) == #"{"key":"Home-1","name":"Home"}"#)
        }
    }

    @Test func aNavigationMovesTheScreenEvenWithNavigationEventsOff() {
        let (pipeline, platform) = started(
            GroundcoverOptions(
                enabledEvents: [.logs],
                transport: TransportOptions(batchSize: 0, compression: false)))
        pipeline.submit(.navigation(.screen(name: "Home", key: "Home-1")))
        pipeline.submit(.log(LogCapture(message: "m", level: .info)))
        #expect(platform.types == ["log"])
        let screen = (platform.requests.first?.events.first?["attributes"] as? [String: Any])?[
            "screen"]
        #expect(encodeJson(screen) == #"{"key":"Home-1","name":"Home"}"#)
    }

    @Test func theCrashSnapshotCarriesTheScreen() throws {
        let platform = FakePlatform()
        var services = platform.services
        services.crashStore = FakeCrashStore()
        let pipeline = CorePipeline()
        _ = pipeline.start(aConfig(noBatching), platform: services)
        pipeline.submit(.navigation(.screen(name: "Detail", key: "Detail-1")))
        let snapshot = try #require(pipeline.sessionSnapshot)
        #expect(snapshot.contains(#""screen":{"key":"Detail-1","name":"Detail"}"#))
    }
}
