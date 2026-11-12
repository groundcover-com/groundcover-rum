import Foundation
import Testing

@testable import GroundcoverRum

// Each public call as an app makes it, through the shared runtime, onto the wire. The core's own
// tests drive the pipeline directly, so only this catches a call wired to the wrong place.

extension SharedStateTests {
    @Suite struct ApiWiringTests {
        @Test func everyPublicCallReachesTheWire() async throws {
            let platform = FakePlatform()
            let previous = RumRuntime.shared.replacePlatform { _ in platform.services }
            defer {
                GroundcoverRumTesting.reset()
                RumRuntime.shared.replacePlatform(previous)
            }
            try Groundcover.start(
                GroundcoverConfig(
                    apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
                    options: GroundcoverOptions(
                        transport: TransportOptions(batchSize: 100, compression: false))))
            RumRuntime.shared.dispatch("presence") { $0.presence() }

            Groundcover.identifyUser(RumUser(id: "u_1", organization: "acme"))
            Groundcover.updateConfig(
                GroundcoverConfigUpdate(environment: "staging", user: .set(RumUser(id: "u_2"))))
            Groundcover.sendCustomEvent("checkout", ["step": 2])
            Groundcover.captureError(URLError(.badServerResponse), metadata: ["stage": "pay"])
            Groundcover.logger.log("log")
            Groundcover.logger.info("info")
            Groundcover.logger.warn("warn")
            Groundcover.logger.error("error")
            Groundcover.logger.debug("debug")
            Groundcover.logger.trace("trace")
            // Hands over what the old session buffered, in one request.
            await Groundcover.setSessionId("fixed")

            let request = try #require(platform.requests.first)
            #expect(
                request.events.map { $0["type"] as? String }
                    == ["custom", "exception", "log", "log", "log", "log", "log", "log"])
            let attributes = request.events.map { $0["attributes"] as? [String: Any] ?? [:] }
            #expect(attributes[0]["custom_event_name"] as? String == "checkout")
            #expect(attributes[0]["custom_event_attributes.step"] as? Int == 2)
            #expect(attributes[1]["error_type"] as? String == "URLError")
            #expect((attributes[1]["error_message"] as? String)?.isEmpty == false)
            #expect(attributes[1]["error_metadata.stage"] as? String == "pay")
            let levels = ["log", "info", "warn", "error", "debug", "trace"]
            #expect(attributes[2...].map { $0["level"] as? String } == levels)
            #expect(attributes[2...].map { $0["message"] as? String } == levels)
            let user = request.sessionAttributes["user"] as? [String: Any]
            #expect(user?["id"] as? String == "u_2")
            #expect(user?["organization"] as? String == "acme")
            #expect(request.sessionAttributes["env"] as? String == "staging")
            #expect(Groundcover.sessionId == "fixed")
        }
    }
}
