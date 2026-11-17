import Foundation
import Testing

@testable import GroundcoverRum

// The transporter: one POST per batch to {dsn}/json/rum, its headers, gzip, the debug log, and
// the verdict a delivery reports.

private func aBatch() -> Batch {
    Batch(sessionAttributes: ["session_id": "s"], events: [["type": "custom"]])
}

private func aTransporter(
    _ config: ConfigManager, _ platform: FakePlatform, diagnostics: RumDiagnostics = .shared
)
    -> Transporter
{
    Transporter(
        config: config, sender: platform.sender, executor: platform.executor,
        diagnostics: diagnostics)
}

@Suite struct TransporterTests {
    @Test func postsJsonToTheEndpointWithTheApikeyHeader() throws {
        let platform = FakePlatform()
        aTransporter(aConfig(), platform).send(aBatch())
        let request = try #require(platform.requests.first)
        #expect(request.url == "https://ingest.example/json/rum")
        #expect(
            request.headers == [
                "Content-Type": "application/json", "apikey": "k", "Content-Encoding": "",
            ])
        #expect(
            encodeJson(request.batch)
                == #"{"events":[{"type":"custom"}],"sessionAttributes":{"session_id":"s"}}"#)
    }

    @Test func gzipsTheBodyWhenCompressionIsOn() throws {
        let platform = FakePlatform()
        aTransporter(aConfig(compression: true), platform).send(aBatch())
        let request = try #require(platform.requests.first)
        #expect(request.headers["Content-Encoding"] == "gzip")
        #expect(request.body.prefix(2) == Data([0x1F, 0x8B]))
        #expect(request.events.first?["type"] as? String == "custom")
    }

    @Test func compressionIsOnByDefault() throws {
        let platform = FakePlatform()
        aTransporter(aConfig(compression: nil), platform).send(aBatch())
        #expect(platform.requests.first?.headers["Content-Encoding"] == "gzip")
    }

    @Test func inDebugLogsTheBatchJson() {
        final class Lines: @unchecked Sendable { var all: [String] = [] }
        let lines = Lines()
        let diagnostics = RumDiagnostics(sink: { lines.all.append($0) })
        diagnostics.configure(debug: true)
        let platform = FakePlatform()
        aTransporter(aConfig(compression: true, debug: true), platform, diagnostics: diagnostics)
            .send(aBatch())
        #expect(platform.requests.count == 1)
        #expect(
            lines.all.contains {
                $0.contains("Sending batch:") && $0.contains(#""events":[{"type":"custom"}]"#)
            })
    }

    @Test func sendsNothingWithoutAnApiKey() {
        let platform = FakePlatform()
        aTransporter(aConfig(apiKey: ""), platform).send(aBatch())
        #expect(platform.requests.isEmpty)
    }

    @Test func sendsWhatJsonHasNoFormForAsJSONStringifyWould() throws {
        struct Profile: CustomStringConvertible { var description: String { "profile #7" } }
        let platform = FakePlatform()
        aTransporter(aConfig(), platform).send(
            Batch(
                sessionAttributes: [
                    "user": [
                        "id": "u",
                        "properties": ["since": Profile(), 7: "seven"] as [AnyHashable: Any],
                    ]
                ],
                events: [
                    // What an enrichEvent or beforeSend hook can put back.
                    [
                        "type": "custom",
                        "attributes": [
                            "ratio": Double.infinity, "kind": Profile(), "tags": Set(["a"]),
                        ],
                    ]
                ]))
        let batch = try #require(platform.requests.first?.batch)
        #expect(
            encodeJson(batch)
                == #"{"events":[{"attributes":{"kind":"profile #7","ratio":null,"tags":["a"]},"type":"custom"}],"sessionAttributes":{"user":{"id":"u","properties":{"7":"seven","since":"profile #7"}}}}"#
        )
    }

    @Test func aDeliveryReportsWhetherTheBatchLanded() {
        final class Verdicts: @unchecked Sendable { var all: [Bool] = [] }
        let verdicts = Verdicts()
        let platform = FakePlatform()
        let transporter = aTransporter(aConfig(), platform)
        transporter.deliver(aBatch()) { verdicts.all.append($0) }
        platform.sender.delivers = false
        transporter.deliver(aBatch()) { verdicts.all.append($0) }
        aTransporter(aConfig(apiKey: ""), platform).deliver(aBatch()) { verdicts.all.append($0) }
        #expect(verdicts.all == [true, false, false])
        #expect(platform.requests.count == 2, "nothing is sent without an API key")
    }

    // A refused batch, as the browser SDK reports it: a 401 or 403 warns once per status even
    // with debug off, since a refused key silently drops every batch; any other status is only
    // logged in debug.
    final class Lines: @unchecked Sendable { var all: [String] = [] }

    @Test func aRefusedKeyWarnsOncePerStatusWithDebugOff() {
        let lines = Lines()
        let diagnostics = RumDiagnostics(sink: { lines.all.append($0) })
        let platform = FakePlatform()
        let transporter = aTransporter(aConfig(), platform, diagnostics: diagnostics)
        platform.sender.outcome = .rejected(status: 401)
        transporter.send(aBatch())
        transporter.send(aBatch())
        platform.sender.outcome = .rejected(status: 403)
        transporter.send(aBatch())
        #expect(
            lines.all == [
                "[groundcover] https://ingest.example/json/rum rejected a batch with HTTP 401. "
                    + "Check the apiKey and dsn passed to Groundcover.start(): no RUM data is "
                    + "recorded until they are accepted.",
                "[groundcover] https://ingest.example/json/rum rejected a batch with HTTP 403. "
                    + "Check the apiKey and dsn passed to Groundcover.start(): no RUM data is "
                    + "recorded until they are accepted.",
            ])
    }

    @Test func anotherRefusalIsOnlyLoggedInDebug() {
        let lines = Lines()
        let diagnostics = RumDiagnostics(sink: { lines.all.append($0) })
        let platform = FakePlatform()
        platform.sender.outcome = .rejected(status: 500)
        aTransporter(aConfig(), platform, diagnostics: diagnostics).send(aBatch())
        #expect(lines.all.isEmpty)

        diagnostics.configure(debug: true)
        aTransporter(aConfig(debug: true), platform, diagnostics: diagnostics).send(aBatch())
        #expect(
            lines.all.contains {
                $0.hasSuffix("Batch rejected by https://ingest.example/json/rum with HTTP 500")
            })
        #expect(!lines.all.contains { $0.contains("rejected a batch") })
    }

    @Test func aRefusedDeliveryWarnsAndIsNotDelivered() {
        final class Verdicts: @unchecked Sendable { var all: [Bool] = [] }
        let verdicts = Verdicts()
        let lines = Lines()
        let diagnostics = RumDiagnostics(sink: { lines.all.append($0) })
        let platform = FakePlatform()
        platform.sender.outcome = .rejected(status: 401)
        aTransporter(aConfig(), platform, diagnostics: diagnostics).deliver(aBatch()) {
            verdicts.all.append($0)
        }
        #expect(verdicts.all == [false])
        #expect(lines.all.count == 1)
        #expect(lines.all.first?.contains("HTTP 401") == true)
    }
}

@Suite struct GzipTests {
    @Test func roundTripsThroughZlib() {
        let text = String(repeating: "groundcover rum é 😀 ", count: 500)
        let compressed = gzip(Data(text.utf8))
        #expect(compressed?.count ?? .max < text.utf8.count)
        #expect(String(decoding: gunzip(compressed ?? Data()), as: UTF8.self) == text)
    }

    @Test func anEmptyBodyIsAValidGzipStream() {
        let compressed = gzip(Data())
        #expect(compressed != nil)
        #expect(gunzip(compressed ?? Data()).isEmpty)
        #expect(compressed?.prefix(2) == Data([0x1F, 0x8B]))
    }
}
