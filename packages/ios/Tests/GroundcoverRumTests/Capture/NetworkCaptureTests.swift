import Foundation
import Testing

@testable import GroundcoverRum

// Network capture: trace headers on the way out, the event on the way back, the body rules, the
// manual recording, the explicit API's three call styles, and the URLSession hook, against a stub
// server.

private func aConfig(
    propagationUrls: [String] = ["https://api.example/*"], excluded: [URLPattern] = []
) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
        options: GroundcoverOptions(
            excludedUrls: excluded,
            tracing: TracingOptions(propagationUrls: propagationUrls),
            transport: TransportOptions(batchSize: 0, compression: false)))
}

private func aRuntime(_ config: GroundcoverConfig = aConfig()) -> (RumRuntime, FakePlatform) {
    let platform = FakePlatform()
    let runtime = RumRuntime(makePlatform: { _ in platform.services })
    try? runtime.start(config)
    runtime.dispatch("presence") { $0.presence() }
    return (runtime, platform)
}

private func networkEvents(_ platform: FakePlatform) -> [[String: Any]] {
    platform.requests.flatMap(\.events).filter { $0["type"] as? String == "network" }
        .compactMap { $0["attributes"] as? [String: Any] }
}

private func http(_ status: Int, _ headers: [String: String] = [:]) -> HTTPURLResponse {
    HTTPURLResponse(
        url: URL(string: "https://api.example/x")!, statusCode: status, httpVersion: nil,
        headerFields: headers)!
}

