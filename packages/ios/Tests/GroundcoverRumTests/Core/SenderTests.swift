import Foundation
import Testing

@testable import GroundcoverRum

// The batch sender as it talks to a server: the POST it makes, and the delivery verdict, against a
// stub URLProtocol so nothing leaves the process.

private final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var fails = false
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var bodies: [Data] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.seen.append(request)
        Self.bodies.append(request.httpBody ?? readStream(request.httpBodyStream))
        if Self.fails {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func readStream(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private func aSender() -> URLSessionBatchSender {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    return URLSessionBatchSender(configuration: configuration)
}

private func send(_ sender: URLSessionBatchSender, headers: [String: String] = ["apikey": "k"])
    async -> Bool
{
    await withCheckedContinuation { continuation in
        sender.send(
            endpoint: "https://ingest.example/json/rum",
            request: BatchRequest(headers: headers, body: Data(#"{"events":[]}"#.utf8))
        ) { continuation.resume(returning: $0) }
    }
}

@Suite(.serialized) struct URLSessionBatchSenderTests {
    init() {
        StubProtocol.status = 200
        StubProtocol.fails = false
        StubProtocol.seen = []
        StubProtocol.bodies = []
    }

    @Test func postsTheBodyAndHeadersAndCallsA2xxDelivered() async throws {
        let delivered = await send(
            aSender(), headers: ["apikey": "k", "Content-Type": "application/json"])
        #expect(delivered)
        let request = try #require(StubProtocol.seen.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://ingest.example/json/rum")
        #expect(request.value(forHTTPHeaderField: "apikey") == "k")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(StubProtocol.bodies.first == Data(#"{"events":[]}"#.utf8))
    }

    @Test func eachUploadKeepsTheAppRunningUntilItEnds() async {
        final class KeepAlives: @unchecked Sendable {
            var begun = 0
            var ended = 0
        }
        let keepAlives = KeepAlives()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let sender = URLSessionBatchSender(configuration: configuration) {
            keepAlives.begun += 1
            return { keepAlives.ended += 1 }
        }
        #expect(await send(sender))
        #expect(keepAlives.begun == 1)
        #expect(keepAlives.ended == 1)
        StubProtocol.fails = true
        #expect(await send(sender) == false)
        #expect(keepAlives.begun == 2)
        #expect(keepAlives.ended == 2)
    }

    @Test func aNon2xxAnswerIsNotDelivered() async {
        StubProtocol.status = 500
        #expect(await send(aSender()) == false)
    }

    @Test func aNetworkFailureIsNotDelivered() async {
        StubProtocol.fails = true
        #expect(await send(aSender()) == false)
    }

    @Test func anEndpointThatIsNotAUrlIsNotDelivered() async {
        let delivered = await withCheckedContinuation { continuation in
            aSender().send(endpoint: "", request: BatchRequest(headers: [:], body: Data())) {
                continuation.resume(returning: $0)
            }
        }
        #expect(!delivered)
    }
}
