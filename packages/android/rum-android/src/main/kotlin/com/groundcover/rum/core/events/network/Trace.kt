package com.groundcover.rum.core.events.network

import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.config.ResolvedTracing
import java.math.BigInteger

// Generate ids, pick the headers a traced request carries, decide whether a request is traced, and
// read the ids back off a captured request. Setting a header stays with the caller.

internal class TraceIds(
    val traceId: String,
    val spanId: String,
    /** W3C `00-<32 hex>-<16 hex>-01`. */
    val traceparent: String,
    /** The ids in base 10, for `traceIdHeaderName` and `spanIdHeaderName`. */
    val decimalTraceId: String,
    val decimalSpanId: String
)

internal fun generateTraceIds(ids: IdGenerator): TraceIds {
    val spanId = ids.generateSpanId()
    val traceId = ids.generateTraceId()
    return TraceIds(
        traceId = traceId,
        spanId = spanId,
        traceparent = "00-$traceId-$spanId-01",
        decimalTraceId = hexToDecimal(traceId),
        decimalSpanId = hexToDecimal(spanId)
    )
}

/** [hex] in base 10, exactly at any length, or [hex] itself when it isn't hex. */
internal fun hexToDecimal(hex: String): String = try {
    BigInteger(hex, 16).toString()
} catch (error: NumberFormatException) {
    hex
}

private val TOKEN = Regex("^[a-zA-Z0-9!#$&'*+\\-.^_`|~]+$")

/** RFC 9110 token: a name a host would refuse never reaches a setter. */
internal fun isValidHeaderName(name: String) = TOKEN.matches(name)

/**
 * The headers a traced request carries, by name. Invalid names are dropped; a name configured twice
 * is set once (last wins).
 */
internal fun buildTraceHeaders(tracing: ResolvedTracing, ids: TraceIds): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    fun set(name: String, value: String) {
        if (isValidHeaderName(name)) out[name] = value
    }
    if (tracing.origin.name.isNotEmpty()) set(tracing.origin.name, tracing.origin.value)
    if (tracing.traceIdHeaderName.isNotEmpty()) set(tracing.traceIdHeaderName, ids.decimalTraceId)
    if (tracing.spanIdHeaderName.isNotEmpty()) set(tracing.spanIdHeaderName, ids.decimalSpanId)
    propagationHeaderNames(tracing).forEach { set(it, ids.traceparent) }
    return out
}

/** The headers that carry the W3C trace context: `propagationHeaders`, or `traceparent`. */
internal fun propagationHeaderNames(tracing: ResolvedTracing): List<String> =
    tracing.propagationHeaders.ifEmpty { listOf("traceparent") }

private val REGEX_META = Regex("[.+?^\${}()|\\[\\]\\\\]")

/**
 * Whether a request is traced: any pattern matches any candidate in full. Only `*` is a wildcard;
 * every other metacharacter is escaped, or a `.` would send trace headers to `api-example.com`.
 */
internal fun matchesPropagationUrl(candidates: List<String>, patterns: List<String>): Boolean {
    if (patterns.isEmpty()) return false
    return patterns.any { pattern ->
        try {
            val regex = Regex(
                pattern.replace(REGEX_META) { "\\" + it.value }.replace("*", ".*")
            )
            candidates.any { regex.matches(it) }
        } catch (error: Exception) {
            false
        }
    }
}

/** The trace and span ids a captured request was sent with, or "" for each it lacks. */
internal class SentTraceIds(val traceId: String, val spanId: String)

/**
 * The ids a captured request carries. Configured id headers win; otherwise the first propagation
 * header (or `traceparent`) is parsed as W3C. Names match case-insensitively.
 */
internal fun extractTraceIds(headers: Map<String, String>, tracing: ResolvedTracing): SentTraceIds {
    val lower = headers.entries.associate { (key, value) -> key.lowercase() to value }
    fun read(name: String) = if (name.isEmpty()) "" else lower[name.lowercase()] ?: ""

    var traceId = read(tracing.traceIdHeaderName)
    var spanId = read(tracing.spanIdHeaderName)
    if (traceId.isEmpty() || spanId.isEmpty()) {
        var traceparent = tracing.propagationHeaders.map(::read).firstOrNull { it.isNotEmpty() }
            ?: ""
        if (traceparent.isEmpty()) traceparent = read("traceparent")
        val parts = traceparent.split("-")
        if (parts.size == 4 && parts[0] == "00") {
            if (traceId.isEmpty() && parts[1].length == 32) traceId = parts[1]
            if (spanId.isEmpty() && parts[2].length == 16) spanId = parts[2]
        }
    }
    return SentTraceIds(traceId, spanId)
}
