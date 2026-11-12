package com.groundcover.rum.core.events.network

import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.TracingOrigin
import com.groundcover.rum.UrlPattern
import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.config.ResolvedTracing
import com.groundcover.rum.core.events.EnrichInput
import com.groundcover.rum.core.events.NetworkCapture
import com.groundcover.rum.core.events.NetworkErrorType
import com.groundcover.rum.core.events.flattenAttributes
import com.groundcover.rum.core.privacy.resolvePrivacy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Network shaping. The shape cases repeat the React Native SDK's characterization snapshots key for
// key, as the Flutter port does: a diff here is a wire change between the SDKs.

private fun aRequest(
    method: String = "GET",
    url: String = "https://api.example.com/v1/users?token=abc&page=2",
    status: Int? = 200,
    requestHeaders: Map<String, String> = emptyMap(),
    requestBody: String = "",
    responseHeaders: Map<String, String> = emptyMap(),
    responseBody: String = "",
    errorType: NetworkErrorType? = null
) = NetworkCapture(
    method = method,
    url = url,
    startMs = 1_700_000_000_000L,
    endMs = 1_700_000_000_250L,
    status = status,
    requestHeaders = requestHeaders,
    requestBody = requestBody,
    responseHeaders = responseHeaders,
    responseBody = responseBody,
    errorType = errorType
)

private class Shaped(val attributes: Map<String, Any?>, val shaped: EnrichInput)

private fun shape(
    capture: NetworkCapture,
    privacy: PrivacyOptions? = null,
    tracing: ResolvedTracing = ResolvedTracing()
): Shaped {
    val shaped = shapeNetworkEvent(capture, resolvePrivacy(privacy), tracing)
    return Shaped(flattenAttributes(shaped.attributes), shaped)
}

private class FixedIds : IdGenerator {
    override fun generateId() = "event-id"

    override fun generateSpanId() = "00f067aa0ba902b7"

    override fun generateTraceId() = "00000000000000004bf92f3577b34da6"
}

class ShapeNetworkEventTest {
    @Test
    fun anAbsoluteUrlUnderDefaultPrivacyRedactsQueryHeadersAndBodies() {
        val out = shape(
            aRequest(
                method = "post",
                requestHeaders = mapOf(
                    "authorization" to "Bearer s3cret",
                    "content-type" to "application/json",
                    "x-plain" to "v"
                ),
                requestBody = """{"password":"hunter2","name":"ada"}""",
                responseHeaders = mapOf(
                    "set-cookie" to "sid=1",
                    "content-type" to "application/json"
                ),
                responseBody = """{"ok":true}"""
            )
        )
        assertEquals(
            mapOf(
                "gc.request.body" to """{"password":"[REDACTED]","name":"ada"}""",
                "gc.response.body" to """{"ok":true}""",
                "http.method" to "post",
                "http.path" to "/v1/users",
                "http.request.headers.authorization" to "[REDACTED]",
                "http.request.headers.content-type" to "application/json",
                "http.request.headers.x-plain" to "v",
                "http.request.method" to "post",
                "http.response.headers.content-type" to "application/json",
                "http.response.headers.set-cookie" to "[REDACTED]",
                "http.response.status_code" to "200",
                "http.route" to "/v1/users",
                "http.status" to "200",
                "operation.name" to "POST",
                "resource_name" to "/v1/users",
                "status" to "200",
                "subType" to "POST",
                "type" to "HTTP",
                "url.full" to "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2"
            ),
            out.attributes
        )
        assertEquals("POST /v1/users", out.shaped.spanName)
        assertEquals(1_700_000_000_000_000_000L, out.shaped.timestamp)
        assertEquals(1_700_000_000_250_000_000L, out.shaped.endTimestamp)
        // None on the request: the enricher draws its own.
        assertEquals("", out.shaped.traceId)
        assertEquals("", out.shaped.spanId)
    }

