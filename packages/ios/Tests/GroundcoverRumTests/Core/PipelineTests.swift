import Foundation
import Testing

@testable import GroundcoverRum

// The pipeline as a whole, beyond what the wire goldens pin: the enabledEvents gates, presence and
// the host lifecycle, session id control, the identity, network capture's questions, and stopping.

private func aPipelineConfig(
    dsn: String = "ingest.example",
    sessionId: String? = nil,
    options: GroundcoverOptions = GroundcoverOptions(
        transport: TransportOptions(batchSize: 0, compression: false))
) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: dsn, cluster: "c", environment: "e", appId: "a", sessionId: sessionId,
        options: options)
}

private func batching(_ batchSize: Int) -> GroundcoverOptions {
    GroundcoverOptions(transport: TransportOptions(batchSize: batchSize, compression: false))
}

private func started(
    _ config: GroundcoverConfig = aPipelineConfig(), diagnostics: RumDiagnostics = .shared
) -> (CorePipeline, FakePlatform) {
    let platform = FakePlatform()
    let pipeline = CorePipeline(diagnostics: diagnostics)
    _ = pipeline.start(config, platform: platform.services)
    return (pipeline, platform)
}

private func custom(_ name: String = "x") -> Capture {
    .custom(CustomEventCapture(name: name, attributes: [:]))
}

@Suite struct CorePipelineTests {
    @Test func theSdksOwnUploadsAreNeverCapturedHoweverTheDsnIsWritten() {
        // Captured, each upload would fill the next batch with its own network event, and an idle
        // app would upload every batchTimeout for good. Capture may report the URL as given or
        // normalized (an HTTP client may lowercase the host, drop a default port, resolve dots).
        let cases: [(dsn: String, asGiven: String, normalized: String)] = [
            (
                "ingest.example", "https://ingest.example/json/rum",
                "https://ingest.example/json/rum"
            ),
            (
                "Ingest.Example", "https://Ingest.Example/json/rum",
                "https://ingest.example/json/rum"
            ),
            (
                "https://INGEST.example:443", "https://INGEST.example:443/json/rum",
                "https://ingest.example/json/rum"
            ),
            (
                "https://ingest.example/a/../rum", "https://ingest.example/a/../rum/json/rum",
                "https://ingest.example/rum/json/rum"
            ),
        ]
        for item in cases {
            let (pipeline, _) = started(aPipelineConfig(dsn: item.dsn))
            #expect(!pipeline.capturesUrl(item.asGiven), "\(item.dsn)")
            #expect(!pipeline.capturesUrl(item.normalized), "\(item.dsn)")
            #expect(pipeline.capturesUrl("https://api.example/orders"))
        }
    }

    @Test func excludedUrlsAndADisabledNetworkSignalAreNotCaptured() {
        let (excluding, _) = started(
            aPipelineConfig(options: GroundcoverOptions(excludedUrls: ["*/health"])))
        #expect(!excluding.capturesUrl("https://api.example/health"))
        #expect(excluding.capturesUrl("https://api.example/orders"))
        let (logsOnly, _) = started(
            aPipelineConfig(options: GroundcoverOptions(enabledEvents: [.logs])))
        #expect(!logsOnly.capturesUrl("https://api.example/orders"))
    }

    @Test func traceHeadersAreOnlyForPropagationUrlsAndFreshEachCall() {
        let (pipeline, _) = started(
            aPipelineConfig(
                options: GroundcoverOptions(
                    tracing: TracingOptions(propagationUrls: ["https://api.example/*"]))))
        #expect(pipeline.traceHeaders(for: "https://other.example/x").isEmpty)
        let first = pipeline.traceHeaders(for: "https://api.example/x")["traceparent"]
        let second = pipeline.traceHeaders(for: "https://api.example/x")["traceparent"]
        #expect(first?.hasPrefix("00-") == true)
        #expect(first != second)
    }

    @Test func startsOnceASecondStartIsIgnored() {
        let (pipeline, platform) = started(aPipelineConfig(sessionId: "first"))
        _ = pipeline.start(aPipelineConfig(sessionId: "second"), platform: platform.services)
        #expect(pipeline.sessionId == "first")
    }

