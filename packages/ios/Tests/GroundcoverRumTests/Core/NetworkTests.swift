import Foundation
import Testing

@testable import GroundcoverRum

// Network shaping. The shape cases repeat the React Native SDK's characterization snapshots key for
// key, as the Flutter port does: a diff here is a wire change between the SDKs.

private func aRequest(
    method: String = "GET",
    url: String = "https://api.example.com/v1/users?token=abc&page=2",
    status: Int? = 200,
    requestHeaders: [String: String] = [:],
    requestBody: String = "",
    responseHeaders: [String: String] = [:],
    responseBody: String = "",
    errorType: NetworkErrorType? = nil
) -> NetworkCapture {
    NetworkCapture(
        method: method, url: url, startMs: 1_700_000_000_000, endMs: 1_700_000_000_250,
        status: status, requestHeaders: requestHeaders, requestBody: requestBody,
        responseHeaders: responseHeaders, responseBody: responseBody, errorType: errorType)
}

private func shape(
    _ capture: NetworkCapture, privacy: PrivacyOptions? = nil,
    tracing: ResolvedTracing = ResolvedTracing()
) -> (attributes: String, shaped: EnrichInput) {
    let shaped = shapeNetworkEvent(capture, privacy: resolvePrivacy(privacy), tracing: tracing)
    return (encodeJson(flattenAttributes(shaped.attributes)), shaped)
}

private struct FixedIds: IdGenerator {
    func generateId() -> String { "event-id" }
    func generateSpanId() -> String { "00f067aa0ba902b7" }
    func generateTraceId() -> String { "00000000000000004bf92f3577b34da6" }
}

@Suite struct ShapeNetworkEventTests {
    @Test func anAbsoluteUrlUnderDefaultPrivacyRedactsQueryHeadersAndBodies() {
        let out = shape(
            aRequest(
                method: "post",
                requestHeaders: [
                    "authorization": "Bearer s3cret", "content-type": "application/json",
                    "x-plain": "v",
                ],
                requestBody: #"{"password":"hunter2","name":"ada"}"#,
                responseHeaders: ["set-cookie": "sid=1", "content-type": "application/json"],
                responseBody: #"{"ok":true}"#))
        #expect(
            out.attributes
                == encodeJson([
                    "gc.request.body": #"{"password":"[REDACTED]","name":"ada"}"#,
                    "gc.response.body": #"{"ok":true}"#,
                    "http.method": "post",
                    "http.path": "/v1/users",
                    "http.request.headers.authorization": "[REDACTED]",
                    "http.request.headers.content-type": "application/json",
                    "http.request.headers.x-plain": "v",
                    "http.request.method": "post",
                    "http.response.headers.content-type": "application/json",
                    "http.response.headers.set-cookie": "[REDACTED]",
                    "http.response.status_code": "200",
                    "http.route": "/v1/users",
                    "http.status": "200",
                    "operation.name": "POST",
                    "resource_name": "/v1/users",
                    "status": "200",
                    "subType": "POST",
                    "type": "HTTP",
                    "url.full": "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2",
                ]))
        #expect(out.shaped.spanName == "POST /v1/users")
        #expect(out.shaped.timestamp == 1_700_000_000_000_000_000)
        #expect(out.shaped.endTimestamp == 1_700_000_000_250_000_000)
        // None on the request: the enricher draws its own.
        #expect(out.shaped.traceId == "")
        #expect(out.shaped.spanId == "")
    }

    @Test func aUrlThatIsNotAbsoluteIsKeptWhole() {
        let kept = "/api/items?secret=%5BREDACTED%5D&q=x"
        let out = shape(aRequest(url: "/api/items?secret=1&q=x"))
        #expect(
            out.attributes
                == encodeJson([
                    "gc.request.body": "", "gc.response.body": "", "http.method": "GET",
                    "http.path": kept, "http.request.method": "GET",
                    "http.response.status_code": "200", "http.route": kept, "http.status": "200",
                    "operation.name": "GET", "resource_name": kept, "status": "200",
                    "subType": "GET", "type": "HTTP", "url.full": kept,
                ]))
        #expect(out.shaped.spanName == "GET \(kept)")
    }