    @Test
    fun aUrlThatIsNotAbsoluteIsKeptWhole() {
        val kept = "/api/items?secret=%5BREDACTED%5D&q=x"
        val out = shape(aRequest(url = "/api/items?secret=1&q=x"))
        assertEquals(
            mapOf(
                "gc.request.body" to "",
                "gc.response.body" to "",
                "http.method" to "GET",
                "http.path" to kept,
                "http.request.method" to "GET",
                "http.response.status_code" to "200",
                "http.route" to kept,
                "http.status" to "200",
                "operation.name" to "GET",
                "resource_name" to kept,
                "status" to "200",
                "subType" to "GET",
                "type" to "HTTP",
                "url.full" to kept
            ),
            out.attributes
        )
        assertEquals("GET $kept", out.shaped.spanName)
    }

    @Test
    fun aFailedRequestCarriesStatus0AndTheErrorType() {
        val out = shape(aRequest(status = 0, errorType = NetworkErrorType.NETWORK_FAILURE))
        assertEquals(
            mapOf(
                "error.type" to "ERR_NETWORK_FAILURE",
                "gc.request.body" to "",
                "gc.response.body" to "",
                "http.method" to "GET",
                "http.path" to "/v1/users",
                "http.request.method" to "GET",
                "http.response.status_code" to "0",
                "http.route" to "/v1/users",
                "http.status" to "0",
                "operation.name" to "GET",
                "resource_name" to "/v1/users",
                "status" to "0",
                "subType" to "GET",
                "type" to "HTTP",
                "url.full" to "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2"
            ),
            out.attributes
        )
    }

    @Test
    fun privacyLevelAllowSkipsRedactionButNotBuiltInHeaders() {
        val out = shape(
            aRequest(
                requestHeaders = mapOf("authorization" to "Bearer s3cret"),
                requestBody = """{"password":"hunter2"}"""
            ),
            privacy = PrivacyOptions(level = PrivacyLevel.ALLOW)
        )
        assertEquals(
            mapOf(
                "gc.request.body" to """{"password":"hunter2"}""",
                "gc.response.body" to "",
                "http.method" to "GET",
                "http.path" to "/v1/users",
                "http.request.headers.authorization" to "[REDACTED]",
                "http.request.method" to "GET",
                "http.response.status_code" to "200",
                "http.route" to "/v1/users",
                "http.status" to "200",
                "operation.name" to "GET",
                "resource_name" to "/v1/users",
                "status" to "200",
                "subType" to "GET",
                "type" to "HTTP",
                "url.full" to "https://api.example.com/v1/users?token=abc&page=2"
            ),
            out.attributes
        )
    }

    @Test
    fun traceIdsComeFromTraceparent() {
        val traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        val out = shapeNetworkEvent(
            aRequest(requestHeaders = mapOf("traceparent" to traceparent)),
            resolvePrivacy(null),
            ResolvedTracing()
        )
        assertEquals("0af7651916cd43dd8448eb211c80319c", out.traceId)
        assertEquals("b7ad6b7169203331", out.spanId)
    }

    @Test
    fun traceIdsFromConfiguredIdHeadersAndPropagationHeaders() {
        val out = shapeNetworkEvent(
            aRequest(
                requestHeaders = mapOf(
                    "x-trace-id" to "123",
                    "x-custom-trace" to "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
                )
            ),
            resolvePrivacy(null),
            ResolvedTracing(
                propagationHeaders = listOf("X-Custom-Trace"),
                traceIdHeaderName = "X-Trace-Id",
                spanIdHeaderName = "X-Span-Id"
            )
        )
        assertEquals("123", out.traceId)
        assertEquals("b7ad6b7169203331", out.spanId)
    }

