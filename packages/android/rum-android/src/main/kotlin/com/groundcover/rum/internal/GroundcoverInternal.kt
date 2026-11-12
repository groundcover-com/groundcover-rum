package com.groundcover.rum.internal

import android.app.Activity
import com.groundcover.rum.capture.Instrumentation
import com.groundcover.rum.capture.NetworkReports

/**
 * For groundcover's own integration modules, which can't see `rum-android`'s internals. Not part
 * of the public API: it can change in any release, and the API file leaves it out.
 */
@RequiresOptIn(
    message = "For groundcover's own integrations; it can change in any release.",
    level = RequiresOptIn.Level.ERROR
)
@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
annotation class InternalGroundcoverApi

/** The entry points the integration modules call. */
@InternalGroundcoverApi
object GroundcoverInternal {
    /**
     * A navigation destination in [activity] became current: the report of the
     * `GroundcoverNavigationEffect` [effect] stands for. It wins over the Activity and the
     * Fragments in it.
     */
    @JvmStatic
    fun navigationDestination(activity: Activity?, effect: Any, name: String, key: String) {
        Instrumentation.navigationDestination(activity, effect, name, key)
    }

    /**
     * The `GroundcoverNavigationEffect` [effect] stands for left the composition: the screen it
     * covered is current again, or else [activity]'s other sources resume.
     */
    @JvmStatic
    fun navigationEffectEnded(activity: Activity?, effect: Any) {
        Instrumentation.navigationEffectEnded(activity, effect)
    }

    /**
     * The trace headers for a request to [url] that already carries headers named [present], or
     * null when it isn't captured. None when one of them is a propagation header: the request
     * keeps its own trace context.
     */
    @JvmStatic
    fun networkTraceHeaders(url: String, present: Collection<String>): Map<String, String>? =
        NetworkReports.traceHeaders(url, present)

    /** The SDK's clock, epoch milliseconds. */
    @JvmStatic
    fun nowMs(): Long = NetworkReports.nowMs()

    /** Whether a body of [contentType] and [length] (-1 unknown) is read at all. */
    @JvmStatic
    fun readsBody(contentType: String, length: Long): Boolean =
        NetworkReports.readsBody(contentType, length)

    /** A request body as reported: its text, or the placeholder for what it is. */
    @JvmStatic
    fun requestBody(
        contentType: String,
        length: Long,
        oneShot: Boolean,
        bytes: ByteArray?
    ): String = NetworkReports.requestBody(contentType, length, oneShot, bytes)

    /** Whether a response of [contentType] is an event stream: it has no end of its own. */
    @JvmStatic
    fun isEventStream(contentType: String): Boolean =
        com.groundcover.rum.core.events.network.isEventStream(contentType)

    /** A response body known without reading it, or null when it has to be read. */
    @JvmStatic
    fun responseBodyUnread(
        method: String,
        status: Int,
        headers: Map<String, String>,
        length: Long
    ): String? = NetworkReports.responseBodyUnread(method, status, headers, length)

    /** A response body from the bytes the app read, [complete] when it read to the end. */
    @JvmStatic
    fun responseBodyRead(bytes: ByteArray, complete: Boolean): String =
        NetworkReports.responseBodyRead(bytes, complete)

    /** Reports a finished request; [timedOut] or [failed] for one that got no response. */
    @JvmStatic
    fun reportNetwork(
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
        NetworkReports.report(
            method,
            url,
            startMs,
            endMs,
            status,
            requestHeaders,
            requestBody,
            responseHeaders,
            responseBody,
            timedOut,
            failed
        )
    }
}