    @Test func aFailedRequestCarriesStatus0AndTheErrorType() {
        let out = shape(aRequest(status: 0, errorType: .networkFailure))
        #expect(
            out.attributes
                == encodeJson([
                    "error.type": "ERR_NETWORK_FAILURE", "gc.request.body": "",
                    "gc.response.body": "", "http.method": "GET", "http.path": "/v1/users",
                    "http.request.method": "GET", "http.response.status_code": "0",
                    "http.route": "/v1/users", "http.status": "0", "operation.name": "GET",
                    "resource_name": "/v1/users", "status": "0", "subType": "GET", "type": "HTTP",
                    "url.full": "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2",
                ]))
    }

    @Test func privacyLevelAllowSkipsRedactionButNotBuiltInHeaders() {
        let out = shape(
            aRequest(
                requestHeaders: ["authorization": "Bearer s3cret"],
                requestBody: #"{"password":"hunter2"}"#),
            privacy: PrivacyOptions(level: .allow))
        #expect(
            out.attributes
                == encodeJson([
                    "gc.request.body": #"{"password":"hunter2"}"#, "gc.response.body": "",
                    "http.method": "GET", "http.path": "/v1/users",
                    "http.request.headers.authorization": "[REDACTED]",
                    "http.request.method": "GET", "http.response.status_code": "200",
                    "http.route": "/v1/users", "http.status": "200", "operation.name": "GET",
                    "resource_name": "/v1/users", "status": "200", "subType": "GET",
                    "type": "HTTP",
                    "url.full": "https://api.example.com/v1/users?token=abc&page=2",
                ]))
    }

    @Test func traceIdsComeFromTraceparent() {
        let traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        let out = shapeNetworkEvent(
            aRequest(requestHeaders: ["traceparent": traceparent]), privacy: resolvePrivacy(nil),
            tracing: ResolvedTracing())
        #expect(out.traceId == "0af7651916cd43dd8448eb211c80319c")
        #expect(out.spanId == "b7ad6b7169203331")
    }

    @Test func traceIdsFromConfiguredIdHeadersAndPropagationHeaders() {
        let out = shapeNetworkEvent(
            aRequest(requestHeaders: [
                "x-trace-id": "123",
                "x-custom-trace": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            ]),
            privacy: resolvePrivacy(nil),
            tracing: ResolvedTracing(
                propagationHeaders: ["X-Custom-Trace"], traceIdHeaderName: "X-Trace-Id",
                spanIdHeaderName: "X-Span-Id"))
        #expect(out.traceId == "123")
        #expect(out.spanId == "b7ad6b7169203331")
    }

    @Test func aRootUrlAndAMissingMethod() {
        let out = shape(aRequest(method: "", url: "https://api.example.com"))
        #expect(
            out.attributes
                == encodeJson([
                    "gc.request.body": "", "gc.response.body": "", "http.method": "UNKNOWN",
                    "http.path": "/", "http.request.method": "UNKNOWN",
                    "http.response.status_code": "200", "http.route": "/", "http.status": "200",
                    "operation.name": "UNKNOWN", "resource_name": "/", "status": "200",
                    "subType": "UNKNOWN", "type": "HTTP", "url.full": "https://api.example.com",
                ]))
        #expect(out.shaped.spanName == "UNKNOWN /")
    }

    @Test func aBodyOverTheCapIsTruncatedAfterRedaction() {
        let out = shapeNetworkEvent(
            aRequest(responseBody: String(repeating: "x", count: 30)),
            privacy: resolvePrivacy(nil), tracing: ResolvedTracing(), maxBodyLength: 10)
        #expect(
            flattenAttributes(out.attributes)["gc.response.body"] as? String
                == String(repeating: "x", count: 10))
    }
}

@Suite struct NetworkBodyTests {
    @Test func textByPreciseMimeRulesNeverBySubstring() {
        for contentType in [
            "application/json", "application/JSON; charset=utf-8", "text/plain",
            "application/problem+json", "application/atom+xml",
            "application/x-www-form-urlencoded", "application/graphql",
        ] {
            #expect(isTextualContentType(contentType), "\(contentType)")
        }
        for contentType in [
            "", "application/octet-stream",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/jsonx", "image/png",
        ] {
            #expect(!isTextualContentType(contentType), "\(contentType)")
        }
    }

    @Test func nonTextBodiesGetALabelAndMultipartItsOwn() {
        #expect(classifyBody("multipart/form-data; boundary=x") == "[form data]")
        #expect(classifyBody("image/png") == "[image data]")
        #expect(classifyBody("application/pdf") == "[pdf data]")
        #expect(classifyBody("application/x-protobuf") == "[protobuf data]")
        #expect(classifyBody("application/zip") == "[archive data]")
        #expect(classifyBody("") == "[binary data]")
        #expect(classifyBody("application/json") == nil)
    }

    @Test func knownEmptyResponsesAndEventStreams() {
        func empty(_ method: String, _ status: Int, _ headers: [String: String] = [:]) -> Bool {
            isKnownEmptyResponse(method: method, status: status, headers: headers)
        }
        #expect(empty("head", 200))
        #expect(empty("GET", 204))
        #expect(empty("GET", 304))
        #expect(empty("GET", 200, ["content-length": " 0"]))
        #expect(!empty("GET", 200))
        #expect(isEventStream("text/event-stream; charset=utf-8"))
    }

