import Foundation
import GroundcoverRum
import GroundcoverRumSwiftLog
import Logging
import SwiftUI
import Testing
import UIKit

// The public API as an app calls it. Mostly a compile check: what's written here is the contract,
// and a change to any signature fails this file before it reaches an app.

extension SharedStateTests {
    @Suite struct PublicAPITests {
        @Test func theQuickStartStarts() throws {
            defer { GroundcoverRumTesting.reset() }
            try Groundcover.start(
                GroundcoverConfig(
                    apiKey: "your-rum-ingestion-key",
                    dsn: "https://example.platform.grcv.io",
                    cluster: "your-cluster",
                    environment: "production",
                    appId: "my-ios-app"))
        }

        @Test(arguments: ["", "   ", "\n"])
        func aBlankAppIdFailsTheStart(appId: String) {
            let config = GroundcoverConfig(
                apiKey: "key", dsn: "localhost:9393", cluster: "c", environment: "dev", appId: appId
            )
            #expect(throws: GroundcoverInitError.self) { try Groundcover.start(config) }
        }

        @Test func theInitErrorDescribesItsReason() {
            let error: Error = GroundcoverInitError("start requires a nonblank appId")
            #expect(error.localizedDescription == "start requires a nonblank appId")
        }

        @Test func everyOptionCanBeSet() throws {
            defer { GroundcoverRumTesting.reset() }
            let options = GroundcoverOptions(
                enabledEvents: [.interaction, .crashes, .appStart],
                sessionSampleRate: 0.5,
                sessionMaxDuration: 2 * 60 * 60,
                debug: true,
                excludedUrls: [
                    "https://api.example.com/health",
                    .regex(
                        try NSRegularExpression(
                            pattern: "/metrics$")),
                ],
                beforeSend: { event in event.type != "log" },
                enrichEvent: { event in
                    event.attributes["team"] = "payments"
                    return event
                },
                privacy: PrivacyOptions(
                    level: .maskSensitive,
                    maskNetworkBodies: true,
                    maskNetworkQueryParams: true,
                    maskLogs: true,
                    maskErrors: true,
                    sensitiveKeys: ["order_id"],
                    redact: { field in field.key == "email" ? "redacted@example.com" : nil },
                    maskInteractionLabels: false),
                tracing: TracingOptions(
                    propagationUrls: ["https://api.myapp.com/*"],
                    propagationHeaders: ["traceparent", "b3"],
                    traceIdHeaderName: "x-trace-id",
                    spanIdHeaderName: "x-span-id",
                    origin: TracingOrigin(name: "origin", value: "rum")),
                transport: TransportOptions(batchSize: 20, batchTimeout: 5, compression: true),
                appVersion: "1.2.3",
                appBuild: "45",
                native: NativeOptions(hangThreshold: 1, vitalsMaxSegment: 30, tti: .manual),
                hooks: NativeHooks(
                    viewControllers: false, touches: true, textFields: false, urlSession: false))
            try Groundcover.start(
                GroundcoverConfig(
                    apiKey: "key",
                    dsn: "localhost:9393",
                    cluster: "c",
                    environment: "dev",
                    appId: "app",
                    namespace: "ns",
                    releaseId: "1.0.0",
                    user: RumUser(id: "u_123", email: "demo@example.com"),
                    sessionId: "fixed",
                    options: options))
        }