@Suite struct NetworkRecorderTests {
    @Test func aMatchingRequestGainsATraceparentAndOthersAreUntouched() throws {
        let (runtime, _) = aRuntime()
        let (traced, recorder) = NetworkRecorder.start(
            URLRequest(url: URL(string: "https://api.example/orders")!), runtime: runtime)
        #expect(recorder != nil)
        let traceparent = try #require(traced.value(forHTTPHeaderField: "traceparent"))
        #expect(
            traceparent.range(
                of: #"^00-[0-9a-f]{32}-[0-9a-f]{16}-01$"#, options: .regularExpression) != nil)
        let (plain, plainRecorder) = NetworkRecorder.start(
            URLRequest(url: URL(string: "https://other.example/x")!), runtime: runtime)
        #expect(plainRecorder != nil)
        #expect(plain.value(forHTTPHeaderField: "traceparent") == nil)
    }

    @Test func onlyItsOwnTraceparentKeepsARequestFromGainingOne() throws {
        let (runtime, _) = aRuntime(
            GroundcoverConfig(
                apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: "a",
                options: GroundcoverOptions(
                    tracing: TracingOptions(
                        propagationUrls: ["https://api.example/*"],
                        origin: TracingOrigin(name: "x-origin", value: "rum")),
                    transport: TransportOptions(batchSize: 0, compression: false))))
        // A header of the app's that only shares the origin's name.
        var request = URLRequest(url: URL(string: "https://api.example/orders")!)
        request.setValue("checkout", forHTTPHeaderField: "x-origin")
        let (traced, _) = NetworkRecorder.start(request, runtime: runtime)
        #expect(traced.value(forHTTPHeaderField: "traceparent") != nil)
    }

    @Test func nothingIsRecordedBeforeStartForTheSdksOwnUploadOrAnExcludedUrl() {
        let idle = RumRuntime(makePlatform: { _ in FakePlatform().services })
        let request = URLRequest(url: URL(string: "https://api.example/orders")!)
        let (untouched, none) = NetworkRecorder.start(request, runtime: idle)
        #expect(none == nil)
        #expect(untouched == request)
        let (runtime, _) = aRuntime(aConfig(excluded: ["*/health"]))
        #expect(
            NetworkRecorder.start(
                URLRequest(url: URL(string: "https://ingest.example/json/rum")!), runtime: runtime
            ).1 == nil)
        #expect(
            NetworkRecorder.start(
                URLRequest(url: URL(string: "https://api.example/health")!), runtime: runtime
            ).1 == nil)
    }

    @Test func aResponseIsShapedWithItsStatusHeadersAndBody() throws {
        let (runtime, platform) = aRuntime()
        var request = URLRequest(url: URL(string: "https://api.example/orders?id=7")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(#"{"hello":"mobile"}"#.utf8)
        let (traced, recorder) = NetworkRecorder.start(request, runtime: runtime)
        recorder?.finish(
            response: http(201, ["Content-Type": "application/json"]),
            data: Data(#"{"ok":true}"#.utf8), error: nil, runtime: runtime)
        runtime.dispatch("flush") { $0.flush() }
        let event = try #require(networkEvents(platform).first)
        #expect(event["status"] as? String == "201")
        #expect(event["http.method"] as? String == "POST")
        #expect(event["gc.request.body"] as? String == #"{"hello":"mobile"}"#)
        #expect(event["gc.response.body"] as? String == #"{"ok":true}"#)
        // Header names as the wire has them, whatever case the app set them in.
        #expect(event["http.request.headers.content-type"] as? String == "application/json")
        #expect(
            event["http.request.headers.traceparent"] as? String
                == traced.value(forHTTPHeaderField: "traceparent"))
    }

    @Test func failuresAreStatusZeroAndACancelIsNotReported() throws {
        let (runtime, platform) = aRuntime()
        let request = URLRequest(url: URL(string: "https://api.example/x")!)
        NetworkRecorder.start(request, runtime: runtime).1?.finish(
            response: nil, data: nil, error: URLError(.timedOut), runtime: runtime)
        NetworkRecorder.start(request, runtime: runtime).1?.finish(
            response: nil, data: nil, error: URLError(.cannotConnectToHost), runtime: runtime)
        NetworkRecorder.start(request, runtime: runtime).1?.finish(
            response: nil, data: nil, error: URLError(.cancelled), runtime: runtime)
        runtime.dispatch("flush") { $0.flush() }
        let events = networkEvents(platform)
        #expect(events.count == 2)
        #expect(events.map { $0["status"] as? String } == ["0", "0"])
        #expect(
            events.map { $0["error.type"] as? String } == ["ERR_TIMEOUT", "ERR_NETWORK_FAILURE"])
    }

    @Test func anEventStreamTheAppCancelsIsReportedAsAnswered() throws {
        // A stream has no end of its own: the app ends it by cancelling it, once it opened.
        let (runtime, platform) = aRuntime()
        for type in ["text/event-stream", "application/json"] {
            let request = URLRequest(url: URL(string: "https://api.example/\(type)")!)
            NetworkRecorder.start(request, runtime: runtime).1?.finish(
                response: http(200, ["Content-Type": type]), data: nil,
                error: URLError(.cancelled), runtime: runtime)
        }
        runtime.dispatch("flush") { $0.flush() }
        let events = networkEvents(platform)
        #expect(events.count == 1)
        let event = try #require(events.first)
        #expect(event["status"] as? String == "200")
        #expect(event["gc.response.body"] as? String == "[unreadable response body]")
        #expect(event["error.type"] == nil)
    }

    @Test func bodiesFollowTheCapAndTheirTypes() {
        let large = Data(String(repeating: "a", count: 5000).utf8)
        #expect(
            NetworkRecorder.responseBody(
                large, method: "GET", status: 200, headers: ["content-type": "application/json"])
                == "[response body too large]")
        #expect(
            NetworkRecorder.responseBody(
                Data("x".utf8), method: "HEAD", status: 200, headers: ["content-type": "text/plain"]
            )
                == "")
        #expect(
            NetworkRecorder.responseBody(
                Data("x".utf8), method: "GET", status: 204, headers: ["content-type": "text/plain"])
                == "")
        #expect(
            NetworkRecorder.responseBody(
                Data("data: x".utf8), method: "GET", status: 200,
                headers: ["content-type": "text/event-stream"]) == "[unreadable response body]")
        #expect(
            NetworkRecorder.responseBody(
                Data([0xFF, 0xD8]), method: "GET", status: 200,
                headers: ["content-type": "image/jpeg"])
                == "[image data]")
        var streamed = URLRequest(url: URL(string: "https://api.example/x")!)
        streamed.httpBodyStream = InputStream(data: Data("x".utf8))
        #expect(NetworkRecorder.requestBody(streamed) == "[request body unavailable]")
    }
}