    @Test func doesNothingBeforeStart() {
        let pipeline = CorePipeline()
        pipeline.presence()
        pipeline.submit(custom())
        pipeline.lifecycle(.background)
        pipeline.flush()
        pipeline.setSessionId("x")
        #expect(pipeline.sessionId == "")
    }

    @Test func enabledEventsGatesLogsAndExceptionsNeverCustomEvents() {
        let (pipeline, platform) = started(
            aPipelineConfig(
                options: GroundcoverOptions(
                    enabledEvents: [.interaction],
                    transport: TransportOptions(batchSize: 0, compression: false))))
        pipeline.presence()
        pipeline.submit(.log(LogCapture(message: "m", level: .info)))
        pipeline.submit(.error(ErrorCapture(type: "E", message: "m")))
        pipeline.submit(custom("c"))
        #expect(platform.types == ["custom"])
    }

    @Test func logAttributesCannotShadowMessageLevelOrScreen() {
        let (pipeline, platform) = started()
        pipeline.presence()
        pipeline.submit(
            .log(
                LogCapture(
                    message: "real", level: .warn,
                    attributes: ["message": "fake", "level": "fake", "screen": "fake", "ok": 1])))
        let attributes = platform.requests.first?.events.first?["attributes"]
        // The screen is stamped on every event, empty before any navigation.
        #expect(
            encodeJson(attributes)
                == #"{"level":"warn","message":"real","ok":1,"screen":{"key":"","name":""}}"#)
    }

    @Test func nothingIsSentBeforePresenceAndPresenceShipsWhatWasHeld() {
        let (pipeline, platform) = started()
        pipeline.submit(custom("held"))
        pipeline.flush()
        #expect(platform.requests.isEmpty)
        pipeline.presence()
        pipeline.flush()
        #expect(platform.types == ["custom"])
    }

    @Test func aBackgroundTransitionPersistsActivityAndSendsTheBuffer() {
        let (pipeline, platform) = started(aPipelineConfig(options: batching(100)))
        pipeline.presence()
        pipeline.submit(custom("held"))
        #expect(platform.requests.isEmpty)
        platform.nowMs += 1000
        pipeline.presence()
        pipeline.lifecycle(.background)
        #expect(platform.types == ["custom"])
        #expect(platform.storage.values[SessionKeys.lastActivity] == "\(platform.nowMs)")
    }

    @Test func returningToTheForegroundCountsAsPresence() {
        let (pipeline, platform) = started()
        pipeline.submit(custom("held"))
        #expect(platform.requests.isEmpty)
        pipeline.lifecycle(.foreground)
        pipeline.flush()
        #expect(platform.types == ["custom"])
    }

    @Test func aRotationFlushesAConfirmedSessionsBufferUnderItsOldId() {
        let (pipeline, platform) = started(
            aPipelineConfig(
                options: GroundcoverOptions(
                    sessionMaxDuration: 60,
                    transport: TransportOptions(batchSize: 100, compression: false))))
        let first = pipeline.sessionId
        pipeline.presence()
        pipeline.submit(custom("before"))
        platform.nowMs += 60_000
        pipeline.submit(custom("after"))
        #expect(platform.requests.first?.sessionAttributes["session_id"] as? String == first)
        #expect(pipeline.sessionId != first)
    }

    @Test func setSessionIdSendsTheOldSessionThenStartsTheGivenId() {
        let (pipeline, platform) = started(aPipelineConfig(options: batching(100)))
        let before = pipeline.sessionId
        pipeline.presence()
        pipeline.submit(custom("old"))
        pipeline.setSessionId("fixed")
        #expect(platform.requests.first?.sessionAttributes["session_id"] as? String == before)
        #expect(pipeline.sessionId == "fixed")
        pipeline.setSessionId(nil)
        #expect(pipeline.sessionId.count == 32)
    }