    @Test func theCapCountsUtf8BytesAndIsInclusive() {
        #expect(capBody("", maxBytes: 4, tooLargePlaceholder: "big") == "")
        #expect(capBody("abc", maxBytes: 4, tooLargePlaceholder: "big") == "abc")
        #expect(capBody("abcd", maxBytes: 4, tooLargePlaceholder: "big") == "big")
        // Two characters, four bytes.
        #expect(capBody("éé", maxBytes: 4, tooLargePlaceholder: "big") == "big")
    }
}

@Suite struct TraceTests {
    @Test func idsMakeAWellFormedTraceparentAndDecimalForms() {
        let ids = generateTraceIds(FixedIds())
        #expect(ids.traceparent == "00-00000000000000004bf92f3577b34da6-00f067aa0ba902b7-01")
        #expect(ids.decimalTraceId == "5474458728733560230")
        #expect(ids.decimalSpanId == "67667974448284343")
    }

    @Test func aFull128BitTraceIdConvertsToDecimalExactly() {
        #expect(
            hexToDecimal("ffffffffffffffffffffffffffffffff")
                == "340282366920938463463374607431768211455")
        #expect(hexToDecimal("not hex") == "not hex")
    }

    @Test func headersAreTraceparentByDefaultAndTheConfiguredOnesOtherwise() {
        let ids = generateTraceIds(FixedIds())
        #expect(buildTraceHeaders(ResolvedTracing(), ids) == ["traceparent": ids.traceparent])
        #expect(
            buildTraceHeaders(
                ResolvedTracing(
                    propagationHeaders: ["x-a", "bad name", "x-a"], traceIdHeaderName: "x-trace",
                    spanIdHeaderName: "x-span",
                    origin: TracingOrigin(name: "x-origin", value: "rum")),
                ids)
                == [
                    "x-origin": "rum", "x-trace": ids.decimalTraceId, "x-span": ids.decimalSpanId,
                    "x-a": ids.traceparent,
                ])
    }

    @Test func propagationUrlsMatchInFullWithOnlyStarAsAWildcard() {
        let patterns = ["https://api.example.com/*"]
        #expect(matchesPropagationUrl(["https://api.example.com/v1"], patterns))
        #expect(!matchesPropagationUrl(["https://api-example.com/v1"], patterns))
        #expect(!matchesPropagationUrl(["https://evil.com/?https://api.example.com/x"], patterns))
        #expect(!matchesPropagationUrl(["https://a.com"], []))
    }
}

@Suite struct ShouldIgnoreUrlTests {
    @Test func ignoresTheSdksOwnEndpoint() {
        #expect(
            shouldIgnoreUrl("https://ingest.example/json/rum", endpoint: "https://ingest.example"))
        #expect(!shouldIgnoreUrl("https://api.example/x", endpoint: "https://ingest.x"))
    }

    @Test func exactStringsRegularExpressionsAndUnanchoredStarGlobs() throws {
        let excluded: [URLPattern] = [
            "/api/health",
            .regex(try NSRegularExpression(pattern: #"\.(jpg|png)$"#, options: .caseInsensitive)),
            "https://cdn.example.com/*",
        ]
        func ignored(_ url: String) -> Bool { shouldIgnoreUrl(url, excludedUrls: excluded) }
        #expect(ignored("/api/health"))
        #expect(!ignored("/api/health/details"))
        #expect(ignored("https://example.com/image.PNG"))
        #expect(ignored("https://cdn.example.com/a.js"))
        #expect(!ignored("https://cdn-example.com/a.js"))
    }

    @Test func aGlobOpeningOrClosingOnStarStillMatchesAnywhere() {
        func ignored(_ url: String, _ glob: String) -> Bool {
            shouldIgnoreUrl(url, excludedUrls: [.string(glob)])
        }
        #expect(ignored("https://api.example/v1/health?x=1", "*/health*"))
        #expect(ignored("https://api.example/v1/healthy", "*/health"))
        #expect(!ignored("https://api.example/v1/ok", "*/health*"))
        #expect(ignored("https://anything.example/", "*"))
        #expect(!ignored("https://img.example/a.PNG", "*.png"))
        #expect(ignored("https://img.example/a.png", "*.png"))
    }

    @Test func aQuestionMarkInAGlobMatchesAnyOneCharacter() {
        func ignored(_ url: String, _ glob: String) -> Bool {
            shouldIgnoreUrl(url, excludedUrls: [.string(glob)])
        }
        #expect(ignored("https://api.example/v1/users", "/v?/users"))
        #expect(ignored("https://api.example/v2/users", "/v?/users"))
        #expect(!ignored("https://api.example/v10/users", "/v?/users"))
        let url = "https://auth.example.com/token?grant=refresh"
        #expect(ignored(url, url), "a ? in the URL itself matches the ? it stands for")
    }
}