/// An ephemeral session's configuration, its requests answered by `protocolClass`.
private func stubbedConfiguration(_ protocolClass: AnyClass = EchoProtocol.self)
    -> URLSessionConfiguration
{
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    return configuration
}

/// The headers `EchoProtocol` received, from the body it answered with.
private func echoedHeaders(_ data: Data?) -> [String: String] {
    guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return json["headers"] as? [String: String] ?? [:]
}

/// Answers every request with its own headers as JSON, as the e2e suite's echo does.
private final class EchoProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = try? JSONSerialization.data(
            withJSONObject: ["headers": request.allHTTPHeaderFields ?? [:]])
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Fails `/fail` as a refused connection would, opens `/stream` as an event stream that sends
/// nothing, and never answers anything else.
private final class FailOrStallProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch request.url?.path {
        case "/fail":
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        case "/stream":
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        default:
            break
        }
    }

    override func stopLoading() {}
}

private final class Delegate: GroundcoverURLSessionDelegate, @unchecked Sendable {
    var done: (() -> Void)?

    override func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?
    ) {
        super.urlSession(session, task: task, didCompleteWithError: error)
        done?()
    }
}

/// Runs `body` with the SDK started, as an app's calls see it, into a fake platform.
private func withSharedRuntime(
    _ config: GroundcoverConfig = aConfig(propagationUrls: ["*"]),
    _ body: (FakePlatform) async throws -> Void
) async rethrows {
    let platform = FakePlatform()
    let previous = RumRuntime.shared.replacePlatform { _ in platform.services }
    defer {
        RumRuntime.shared.reset()
        RumRuntime.shared.replacePlatform(previous)
    }
    try? RumRuntime.shared.start(config)
    RumRuntime.shared.dispatch("presence") { $0.presence() }
    try await body(platform)
}

private func flushedNetworkEvents(_ platform: FakePlatform) -> [[String: Any]] {
    RumRuntime.shared.dispatch("flush") { $0.flush() }
    return networkEvents(platform)
}

extension SharedStateTests {
    @Suite struct ManualRecordingTests {
        @Test func theRequestGainsItsTraceHeaders() async throws {
            try await withSharedRuntime { platform in
                var request = URLRequest(url: URL(string: "https://api.example/orders")!)
                let recording = try #require(Groundcover.startNetworkRecording(&request))
                let traceparent = try #require(request.value(forHTTPHeaderField: "traceparent"))
                recording.finish(response: http(200), data: nil, error: nil)
                let event = try #require(flushedNetworkEvents(platform).first)
                #expect(event["http.request.headers.traceparent"] as? String == traceparent)
            }
        }

        @Test func nothingIsRecordedForAnExcludedUrlOrTheSdksOwnUpload() async {
            await withSharedRuntime(aConfig(propagationUrls: ["*"], excluded: ["*/health"])) { _ in
                for url in ["https://api.example/health", "https://ingest.example/json/rum"] {
                    let original = URLRequest(url: URL(string: url)!)
                    var request = original
                    #expect(Groundcover.startNetworkRecording(&request) == nil)
                    #expect(request == original)
                }
            }
        }

