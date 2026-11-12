package com.groundcover.rum.okhttp

import com.groundcover.rum.internal.GroundcoverInternal
import com.groundcover.rum.internal.InternalGroundcoverApi
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer

/**
 * Captures each request the client makes as a network event, and adds trace headers to the ones
 * `tracing.propagationUrls` matches. A request that already carries one of the propagation headers
 * (`tracing.propagationHeaders`, `traceparent` unless configured), set by the app or by an
 * interceptor before this one, gets none of them: its own trace context goes out unchanged, and
 * its event records it. Add it as an application interceptor, with [GroundcoverEventListener] for
 * the moment the response headers arrived:
 *
 * ```kotlin
 * val client = OkHttpClient.Builder()
 *     .addInterceptor(GroundcoverOkHttpInterceptor())
 *     .eventListenerFactory(GroundcoverEventListener.Factory())
 *     .build()
 * ```
 *
 * A request body is read only when its length is known and under 5 KB, never a streamed or
 * one-shot one. A response body is never read for the SDK: a text one's first 5 KB are kept as the
 * app reads it, and the request is reported once the app has read the body or closed it. The
 * request and response the app sees are unchanged apart from the trace headers. A cancelled call
 * isn't reported, even once its headers have arrived, except an event stream: it is reported as it
 * opens, since it has no end of its own and the app ends it by cancelling it.
 */
@OptIn(InternalGroundcoverApi::class)
class GroundcoverOkHttpInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val url = request.url.toString()
        val traceHeaders = try {
            GroundcoverInternal.networkTraceHeaders(url, request.headers.names())
        } catch (_: Throwable) {
            null
        } ?: return chain.proceed(request)
        val traced = request.newBuilder().apply {
            for ((name, value) in traceHeaders) {
                // OkHttp refuses a value it can't send (not ASCII, a control character): that
                // header is left off, as the browser leaves off one its fetch refuses.
                try {
                    header(name, value)
                } catch (_: IllegalArgumentException) {
                }
            }
        }.build()
        val call = chain.call()
        val startMs = GroundcoverInternal.nowMs()
        val requestBody = requestBody(traced)
        val response = try {
            chain.proceed(traced)
        } catch (error: IOException) {
            val endMs = GroundcoverInternal.nowMs()
            report(call, traced, startMs, endMs, 0, emptyMap(), requestBody, "", error)
            throw error
        }
        val endMs = ResponseTimes.headersEnd(call) ?: GroundcoverInternal.nowMs()
        return try {
            observeBody(call, traced, startMs, endMs, response, requestBody)
        } catch (_: Throwable) {
            response
        }
    }

    /**
     * Hands the app a body that reports [response] once the app has read it or closed it, so a
     * call the app cancels meanwhile isn't reported. The body is never read for the SDK, so a
     * stream is never waited on, and the bytes the app reads are kept only when the headers don't
     * already tell what to report. A body known to be empty, and an event stream, are reported at
     * once: the first has nothing left to cancel, and the app ends the second by cancelling it.
     */
    private fun observeBody(
        call: Call,
        request: Request,
        startMs: Long,
        endMs: Long,
        response: Response,
        requestBody: String
    ): Response {
        val headers = response.headers.lowercased()
        val body = response.body
        val unread = if (body == null) {
            ""
        } else {
            GroundcoverInternal.responseBodyUnread(
                request.method,
                response.code,
                headers,
                body.contentLength()
            )
        }
        fun reportBody(responseBody: String) = report(
            call,
            request,
            startMs,
            endMs,
            response.code,
            headers,
            requestBody,
            responseBody,
            null
        )
        // Only a body known to be empty is known as "".
        val stream = GroundcoverInternal.isEventStream(headers["content-type"] ?: "")
        if (body == null || unread == "" || stream) {
            reportBody(unread ?: "")
            return response
        }
        val observed = ObservedBody(body, keep = unread == null) { bytes, complete ->
            reportBody(unread ?: GroundcoverInternal.responseBodyRead(bytes, complete))
        }
        return response.newBuilder().body(observed).build()
    }

    /**
     * Reports [request], unless [call] was cancelled, before its response arrived or while the app
     * read its body: the app gave up on it.
     */
    private fun report(
        call: Call,
        request: Request,
        startMs: Long,
        endMs: Long,
        status: Int,
        responseHeaders: Map<String, String>,
        requestBody: String,
        responseBody: String,
        error: IOException?
    ) {
        if (call.isCanceled()) return
        try {
            GroundcoverInternal.reportNetwork(
                method = request.method,
                url = request.url.toString(),
                startMs = startMs,
                endMs = endMs,
                status = status,
                requestHeaders = request.headers.lowercased(),
                requestBody = requestBody,
                responseHeaders = responseHeaders,
                responseBody = responseBody,
                timedOut = error is SocketTimeoutException ||
                    (error is InterruptedIOException && error.message == "timeout"),
                failed = error != null
            )
        } catch (_: Throwable) {
            // The app's request goes on whatever the SDK makes of it.
        }
    }

    private fun requestBody(request: Request): String = try {
        val body = request.body
        if (body == null) {
            ""
        } else {
            val contentType = body.contentType()?.toString() ?: request.header("content-type") ?: ""
            val length = body.contentLength()
            val oneShot = body.isOneShot() || body.isDuplex()
            val bytes = if (!oneShot && GroundcoverInternal.readsBody(contentType, length)) {
                Buffer().also { body.writeTo(it) }.readByteArray()
            } else {
                null
            }
            GroundcoverInternal.requestBody(contentType, length, oneShot, bytes)
        }
    } catch (_: Throwable) {
        ""
    }

    private fun Headers.lowercased(): Map<String, String> =
        names().associate { it.lowercase() to values(it).joinToString(", ") }
}