    @Test
    fun aRootUrlAndAMissingMethod() {
        val out = shape(aRequest(method = "", url = "https://api.example.com"))
        assertEquals(
            mapOf(
                "gc.request.body" to "",
                "gc.response.body" to "",
                "http.method" to "UNKNOWN",
                "http.path" to "/",
                "http.request.method" to "UNKNOWN",
                "http.response.status_code" to "200",
                "http.route" to "/",
                "http.status" to "200",
                "operation.name" to "UNKNOWN",
                "resource_name" to "/",
                "status" to "200",
                "subType" to "UNKNOWN",
                "type" to "HTTP",
                "url.full" to "https://api.example.com"
            ),
            out.attributes
        )
        assertEquals("UNKNOWN /", out.shaped.spanName)
    }

    @Test
    fun aBodyOverTheCapIsTruncatedAfterRedaction() {
        val out = shapeNetworkEvent(
            aRequest(responseBody = "x".repeat(30)),
            resolvePrivacy(null),
            ResolvedTracing(),
            maxBodyLength = 10
        )
        assertEquals("x".repeat(10), flattenAttributes(out.attributes)["gc.response.body"])
    }
}

class NetworkBodyTest {
    @Test
    fun textByPreciseMimeRulesNeverBySubstring() {
        for (contentType in listOf(
            "application/json",
            "application/JSON; charset=utf-8",
            "text/plain",
            "application/problem+json",
            "application/atom+xml",
            "application/x-www-form-urlencoded",
            "application/graphql"
        )) {
            assertTrue(contentType, isTextualContentType(contentType))
        }
        for (contentType in listOf(
            "",
            "application/octet-stream",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/jsonx",
            "image/png"
        )) {
            assertFalse(contentType, isTextualContentType(contentType))
        }
    }

    @Test
    fun nonTextBodiesGetALabelAndMultipartItsOwn() {
        assertEquals("[form data]", classifyBody("multipart/form-data; boundary=x"))
        assertEquals("[image data]", classifyBody("image/png"))
        assertEquals("[pdf data]", classifyBody("application/pdf"))
        assertEquals("[protobuf data]", classifyBody("application/x-protobuf"))
        assertEquals("[archive data]", classifyBody("application/zip"))
        assertEquals("[binary data]", classifyBody(""))
        assertNull(classifyBody("application/json"))
    }

    @Test
    fun knownEmptyResponsesAndEventStreams() {
        fun empty(method: String, status: Int, headers: Map<String, String> = emptyMap()) =
            isKnownEmptyResponse(method, status, headers)
        assertTrue(empty("head", 200))
        assertTrue(empty("GET", 204))
        assertTrue(empty("GET", 304))
        assertTrue(empty("GET", 200, mapOf("content-length" to " 0")))
        assertFalse(empty("GET", 200))
        assertTrue(isEventStream("text/event-stream; charset=utf-8"))
    }

    @Test
    fun theCapCountsUtf8BytesAndIsInclusive() {
        assertEquals("", capBody("", maxBytes = 4, tooLargePlaceholder = "big"))
        assertEquals("abc", capBody("abc", maxBytes = 4, tooLargePlaceholder = "big"))
        assertEquals("big", capBody("abcd", maxBytes = 4, tooLargePlaceholder = "big"))
        // Two characters, four bytes.
        assertEquals("big", capBody("éé", maxBytes = 4, tooLargePlaceholder = "big"))
    }
}

class TraceTest {
    @Test
    fun idsMakeAWellFormedTraceparentAndDecimalForms() {
        val ids = generateTraceIds(FixedIds())
        assertEquals(
            "00-00000000000000004bf92f3577b34da6-00f067aa0ba902b7-01",
            ids.traceparent
        )
        assertEquals("5474458728733560230", ids.decimalTraceId)
        assertEquals("67667974448284343", ids.decimalSpanId)
    }

    @Test
    fun aFull128BitTraceIdConvertsToDecimalExactly() {
        assertEquals(
            "340282366920938463463374607431768211455",
            hexToDecimal("ffffffffffffffffffffffffffffffff")
        )
        assertEquals("not hex", hexToDecimal("not hex"))
    }