        @Test func theBodiesAreReported() async throws {
            try await withSharedRuntime { platform in
                var request = URLRequest(url: URL(string: "https://api.example/orders")!)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = Data(#"{"hello":"mobile"}"#.utf8)
                Groundcover.startNetworkRecording(&request)?.finish(
                    response: http(201, ["Content-Type": "application/json"]),
                    data: Data(#"{"ok":true}"#.utf8), error: nil)
                let event = try #require(flushedNetworkEvents(platform).first)
                #expect(event["status"] as? String == "201")
                #expect(event["gc.request.body"] as? String == #"{"hello":"mobile"}"#)
                #expect(event["gc.response.body"] as? String == #"{"ok":true}"#)
            }
        }

        @Test func aFailureIsStatusZeroAndACancelIsNotReported() async {
            await withSharedRuntime { platform in
                for error in [URLError(.cannotConnectToHost), URLError(.cancelled)] {
                    var request = URLRequest(url: URL(string: "https://api.example/x")!)
                    Groundcover.startNetworkRecording(&request)?.finish(
                        response: nil, data: nil, error: error)
                }
                let events = flushedNetworkEvents(platform)
                #expect(events.count == 1)
                #expect(events.first?["status"] as? String == "0")
                #expect(events.first?["error.type"] as? String == "ERR_NETWORK_FAILURE")
            }
        }

        @Test func onlyTheFirstFinishIsReported() async {
            await withSharedRuntime { platform in
                var request = URLRequest(url: URL(string: "https://api.example/x")!)
                let recording = Groundcover.startNetworkRecording(&request)
                recording?.finish(response: http(200), data: nil, error: nil)
                recording?.finish(response: http(500), data: nil, error: nil)
                #expect(flushedNetworkEvents(platform).map { $0["status"] as? String } == ["200"])
            }
        }
    }

    @Suite struct URLSessionAPITests {
        private func expectEchoedTraceparent(_ platform: FakePlatform, path: String) throws {
            let event = try #require(
                flushedNetworkEvents(platform).first { $0["resource_name"] as? String == path })
            let sent = try #require(event["http.request.headers.traceparent"] as? String)
            #expect((event["gc.response.body"] as? String)?.contains(sent) == true)
            #expect(event["status"] as? String == "200")
        }

        @Test func aCompletionHandlerRequestIsRecorded() async throws {
            try await withSharedRuntime { platform in
                await apiRequest(
                    URLSession(configuration: stubbedConfiguration()),
                    URLRequest(url: URL(string: "https://api.example/completion")!))
                try expectEchoedTraceparent(platform, path: "/completion")
            }
        }

        @Test func anAwaitedRequestIsRecorded() async throws {
            try await withSharedRuntime { platform in
                let session = URLSession(configuration: stubbedConfiguration())
                _ = try await session.groundcoverData(
                    for: URLRequest(url: URL(string: "https://api.example/async")!))
                try expectEchoedTraceparent(platform, path: "/async")
            }
        }

        @Test func aDelegateSessionsRequestIsRecordedByItsDelegate() async throws {
            try await withSharedRuntime { platform in
                let delegate = Delegate()
                let session = URLSession(
                    configuration: stubbedConfiguration(), delegate: delegate, delegateQueue: nil)
                await withCheckedContinuation { continuation in
                    delegate.done = { continuation.resume() }
                    session.groundcoverDataTask(
                        with: URLRequest(url: URL(string: "https://api.example/delegate")!)
                    ).resume()
                }
                try expectEchoedTraceparent(platform, path: "/delegate")
            }
        }

        // Used on a session whose delegate isn't a GroundcoverURLSessionDelegate, nothing ever
        // completes the recording: it must go with its task, not stay behind for good (and be
        // found by a later task allocated at the same address).
        @Test func aRecordingNoDelegateCompletesDiesWithItsTask() async throws {
            try await withSharedRuntime { _ in
                weak var recorder: NetworkRecorder?
                let session = URLSession(configuration: stubbedConfiguration())
                autoreleasepool {
                    let task = session.groundcoverDataTask(
                        with: URLRequest(url: URL(string: "https://api.example/no-delegate")!))
                    recorder = DelegateRecordings.shared.recorder(for: task)
                }
                #expect(recorder == nil)
                session.invalidateAndCancel()
            }
        }
    }
}

/// Runs `body` with the SDK started and the URLSession hook armed on it.
private func withHook(
    _ config: GroundcoverConfig = aConfig(propagationUrls: ["*"]),
    _ body: (FakePlatform) async throws -> Void
) async rethrows {
    await MainActor.run { URLSessionTaskObserver.shared.install() }
    try await withSharedRuntime(config) { platform in
        URLSessionTaskObserver.shared.arm(.shared)
        defer { URLSessionTaskObserver.shared.disarm() }
        try await body(platform)
    }
}

/// The network event for `path`, once it lands: the hook ends a recording in `setState:`, which
/// may run after the task's completion handler has returned.
private func eventualNetworkEvent(_ platform: FakePlatform, path: String) async -> [String: Any]? {
    for _ in 0..<100 {
        if let event = flushedNetworkEvents(platform).first(where: {
            $0["resource_name"] as? String == path
        }) {
            return event
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return nil
}

/// `groundcoverDataTask(with:completionHandler:)`, the explicit API's, awaited.
private func apiRequest(_ session: URLSession, _ request: URLRequest) async {
    await withCheckedContinuation { continuation in
        session.groundcoverDataTask(with: request) { _, _, _ in continuation.resume() }.resume()
    }
}

/// `dataTask(with:completionHandler:)`, as an app calls it, awaited: the body it got back.
private func plainRequest(_ session: URLSession, _ request: URLRequest) async -> Data? {
    await withCheckedContinuation { continuation in
        session.dataTask(with: request) { data, _, _ in continuation.resume(returning: data) }
            .resume()
    }
}

extension SharedStateTests {
    @Suite struct URLSessionHookTests {
        @Test func aCompletionHandlerRequestIsRecordedWithTheTraceparentItSent() async throws {
            try await withHook { platform in
                let data = await plainRequest(
                    URLSession(configuration: stubbedConfiguration()),
                    URLRequest(url: URL(string: "https://api.example/plain")!))
                let sent = try #require(echoedHeaders(data)["traceparent"])
                let event = try #require(await eventualNetworkEvent(platform, path: "/plain"))
                #expect(event["http.request.headers.traceparent"] as? String == sent)
                #expect(event["status"] as? String == "200")
                #expect(event["gc.response.body"] as? String == "[response body unavailable]")
            }
        }

        @Test func anAwaitedRequestForAURLIsRecordedWithTheTraceparentItSent() async throws {
            try await withHook { platform in
                let (data, _) = try await URLSession(configuration: stubbedConfiguration()).data(
                    from: URL(string: "https://api.example/awaited")!)
                let sent = try #require(echoedHeaders(data)["traceparent"])
                let event = try #require(await eventualNetworkEvent(platform, path: "/awaited"))
                #expect(event["http.request.headers.traceparent"] as? String == sent)
            }
        }

        @Test func theAppsOwnTraceparentIsSentAndRecordedAsItIs() async throws {
            try await withHook { platform in
                let own = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
                var request = URLRequest(url: URL(string: "https://api.example/own")!)
                request.setValue(own, forHTTPHeaderField: "traceparent")
                let data = await plainRequest(
                    URLSession(configuration: stubbedConfiguration()), request)
                #expect(echoedHeaders(data)["traceparent"] == own)
                let event = try #require(await eventualNetworkEvent(platform, path: "/own"))
                #expect(event["http.request.headers.traceparent"] as? String == own)
            }
        }

        @Test func anUploadsBodyIsReportedByItsTypeOrAsUnavailableNeverEmpty() async throws {
            try await withHook { platform in
                let session = URLSession(configuration: stubbedConfiguration())
                for (path, contentType) in [
                    ("/json", "application/json"), ("/photo", "image/jpeg"),
                ] {
                    var request = URLRequest(url: URL(string: "https://api.example\(path)")!)
                    request.httpMethod = "POST"
                    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
                    await withCheckedContinuation { continuation in
                        session.uploadTask(with: request, from: Data(#"{"a":1}"#.utf8)) { _, _, _ in
                            continuation.resume()
                        }.resume()
                    }
                }
                let json = try #require(await eventualNetworkEvent(platform, path: "/json"))
                #expect(json["gc.request.body"] as? String == "[request body unavailable]")
                let photo = try #require(await eventualNetworkEvent(platform, path: "/photo"))
                #expect(photo["gc.request.body"] as? String == "[image data]")
            }
        }

        @Test func aRequestTheAPIRecordsIsReportedOnceWithItsBody() async throws {
            try await withHook { platform in
                let session = URLSession(configuration: stubbedConfiguration())
                await apiRequest(session, URLRequest(url: URL(string: "https://api.example/api")!))
                // A later request through the hook: once it lands, so has a second event for the
                // first, had there been one.
                _ = await plainRequest(
                    session, URLRequest(url: URL(string: "https://api.example/later")!))
                _ = try #require(await eventualNetworkEvent(platform, path: "/later"))
                let events = flushedNetworkEvents(platform).filter {
                    $0["resource_name"] as? String == "/api"
                }
                #expect(events.count == 1)
                #expect((events.first?["gc.response.body"] as? String)?.contains("headers") == true)
            }
        }

        @Test func aFailureIsReportedAndACancelIsNot() async throws {
            try await withHook { platform in
                let session = URLSession(
                    configuration: stubbedConfiguration(FailOrStallProtocol.self))
                await withCheckedContinuation { continuation in
                    let stalled = session.dataTask(
                        with: URLRequest(url: URL(string: "https://api.example/stall")!)
                    ) { _, _, _ in continuation.resume() }
                    stalled.resume()
                    stalled.cancel()
                }
                _ = await plainRequest(
                    session, URLRequest(url: URL(string: "https://api.example/fail")!))
                let failed = try #require(await eventualNetworkEvent(platform, path: "/fail"))
                #expect(failed["status"] as? String == "0")
                #expect(failed["error.type"] as? String == "ERR_NETWORK_FAILURE")
                #expect(
                    !flushedNetworkEvents(platform).contains {
                        $0["resource_name"] as? String == "/stall"
                    })
            }
        }

        @Test func anEventStreamTheAppCancelsIsReportedAsAnswered() async throws {
            try await withHook { platform in
                let session = URLSession(
                    configuration: stubbedConfiguration(FailOrStallProtocol.self))
                // As a streaming client reads one: open it, read it, and leave by cancelling it.
                // The task completes once its reader sees the cancel.
                let (bytes, _) = try await session.bytes(
                    for: URLRequest(url: URL(string: "https://api.example/stream")!))
                let reader = Task { for try await _ in bytes.lines {} }
                bytes.task.cancel()
                _ = await reader.result
                let event = try #require(await eventualNetworkEvent(platform, path: "/stream"))
                #expect(event["status"] as? String == "200")
                #expect(event["gc.response.body"] as? String == "[unreadable response body]")
            }
        }

        @Test func nothingIsRecordedOrSentWhileDisarmed() async throws {
            await MainActor.run { URLSessionTaskObserver.shared.install() }
            try await withSharedRuntime { platform in
                let session = URLSession(configuration: stubbedConfiguration())
                let data = await plainRequest(
                    session, URLRequest(url: URL(string: "https://api.example/idle")!))
                #expect(echoedHeaders(data)["traceparent"] == nil)
                // A request through the API, as a control: once it lands, so would have the other.
                await apiRequest(
                    session, URLRequest(url: URL(string: "https://api.example/control")!))
                _ = try #require(await eventualNetworkEvent(platform, path: "/control"))
                #expect(
                    !flushedNetworkEvents(platform).contains {
                        $0["resource_name"] as? String == "/idle"
                    })
            }
        }
    }
}

@Suite struct URLSessionHookMethodTests {
    /// What the hook expects of this OS: if one of these fails, the hook skips that method and
    /// records nothing, so the failure is the first sign.
    @Test func theTaskMethodsAreTheOnesTheHookExpects() throws {
        // NSURLSessionTask's own, not inherited.
        #expect(
            Swizzle.method(URLSessionTask.self, #selector(URLSessionTask.resume), signature: "v@:")
                != nil)
        #expect(
            Swizzle.method(
                URLSessionTask.self, NSSelectorFromString("setState:"), signature: "v@:q")
                != nil)
        let task = URLSession(configuration: .ephemeral).dataTask(
            with: URL(string: "https://api.example/x")!)
        #expect(
            Swizzle.method(
                try #require(object_getClass(task)), NSSelectorFromString("setCurrentRequest:"),
                signature: "v@:@", inherited: true) != nil)
    }
}