    @Test func anUnsampledSessionReportsNothingAndSaysSo() {
        let platform = FakePlatform()
        let pipeline = CorePipeline()
        #expect(
            pipeline.start(
                aPipelineConfig(options: GroundcoverOptions(sessionSampleRate: 0)),
                platform: platform.services) == .unsampled)
        pipeline.presence()
        pipeline.submit(custom())
        pipeline.flush()
        #expect(platform.requests.isEmpty)
        #expect(pipeline.sessionId == "")
    }

    @Test func stopDropsTheBufferAndKeepsThePersistedSession() {
        let (pipeline, platform) = started(aPipelineConfig(options: batching(100)))
        let id = pipeline.sessionId
        pipeline.presence()
        pipeline.submit(custom())
        pipeline.stop()
        pipeline.flush()
        platform.executor.advance(byMs: 60_000)
        #expect(platform.requests.isEmpty)
        #expect(platform.storage.values[SessionKeys.id] == id)
    }

    @Test func identifyUserMergesAndUpdateConfigReachesTheEnvelope() {
        let (pipeline, platform) = started()
        pipeline.presence()
        pipeline.identifyUser(RumUser(id: "u1"))
        pipeline.identifyUser(RumUser(email: "a@b"))
        pipeline.updateConfig(GroundcoverConfigUpdate(environment: "prod"))
        pipeline.submit(custom())
        let attributes = platform.requests.first?.sessionAttributes
        #expect(encodeJson(attributes?["user"]) == #"{"email":"a@b","id":"u1"}"#)
        #expect(attributes?["env"] as? String == "prod")
    }

    @Test func updateConfigSwitchesTheDebugLog() {
        let diagnostics = RumDiagnostics(sink: { _ in })
        let (pipeline, _) = started(diagnostics: diagnostics)
        #expect(!diagnostics.isDebug)
        pipeline.updateConfig(
            GroundcoverConfigUpdate(options: GroundcoverOptionsUpdate(debug: true)))
        #expect(diagnostics.isDebug)
    }

    @Test func aNetworkCaptureIsShapedAndSent() {
        let (pipeline, platform) = started()
        pipeline.presence()
        pipeline.submit(
            .network(
                NetworkCapture(
                    method: "GET", url: "https://api.example/orders?token=t",
                    startMs: 1_800_000_000_000,
                    endMs: 1_800_000_000_100, status: 200)))
        let event = platform.requests.first?.events.first
        #expect(event?["type"] as? String == "network")
        #expect(event?["span_name"] as? String == "GET /orders")
        #expect(
            (event?["attributes"] as? [String: Any])?["url.full"] as? String
                == "https://api.example/orders?token=%5BREDACTED%5D")
    }
}

// Interaction events, mirroring the Dart pipeline's interaction group.
@Suite struct InteractionEventTests {
    private let target = InteractionTarget(
        component: "UIButton", label: "Pay now", role: "button", hint: "Charges the card",
        state: ["selected": true], valueText: "forty two percent",
        componentPath: "UIWindow > UIView > UIButton")

    private func shipped(
        _ capture: InteractionCapture,
        options: GroundcoverOptions = GroundcoverOptions(
            transport: TransportOptions(batchSize: 0, compression: false))
    ) -> [String: Any] {
        let (pipeline, platform) = started(aPipelineConfig(options: options))
        pipeline.presence()
        pipeline.submit(.interaction(capture))
        // An interaction never triggers a size flush; it rides with the next event.
        pipeline.submit(custom("flush"))
        return platform.requests.first?.events.first?["attributes"] as? [String: Any] ?? [:]
    }

