package com.groundcover.rum.core.events.network

import com.groundcover.rum.RumEventName
import com.groundcover.rum.UrlPattern
import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.config.ResolvedTracing
import com.groundcover.rum.core.config.SdkConfig
import java.net.URI

/**
 * What network capture asks before a request goes out: whether it is captured, and which trace
 * headers it carries. An immutable copy of the configuration as it is now, which the core thread
 * publishes after every change, so capture reads it on the caller's thread without waiting.
 */
internal class NetworkPolicy(config: SdkConfig) {
    private val enabled = config.options.isEnabled(RumEventName.NETWORK)
    private val endpoint = config.endpoint
    private val excludedUrls: List<UrlPattern> = config.options.excludedUrls.toList()
    private val tracing: ResolvedTracing = config.options.tracing

    /** The headers that carry the trace context, `traceparent` unless configured. */
    val propagationHeaders: List<String> = propagationHeaderNames(tracing)

    /**
     * Whether a request to [url] is captured: never the SDK's own upload, nor an `excludedUrls`
     * match. Capture may report a URL as given or normalized (OkHttp's HttpUrl lowercases the
     * host, drops a default port, resolves dot segments), so the endpoint is matched both ways:
     * a captured upload fills the next batch, and an idle app would upload forever.
     */
    fun captures(url: String): Boolean {
        if (!enabled) return false
        val normalizedEndpoint = normalizedUrl(endpoint)
        val ownUpload =
            normalizedEndpoint.isNotEmpty() && normalizedUrl(url).contains(normalizedEndpoint)
        return !ownUpload && !shouldIgnoreUrl(url, endpoint, excludedUrls)
    }

    /** The trace headers a request to [url] carries, fresh ids each call. */
    fun traceHeadersFor(url: String, ids: IdGenerator): Map<String, String> =
        if (matchesPropagationUrl(listOf(url), tracing.propagationUrls)) {
            buildTraceHeaders(tracing, generateTraceIds(ids))
        } else {
            emptyMap()
        }
}

private val DEFAULT_PORTS = mapOf("http" to 80, "https" to 443)

/** [url] with its scheme and host lowercased, a default port dropped and dot segments resolved. */
private fun normalizedUrl(url: String): String = try {
    val uri = URI(url).normalize()
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    if (scheme == null || host == null) {
        ""
    } else {
        val port = if (uri.port == -1 || DEFAULT_PORTS[scheme] == uri.port) "" else ":${uri.port}"
        val query = uri.rawQuery?.let { "?$it" } ?: ""
        "$scheme://$host$port${uri.rawPath ?: ""}$query"
    }
} catch (error: Exception) {
    ""
}
