package com.groundcover.rum.capture

import com.groundcover.rum.Groundcover
import com.groundcover.rum.core.common.RandomIdGenerator
import com.groundcover.rum.core.events.NetworkCapture
import com.groundcover.rum.core.events.NetworkErrorType
import com.groundcover.rum.core.events.network.BodyPlaceholder
import com.groundcover.rum.core.events.network.MAX_NETWORK_BODY_BYTES
import com.groundcover.rum.core.events.network.capBody
import com.groundcover.rum.core.events.network.classifyBody
import com.groundcover.rum.core.events.network.isEventStream
import com.groundcover.rum.core.events.network.isKnownEmptyResponse

/**
 * What an HTTP client integration asks and tells the SDK: the trace headers a request carries, the
 * body rules, and the finished request. A request's body is read only when its length is known,
 * under the cap and textual; a response's, as the app reads it. Anything else is a placeholder, and
 * a stream is never waited on.
 */
internal object NetworkReports {
    private val ids = RandomIdGenerator()

    /**
     * The trace headers for a request to [url] that already carries headers named [present], or
     * null when the SDK isn't recording or doesn't capture it. None for a request that carries a
     * propagation header of its own (the app's tracer's, or another SDK's): its trace context goes
     * out as it is, and gains no other trace header beside it.
     */
    fun traceHeaders(url: String, present: Collection<String>): Map<String, String>? {
        val policy = Groundcover.runtime.networkPolicy ?: return null
        if (!policy.captures(url)) return null
        val ownTrace = policy.propagationHeaders.any { name ->
            present.any { it.equals(name, ignoreCase = true) }
        }
        return if (ownTrace) emptyMap() else policy.traceHeadersFor(url, ids)
    }

    fun nowMs(): Long = Groundcover.runtime.now()

    /** Whether a body of [contentType] and [length] (-1 unknown) is read at all. */
    fun readsBody(contentType: String, length: Long): Boolean =
        length in 0 until MAX_NETWORK_BODY_BYTES && classifyBody(contentType) == null

    /**
     * A request body as sent: its text when [readsBody] allowed reading [bytes], else the
     * placeholder for what it is.
     */
    fun requestBody(
        contentType: String,
        length: Long,
        oneShot: Boolean,
        bytes: ByteArray?
    ): String {
        if (length == 0L) return ""
        if (oneShot || length < 0) return BodyPlaceholder.REQUEST_UNAVAILABLE
        classifyBody(contentType)?.let { return it }
        if (length >= MAX_NETWORK_BODY_BYTES) return BodyPlaceholder.REQUEST_TOO_LARGE
        return text(bytes, BodyPlaceholder.REQUEST_TOO_LARGE, BodyPlaceholder.REQUEST_UNAVAILABLE)
    }

    /**
     * A response body known without reading it: empty, or the placeholder for what it is. Null
     * when it has to be read, which happens as the app reads it ([responseBodyRead]).
     */
    fun responseBodyUnread(
        method: String,
        status: Int,
        headers: Map<String, String>,
        length: Long
    ): String? {
        if (isKnownEmptyResponse(method, status, headers) || length == 0L) return ""
        val contentType = headers["content-type"] ?: ""
        if (isEventStream(contentType)) return BodyPlaceholder.RESPONSE_UNREADABLE
        classifyBody(contentType)?.let { return it }
        if (length >= MAX_NETWORK_BODY_BYTES) return BodyPlaceholder.RESPONSE_TOO_LARGE
        return null
    }

    /**
     * A response body from the bytes the app read: up to one past the cap, and [complete] when it
     * read to the end. A body the app stopped reading short of the cap is unavailable.
     */
    fun responseBodyRead(bytes: ByteArray, complete: Boolean): String {
        if (bytes.size >= MAX_NETWORK_BODY_BYTES) return BodyPlaceholder.RESPONSE_TOO_LARGE
        if (!complete) return BodyPlaceholder.RESPONSE_UNAVAILABLE
        return text(bytes, BodyPlaceholder.RESPONSE_TOO_LARGE, BodyPlaceholder.RESPONSE_UNAVAILABLE)
    }

    private fun text(bytes: ByteArray?, tooLarge: String, unavailable: String): String {
        if (bytes == null) return unavailable
        return capBody(String(bytes, Charsets.UTF_8), MAX_NETWORK_BODY_BYTES, tooLarge)
    }

    /** Reports a finished request; [timedOut] or [failed] for one that never got a response. */
    fun report(
        method: String,
        url: String,
        startMs: Long,
        endMs: Long,
        status: Int,
        requestHeaders: Map<String, String>,
        requestBody: String,
        responseHeaders: Map<String, String>,
        responseBody: String,
        timedOut: Boolean,
        failed: Boolean
    ) {
        val capture = NetworkCapture(
            method = method,
            url = url,
            startMs = startMs,
            endMs = endMs,
            status = if (failed || timedOut) 0 else status,
            requestHeaders = requestHeaders,
            requestBody = requestBody,
            responseHeaders = responseHeaders,
            responseBody = if (failed || timedOut) "" else responseBody,
            errorType = when {
                timedOut -> NetworkErrorType.TIMEOUT
                failed -> NetworkErrorType.NETWORK_FAILURE
                else -> null
            }
        )
        Groundcover.runtime.dispatch("network") { it.submit(capture) }
    }
}
