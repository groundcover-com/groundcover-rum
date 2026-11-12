import Foundation
import Testing

@testable import GroundcoverRum

// The Swift golden over packages/core/wire: one test per request file, plus the behaviour every
// golden repeats (that directory's README; the TS goldens hold the reference versions). It drives
// the pipeline directly: the fixtures pin what the core sends for a call, and ApiWiringTests checks
// that each public call reaches the core.

/// packages/core/wire, copied into the test bundle (Tests/GroundcoverRumTests/Wire is a symlink to
/// it): a simulator test can't read the checkout wherever it lives.
private let wireDirectory = Bundle.module.resourceURL!.appendingPathComponent("Wire")

/// 2027-01-15T08:00:00Z, the clock every fixture is written against.
private let fixtureClockMs: Int64 = 1_800_000_000_000

/// What only this platform sends, set aside before comparing.
private let platformSessionKeys: Set<String> = ["app", "device", "os", "source", "sdk"]
private let platformEventAttributes: Set<String> = ["screen", "error_stacktrace"]

private func fixture(_ name: String) throws -> [String: Any] {
    let data = try Data(contentsOf: wireDirectory.appendingPathComponent(name))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func goldenConfig(options: GroundcoverOptions? = nil) throws -> GroundcoverConfig {
    let config = try fixture("config.json")
    let user = config["user"] as? [String: Any]
    let fixtureOptions = config["options"] as? [String: Any]
    let transport = fixtureOptions?["transport"] as? [String: Any]
    return GroundcoverConfig(
        apiKey: config["apiKey"] as? String ?? "", dsn: config["dsn"] as? String ?? "",
        cluster: config["cluster"] as? String ?? "",
        environment: config["environment"] as? String ?? "",
        appId: config["appId"] as? String ?? "", namespace: config["namespace"] as? String,
        releaseId: config["releaseId"] as? String,
        user: RumUser(id: user?["id"] as? String, email: user?["email"] as? String),
        options: options
            ?? GroundcoverOptions(
                debug: fixtureOptions?["debug"] as? Bool,
                transport: TransportOptions(
                    batchSize: transport?["batchSize"] as? Int,
                    compression: transport?["compression"] as? Bool)))
}

private func goldenOptions(
    sessionMaxDuration: TimeInterval? = nil, sessionSampleRate: Double? = nil,
    beforeSend: BeforeSend? = nil, enrichEvent: EnrichEvent? = nil
) -> GroundcoverOptions {
    GroundcoverOptions(
        sessionSampleRate: sessionSampleRate, sessionMaxDuration: sessionMaxDuration,
        beforeSend: beforeSend, enrichEvent: enrichEvent,
        transport: TransportOptions(batchSize: 0, compression: false))
}

private func startPipeline(options: GroundcoverOptions? = nil) throws -> (
    CorePipeline, FakePlatform
) {
    let platform = FakePlatform(nowMs: fixtureClockMs)
    let pipeline = CorePipeline()
    _ = pipeline.start(try goldenConfig(options: options), platform: platform.services)
    return (pipeline, platform)
}

private func matches(_ value: Any?, _ pattern: String) -> Bool {
    guard let string = value as? String else { return false }
    return string.range(of: pattern, options: .regularExpression) != nil
}

/// The request with its random ids checked and removed, and this platform's own keys set aside.
private func sharedRequest(_ request: SentRequest) -> [String: Any] {
    var batch = request.batch
    var session = batch["sessionAttributes"] as? [String: Any] ?? [:]
    #expect(matches(session["session_id"], "^[0-9a-f]{32}$"))
    session = session.filter { $0.key != "session_id" && !platformSessionKeys.contains($0.key) }
    batch["sessionAttributes"] = session
    batch["events"] = request.events.map { event -> [String: Any] in
        #expect(matches(event["id"], "^[0-9a-f]{32}$"))
        #expect(matches(event["spanId"], "^[0-9a-f]{16}$"))
        #expect(matches(event["traceId"], "^0{16}[0-9a-f]{16}$"))
        var shared = event.filter { !["id", "spanId", "traceId"].contains($0.key) }
        shared["attributes"] = (event["attributes"] as? [String: Any] ?? [:]).filter {
            !platformEventAttributes.contains($0.key)
        }
        return shared
    }
    return ["url": request.url, "headers": request.headers, "body": batch]
}

/// `value` as canonical text, numbers as doubles: near 1.8e18 a double steps in 256 ns, which is
/// how the TS cores hold these values, so a port holding exact 64-bit integers compares as they do.
private func canonical(_ value: Any?) -> String {
    switch value {
    case nil, is NSNull:
        return "null"
    case let number as NSNumber where CFGetTypeID(number) == CFBooleanGetTypeID():
        return number.boolValue ? "true" : "false"
    case let number as NSNumber:
        return String(format: "%.17g", number.doubleValue)
    case let string as String:
        return encodeJson(string)
    case let dictionary as [String: Any]:
        let entries = dictionary.keys.sorted().map {
            "\(encodeJson($0)):\(canonical(dictionary[$0]))"
        }
        return "{" + entries.joined(separator: ",") + "}"
    case let array as [Any]:
        return "[" + array.map { canonical($0) }.joined(separator: ",") + "]"
    default:
        return String(describing: value)
    }
}

private func earliestEventTime(_ request: SentRequest) -> Int64 {
    request.events.compactMap { event in
        (event["timestamp"] ?? event["start_timestamp"]) as? Int64
    }.min() ?? .max
}

@Suite struct WireFormatGoldenTests {
    private func onlyRequest(_ send: (CorePipeline) -> Void) throws -> [String: Any] {
        let (pipeline, platform) = try startPipeline()
        pipeline.presence()
        send(pipeline)
        #expect(platform.requests.count == 1)
        return sharedRequest(try #require(platform.requests.first))
    }

    @Test func customEventJson() throws {
        let sent = try onlyRequest { pipeline in
            pipeline.submit(
                .custom(
                    CustomEventCapture(
                        name: "purchase", attributes: ["amount": 42, "nested": ["sku": "abc"]])))
        }
        #expect(canonical(sent) == canonical(try fixture("custom-event.json")))
    }

    @Test func logEventJson() throws {
        let sent = try onlyRequest { pipeline in
            pipeline.submit(
                .log(
                    LogCapture(
                        message: "golden log line", level: .warn,
                        attributes: ["context": "checkout"])))
        }
        #expect(canonical(sent) == canonical(try fixture("log-event.json")))
    }

    @Test func exceptionEventJson() throws {
        let sent = try onlyRequest { pipeline in
            pipeline.submit(
                .error(
                    ErrorCapture(
                        type: "Error", message: "golden failure", handled: true,
                        metadata: ["stage": "test"])))
        }
        #expect(canonical(sent) == canonical(try fixture("exception-event.json")))
    }

    @Test func doesNotTransmitAnythingBeforeGenuinePresence() throws {
        let (pipeline, platform) = try startPipeline(options: goldenOptions())
        pipeline.submit(.custom(CustomEventCapture(name: "pre-presence", attributes: [:])))
        #expect(platform.requests.isEmpty)

        pipeline.presence()
        pipeline.submit(.custom(CustomEventCapture(name: "post-presence", attributes: [:])))
        let names = platform.requests.flatMap { request in
            request.events.compactMap {
                ($0["attributes"] as? [String: Any])?["custom_event_name"] as? String
            }
        }
        #expect(Set(names).isSuperset(of: ["pre-presence", "post-presence"]))
    }

    @Test func sendsNothingWhenSessionSampleRateIs0() throws {
        let (pipeline, platform) = try startPipeline(options: goldenOptions(sessionSampleRate: 0))
        pipeline.presence()
        pipeline.submit(.custom(CustomEventCapture(name: "e", attributes: [:])))
        #expect(platform.requests.isEmpty)
    }

    @Test func keepsSessionIdentityStableAcrossFlushesWithinASession() throws {
        let (pipeline, platform) = try startPipeline(options: goldenOptions())
        pipeline.presence()
        pipeline.submit(.custom(CustomEventCapture(name: "first", attributes: [:])))
        pipeline.submit(.custom(CustomEventCapture(name: "second", attributes: [:])))
        #expect(platform.requests.count >= 2)
        let ids = Set(
            platform.requests.compactMap { $0.sessionAttributes["session_id"] as? String })
        #expect(ids.count == 1)
        #expect(ids.first == pipeline.sessionId)
    }

    @Test func neverClaimsASessionStartedAfterAnEventInTheSameBatch() throws {
        let (pipeline, platform) = try startPipeline(options: goldenOptions())
        pipeline.presence()
        pipeline.submit(.custom(CustomEventCapture(name: "first", attributes: [:])))
        pipeline.submit(.custom(CustomEventCapture(name: "second", attributes: [:])))
        #expect(!platform.requests.isEmpty)
        for request in platform.requests {
            let start = request.sessionAttributes["session_start_time"] as? Int64 ?? .max
            #expect(start <= earliestEventTime(request))
        }
    }

    /// Opens a session, crosses the cap with one event (with `during` set while that trigger goes
    /// through the pipeline), then sends one more, and checks that no batch under the new session
    /// claims a start later than an event it carries.
    private func rotateAcrossCap(
        _ options: (FakePlatform, @escaping () -> Bool) -> GroundcoverOptions
    ) throws {
        final class During: @unchecked Sendable { var value = false }
        let during = During()
        let platform = FakePlatform(nowMs: fixtureClockMs)
        let pipeline = CorePipeline()
        _ = pipeline.start(
            try goldenConfig(options: options(platform, { during.value })),
            platform: platform.services)
        pipeline.presence()
        pipeline.submit(.custom(CustomEventCapture(name: "before-cap", attributes: [:])))
        let before = platform.requests.last?.sessionAttributes["session_id"] as? String

        platform.nowMs = fixtureClockMs + 60_000 + 1000
        during.value = true
        pipeline.submit(.custom(CustomEventCapture(name: "after-cap", attributes: [:])))
        during.value = false

        pipeline.presence()
        pipeline.submit(.custom(CustomEventCapture(name: "post-rotation", attributes: [:])))

        let rotated = platform.requests.filter {
            $0.sessionAttributes["session_id"] as? String != before
        }
        #expect(!rotated.isEmpty, "the cap should have rotated the session")
        for request in rotated {
            let start = request.sessionAttributes["session_start_time"] as? Int64 ?? .max
            #expect(
                start <= earliestEventTime(request),
                "the rotated session started after an event it carries")
        }
    }

    @Test func aRotatedSessionNeverStartsAfterItsTriggerWhenTimePassesWhileItIsSent() throws {
        try rotateAcrossCap { platform, during in
            goldenOptions(
                sessionMaxDuration: 60,
                beforeSend: { _ in
                    if during() { platform.nowMs += 5 }
                    return true
                })
        }
    }

    @Test func aRotatedSessionNeverStartsAfterAnEnrichEventBackdatedTrigger() throws {
        try rotateAcrossCap { _, during in
            goldenOptions(
                sessionMaxDuration: 60,
                enrichEvent: { event in
                    if during(), let timestamp = event.timestamp {
                        event.timestamp = timestamp - 5 * 1_000_000
                    }
                    return event
                })
        }
    }
}