/**
 * A response body that calls [done] once, when the app reads to the end or closes it first, with
 * the first bytes the app read when [keep], one past the cap at most.
 */
private class ObservedBody(
    private val original: ResponseBody,
    private val keep: Boolean,
    private val done: (ByteArray, Boolean) -> Unit
) : ResponseBody() {
    private val kept = Buffer()
    private val reported = AtomicBoolean(false)
    private val observed: BufferedSource by lazy {
        object : ForwardingSource(original.source()) {
            override fun read(sink: Buffer, byteCount: Long): Long {
                val read = super.read(sink, byteCount)
                if (read == -1L) {
                    finish(complete = true)
                } else if (keep && kept.size <= CAP) {
                    sink.copyTo(kept, sink.size - read, minOf(read, CAP + 1 - kept.size))
                }
                return read
            }

            override fun close() {
                finish(complete = false)
                super.close()
            }
        }.buffer()
    }

    override fun contentType(): MediaType? = original.contentType()

    override fun contentLength(): Long = original.contentLength()

    override fun source(): BufferedSource = observed

    private fun finish(complete: Boolean) {
        if (!reported.compareAndSet(false, true)) return
        try {
            done(kept.readByteArray(), complete)
        } catch (_: Throwable) {
            // The app's response goes on whatever the SDK makes of it.
        }
    }

    private companion object {
        /** The body cap: past it the body is a placeholder, so the rest isn't kept. */
        const val CAP = 5000L
    }
}

/**
 * Records when each call's response headers arrived, for the interceptor's end time. The
 * interceptor captures without it, ending a request when `proceed` returns.
 */
class GroundcoverEventListener : EventListener() {
    override fun responseHeadersEnd(call: Call, response: Response) {
        ResponseTimes.record(call)
    }

    /** Pass to `OkHttpClient.Builder.eventListenerFactory`. */
    class Factory : EventListener.Factory {
        override fun create(call: Call): EventListener = GroundcoverEventListener()
    }
}

@OptIn(InternalGroundcoverApi::class)
private object ResponseTimes {
    private val times = Collections.synchronizedMap(WeakHashMap<Call, Long>())

    fun record(call: Call) {
        try {
            times[call] = GroundcoverInternal.nowMs()
        } catch (_: Throwable) {
            // Without it the request ends when `proceed` returns.
        }
    }

    fun headersEnd(call: Call): Long? = times.remove(call)
}