    @Test func aTapCarriesItsCoordinatesTheTargetAndThePathFlattened() {
        let attributes = shipped(InteractionCapture(kind: .tap, target: target, x: 12, y: 34))
        #expect(
            encodeJson(attributes)
                == encodeJson(
                    [
                        "interaction_type": "tap",
                        "interaction_coordinates.x": 12.0,
                        "interaction_coordinates.y": 34.0,
                        "interaction_target.component": "UIButton",
                        "interaction_target.label": "Pay now",
                        "interaction_target.role": "button",
                        "interaction_target.hint": "Charges the card",
                        "interaction_target.state.selected": true,
                        "interaction_target.value.text": "forty two percent",
                        "interaction_component_path": "UIWindow > UIView > UIButton",
                        "screen": ["name": "", "key": ""],
                    ] as [String: Any]))
    }

    @Test func aGestureAddsItsMeasureFromNativeAndAnInputHasNoCoordinates() {
        let swipe = shipped(
            InteractionCapture(
                kind: .swipe, target: target, x: 1, y: 2,
                gesture: GestureMeasure(
                    direction: .up, distanceDp: 120, velocityDpS: 900, durationMs: 130,
                    pointerCount: 1)))
        #expect(swipe["interaction_type"] as? String == "swipe")
        #expect(swipe["interaction_gesture.direction"] as? String == "up")
        #expect(swipe["interaction_gesture.distance_dp"] as? Int == 120)
        #expect(swipe["interaction_gesture.velocity_dp_s"] as? Int == 900)
        #expect(swipe["interaction_gesture.duration_ms"] as? Int == 130)
        #expect(swipe["interaction_gesture.pointer_count"] as? Int == 1)
        #expect(swipe["interaction_gesture.capture_source"] as? String == "native")
        #expect(swipe["interaction_gesture.partial"] == nil)

        let pinch = shipped(
            InteractionCapture(
                kind: .pinch, target: target, x: 1, y: 2,
                gesture: GestureMeasure(
                    distanceDp: 40, velocityDpS: 100, durationMs: 400, pointerCount: 2,
                    partial: true)))
        #expect(pinch["interaction_gesture.direction"] == nil)
        #expect(pinch["interaction_gesture.partial"] as? Bool == true)

        let input = shipped(InteractionCapture(kind: .input, target: target))
        #expect(input["interaction_type"] as? String == "input")
        #expect(!input.keys.contains { $0.hasPrefix("interaction_coordinates") })
        #expect(!input.keys.contains { $0.hasPrefix("interaction_gesture") })
    }

    @Test func aPrivateTargetMasksLabelHintAndValueTextAndKeepsTheStructure() {
        var privateTarget = target
        privateTarget.masked = true
        let attributes = shipped(InteractionCapture(kind: .tap, target: privateTarget, x: 0, y: 0))
        #expect(attributes["interaction_target.label"] as? String == "***")
        #expect(attributes["interaction_target.hint"] as? String == "***")
        #expect(attributes["interaction_target.value.text"] as? String == "***")
        #expect(attributes["interaction_target.state.selected"] as? Bool == true)
        #expect(attributes["interaction_target.role"] as? String == "button")
        #expect(attributes["interaction_target.component"] as? String == "UIButton")
        #expect(
            attributes["interaction_component_path"] as? String == "UIWindow > UIView > UIButton")
    }

    @Test func anEmptyHintStaysEmptyWhenMasked() {
        var privateTarget = target
        privateTarget.masked = true
        privateTarget.hint = ""
        privateTarget.valueText = nil
        privateTarget.state = nil
        let attributes = shipped(InteractionCapture(kind: .tap, target: privateTarget, x: 0, y: 0))
        #expect(attributes["interaction_target.hint"] as? String == "")
        #expect(attributes["interaction_target.value.text"] == nil)
        #expect(!attributes.keys.contains { $0.hasPrefix("interaction_target.state") })
    }

    @Test func maskAllMasksEveryLabelAndTheDefaultLevelMasksNone() {
        let masked = shipped(
            InteractionCapture(kind: .tap, target: target, x: 0, y: 0),
            options: GroundcoverOptions(
                privacy: PrivacyOptions(level: .maskAll),
                transport: TransportOptions(batchSize: 0, compression: false)))
        #expect(masked["interaction_target.label"] as? String == "***")
        #expect(masked["interaction_target.value.text"] as? String == "***")
        let plain = shipped(InteractionCapture(kind: .tap, target: target, x: 0, y: 0))
        #expect(plain["interaction_target.label"] as? String == "Pay now")
    }

    @Test func anInteractionConfirmsTheSessionLikeAPresenceSignal() {
        let (pipeline, platform) = started()
        pipeline.submit(.interaction(InteractionCapture(kind: .tap, target: target, x: 0, y: 0)))
        pipeline.submit(custom("after"))
        #expect(platform.types == ["interaction", "custom"])
    }

    @Test func enabledEventsWithoutInteractionDropsThem() {
        let (pipeline, platform) = started(
            aPipelineConfig(
                options: GroundcoverOptions(
                    enabledEvents: [.logs],
                    transport: TransportOptions(batchSize: 0, compression: false))))
        pipeline.presence()
        pipeline.submit(.interaction(InteractionCapture(kind: .tap, target: target)))
        pipeline.submit(custom("c"))
        #expect(platform.types == ["custom"])
    }
}
