package com.groundcover.rum.core.events.network

import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.RedactKind
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.common.truncate
import com.groundcover.rum.core.config.ResolvedTracing
import com.groundcover.rum.core.events.EnrichInput
import com.groundcover.rum.core.events.NetworkCapture
import com.groundcover.rum.core.privacy.EffectivePrivacy
import com.groundcover.rum.core.privacy.RedactOptions
import com.groundcover.rum.core.privacy.redactBody
import com.groundcover.rum.core.privacy.redactHeaders
import com.groundcover.rum.core.privacy.redactOptions
import com.groundcover.rum.core.privacy.redactUrl

// A captured request as the `network` event the backend ingests. Everything after interception:
// route derivation, query, header and body redaction, body truncation, trace ids and the span name.

/**
 * Request and response headers as sent on the wire: sensitive values redacted, each value
 * truncated. Built-in sensitive headers are always stripped; `allow` only opts out of the app's
 * sensitiveKeys and redactor.
 */
internal fun formatNetworkHeaders(
    headers: Map<String, String>,
    privacy: EffectivePrivacy
): Map<String, String> {
    val opts = if (privacy.level == PrivacyLevel.ALLOW) RedactOptions() else privacy.redactOptions()
    return redactHeaders(headers, opts).mapValues { (_, value) -> truncate(value) }
}

// RN's absolute-URL path extractor: scheme://authority(/path)?(?#...).
private val URL_PATH = Regex("^[a-z][a-z0-9+.-]*://[^/?#]*([^?#]*)", RegexOption.IGNORE_CASE)

/**
 * The route of [url]: its path, without the query; `/` for a root URL. A URL that isn't absolute
 * is kept whole.
 */
internal fun networkPath(url: String): String {
    val match = URL_PATH.find(url) ?: return url
    return match.groupValues[1].ifEmpty { "/" }
}

internal fun shapeNetworkEvent(
    raw: NetworkCapture,
    privacy: EffectivePrivacy,
    tracing: ResolvedTracing,
    maxBodyLength: Int = MAX_NETWORK_BODY_BYTES
): EnrichInput {
    val queryOpts = privacy.redactOptions(RedactKind.QUERY)
    var path = networkPath(raw.url)
    var fullUrl = raw.url
    if (privacy.shouldMaskNetworkQueryParams) {
        // A parsed route has no query (a no-op); an unparseable URL kept whole does.
        path = redactUrl(path, queryOpts)
        fullUrl = redactUrl(fullUrl, queryOpts)
    }

    val method = raw.method.ifEmpty { "UNKNOWN" }.uppercase()
    // As sent (the caller's case), or UNKNOWN like every other method field.
    val sentMethod = raw.method.ifEmpty { "UNKNOWN" }
    val status = raw.status?.toString()
    val ids = extractTraceIds(raw.requestHeaders, tracing)

    // Redacted BEFORE truncating, so the body stays parseable JSON for key-based redaction.
    fun body(text: String, kind: RedactKind) = truncate(
        if (privacy.shouldMaskNetworkBodies) {
            redactBody(
                text,
                privacy.redactOptions(kind)
            )
        } else {
            text
        },
        maxLength = maxBodyLength
    )

    val request = linkedMapOf<String, Any?>(
        "headers" to formatNetworkHeaders(raw.requestHeaders, privacy),
        "method" to sentMethod
    )
    val response = linkedMapOf<String, Any?>(
        "headers" to formatNetworkHeaders(raw.responseHeaders, privacy)
    )
    if (status != null) response["status_code"] = status
    val http = linkedMapOf<String, Any?>("route" to path, "path" to path, "method" to sentMethod)
    if (status != null) http["status"] = status
    http["request"] = request
    http["response"] = response

    val attributes = linkedMapOf<String, Any?>(
        "type" to "HTTP",
        "operation" to mapOf("name" to method),
        "resource_name" to path
    )
    if (status != null) attributes["status"] = status
    attributes["subType"] = method
    attributes["url"] = mapOf("full" to fullUrl)
    attributes["http"] = http
    raw.errorType?.let { attributes["error"] = mapOf("type" to it.wireName) }
    attributes["gc"] = mapOf(
        "request" to mapOf("body" to body(raw.requestBody, RedactKind.REQUEST_BODY)),
        "response" to mapOf("body" to body(raw.responseBody, RedactKind.RESPONSE_BODY))
    )

    return EnrichInput(
        type = "network",
        timestamp = observedAt(raw.startMs),
        endTimestamp = observedAt(raw.endMs),
        // The normalized method, like operation.name: `post` and `POST` are one span.
        spanName = "$method $path",
        traceId = ids.traceId,
        spanId = ids.spanId,
        attributes = attributes
    )
}

// An interceptor's clock reading in ns, or null when it isn't a usable time, so the enricher stamps
// the event instead.
private fun observedAt(ms: Long) = if (ms > 0) msToNs(ms) else null