    @Test
    fun headersAreTraceparentByDefaultAndTheConfiguredOnesOtherwise() {
        val ids = generateTraceIds(FixedIds())
        assertEquals(
            mapOf("traceparent" to ids.traceparent),
            buildTraceHeaders(ResolvedTracing(), ids)
        )
        assertEquals(
            mapOf(
                "x-origin" to "rum",
                "x-trace" to ids.decimalTraceId,
                "x-span" to ids.decimalSpanId,
                "x-a" to ids.traceparent
            ),
            buildTraceHeaders(
                ResolvedTracing(
                    propagationHeaders = listOf("x-a", "bad name", "x-a"),
                    traceIdHeaderName = "x-trace",
                    spanIdHeaderName = "x-span",
                    origin = TracingOrigin("x-origin", "rum")
                ),
                ids
            )
        )
    }

    @Test
    fun propagationUrlsMatchInFullWithOnlyStarAsAWildcard() {
        val patterns = listOf("https://api.example.com/*")
        assertTrue(matchesPropagationUrl(listOf("https://api.example.com/v1"), patterns))
        assertFalse(matchesPropagationUrl(listOf("https://api-example.com/v1"), patterns))
        assertFalse(
            matchesPropagationUrl(listOf("https://evil.com/?https://api.example.com/x"), patterns)
        )
        assertFalse(matchesPropagationUrl(listOf("https://a.com"), emptyList()))
    }
}

class ShouldIgnoreUrlTest {
    @Test
    fun ignoresTheSdksOwnEndpoint() {
        assertTrue(
            shouldIgnoreUrl("https://ingest.example/json/rum", endpoint = "https://ingest.example")
        )
        assertFalse(shouldIgnoreUrl("https://api.example/x", endpoint = "https://ingest.x"))
    }

    @Test
    fun exactStringsRegularExpressionsAndUnanchoredStarGlobs() {
        val excluded = listOf(
            UrlPattern.of("/api/health"),
            UrlPattern.of(Regex("\\.(jpg|png)$", RegexOption.IGNORE_CASE)),
            UrlPattern.of("https://cdn.example.com/*")
        )
        fun ignored(url: String) = shouldIgnoreUrl(url, excludedUrls = excluded)
        assertTrue(ignored("/api/health"))
        assertFalse(ignored("/api/health/details"))
        assertTrue(ignored("https://example.com/image.PNG"))
        assertTrue(ignored("https://cdn.example.com/a.js"))
        assertFalse(ignored("https://cdn-example.com/a.js"))
    }

    @Test
    fun aGlobOpeningOrClosingOnStarStillMatchesAnywhere() {
        fun ignored(url: String, glob: String) =
            shouldIgnoreUrl(url, excludedUrls = listOf(UrlPattern.of(glob)))
        assertTrue(ignored("https://api.example/v1/health?x=1", "*/health*"))
        assertTrue(ignored("https://api.example/v1/healthy", "*/health"))
        assertFalse(ignored("https://api.example/v1/ok", "*/health*"))
        assertTrue(ignored("https://anything.example/", "*"))
        assertFalse(ignored("https://img.example/a.PNG", "*.png"))
        assertTrue(ignored("https://img.example/a.png", "*.png"))
    }

    @Test
    fun aQuestionMarkInAGlobMatchesAnyOneCharacter() {
        fun ignored(url: String, glob: String) =
            shouldIgnoreUrl(url, excludedUrls = listOf(UrlPattern.of(glob)))
        assertTrue(ignored("https://api.example/v1/users", "/v?/users"))
        assertTrue(ignored("https://api.example/v2/users", "/v?/users"))
        assertFalse(ignored("https://api.example/v10/users", "/v?/users"))
        val url = "https://auth.example.com/token?grant=refresh"
        assertTrue("a ? in the URL itself matches the ? it stands for", ignored(url, url))
    }
}