        @Test func everyCallIsAvailable() async {
            defer { GroundcoverRumTesting.reset() }
            Groundcover.identifyUser(
                RumUser(
                    id: "u_123", email: "demo@example.com", name: "Demo", role: "admin",
                    organization: "acme", properties: ["plan": "pro"]))
            Groundcover.updateConfig(GroundcoverConfigUpdate(user: .clear))
            Groundcover.updateConfig(
                GroundcoverConfigUpdate(
                    environment: "staging",
                    user: .set(RumUser(id: "u_456")),
                    options: GroundcoverOptionsUpdate(
                        debug: false,
                        excludedUrls: ["*/health"],
                        transport: TransportOptions(batchTimeout: 1))))
            Groundcover.sendCustomEvent("plan_upgraded", ["plan": "pro"])
            Groundcover.sendCustomEvent("opened")
            Groundcover.captureError(URLError(.badServerResponse), metadata: ["step": "pay"])
            Groundcover.logger.log("log")
            Groundcover.logger.info("info", ["via": "api"])
            Groundcover.logger.warn("Payment retry", ["attempt": 2])
            Groundcover.logger.error("error")
            Groundcover.logger.debug("debug")
            Groundcover.logger.trace("trace")
            _ = Groundcover.sessionId
            await Groundcover.setSessionId("fixed")
            await Groundcover.setSessionId()
            Groundcover.startNavigation("Checkout", key: "checkout-1", metadata: ["cart": 3])
            Groundcover.endNavigation(["paid": true])
            Groundcover.stopNavigationTracking()
            Groundcover.markAppInteractive()
        }

        @Test func hooksTakeAndReturnTheEvent() throws {
            let event = RumEvent(
                type: "interaction", id: "id", spanId: "span",
                attributes: ["interaction_target.label": "Pay"])
            let beforeSend: BeforeSend = {
                $0.attributes["interaction_target.label"] as? String != "x"
            }
            let enrich: EnrichEvent = { event in
                event.attributes["enriched"] = true
                return event
            }
            #expect(try beforeSend(event))
            #expect(try enrich(event).attributes["enriched"] as? Bool == true)

            struct Refused: Error {}
            let throwing: BeforeSend = { _ in throw Refused() }
            #expect(throws: Refused.self) { try throwing(event) }
        }

        @MainActor @Test func viewsCanBeMarkedPrivate() {
            let view = UIView()
            #expect(!view.groundcoverPrivate)
            view.groundcoverPrivate = true
            #expect(view.groundcoverPrivate)
            view.groundcoverPrivate = false
            #expect(!view.groundcoverPrivate)

            _ = Text("Profile").groundcoverScreen("Profile", key: "profile-1").groundcoverPrivate()
        }

        /// Only what swift-log 1.5.0, the package's floor, already has: `Logger.handler` is public
        /// from 1.6. Sending is covered by the handler's own tests.
        @Test func aSwiftLogLoggerTakesTheHandler() {
            var logger = Logger(label: "payments") { GroundcoverLogHandler(label: $0) }
            logger[metadataKey: "user"] = "u_123"
            logger.logLevel = .debug
            logger.warning("Payment retry", metadata: ["attempt": "2"])
            #expect(logger.logLevel == .debug)
            #expect(logger[metadataKey: "user"] == "u_123")

            var handler = GroundcoverLogHandler(label: "payments")
            #expect(handler.logLevel == .info)
            handler[metadataKey: "screen"] = "Checkout"
            #expect(handler.metadata["screen"] == "Checkout")
        }

        /// The raw values are contract: the Objective-C facade takes event names as these strings, and
        /// the other SDKs and the wire spell them so. The API files print an enum's cases without
        /// them, so they are pinned here.
        @Test func theRawValuesAreTheContract() {
            #expect(
                RumEventName.allCases.map(\.rawValue) == [
                    "interaction", "network", "logs", "navigation", "exceptions", "crashes",
                    "hangs",
                    "vitals", "appStart",
                ])
            #expect(
                [PrivacyLevel.maskSensitive, .maskAll, .allow].map(\.rawValue) == [
                    "mask-sensitive", "mask-all", "allow",
                ])
            #expect(
                [RedactKind.requestBody, .responseBody, .query, .header, .log, .error].map(
                    \.rawValue)
                    == ["request-body", "response-body", "query", "header", "log", "error"])
            #expect([TtiMode.auto, .manual].map(\.rawValue) == ["auto", "manual"])
        }
    }
}
