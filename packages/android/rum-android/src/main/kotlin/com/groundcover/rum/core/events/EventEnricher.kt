package com.groundcover.rum.core.events

import com.groundcover.rum.RumEvent
import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.common.RumClock
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.asList
import com.groundcover.rum.core.common.jsonLeaf
import com.groundcover.rum.core.common.msToNs
import java.util.Collections
import java.util.IdentityHashMap

private const val MAX_FORMAT_DEPTH = 10

/** A caller-supplied occurrence time (ns), or [fallback] when a negative one makes it unusable. */
private fun validTimestamp(supplied: Long?, fallback: Long) =
    if (supplied != null && supplied >= 0) supplied else fallback

/**
 * What [EventEnricher.enrich] takes. One shaper per captured signal builds it; the enricher adds
 * ids, a timestamp and the platform's attributes.
 */
internal class EnrichInput(
    val type: String,
    val attributes: Map<String, Any?> = emptyMap(),
    /** When it happened (ns), or null for now; a network event's start. */
    val timestamp: Long? = null,
    /** A network event's end (ns). */
    val endTimestamp: Long? = null,
    val spanName: String? = null,
    val traceId: String? = null,
    val spanId: String? = null
)

/**
 * Turns a built event into a wire event: ids, a timestamp, dot-flattened attributes, and the
 * platform's own attributes (the current screen) merged last, so they win over a user attribute
 * of the same name.
 */
internal class EventEnricher(
    private val idGenerator: IdGenerator,
    private val clock: RumClock,
    private val platformAttributes: (() -> Map<String, Any?>)? = null,
    /** The keys [platformAttributes] stamps. Free-form user attributes are stripped of them. */
    val reservedAttributeKeys: List<String> = emptyList()
) {
    private fun platform(): Map<String, Any?> {
        val contributor = platformAttributes ?: return emptyMap()
        return try {
            contributor()
        } catch (error: Exception) {
            RumDiagnostics.shared.log(
                "[event-enricher] platform attribute contributor threw; continuing without it",
                error
            )
            emptyMap()
        }
    }

    fun enrich(input: EnrichInput): RumEvent {
        val now = msToNs(clock())
        val event = RumEvent(
            type = input.type,
            id = idGenerator.generateId(),
            spanId = input.spanId?.takeIf { it.isNotEmpty() } ?: idGenerator.generateSpanId(),
            parentSpanId = "",
            traceId = input.traceId?.takeIf { it.isNotEmpty() } ?: idGenerator.generateTraceId(),
            spanName = input.spanName?.takeIf { it.isNotEmpty() },
            attributes = LinkedHashMap(flattenAttributes(input.attributes)).apply {
                putAll(platform())
            }
        )
        if (input.type == "network") {
            event.startTimestamp = validTimestamp(input.timestamp, now)
            event.endTimestamp = input.endTimestamp
        } else {
            event.timestamp = validTimestamp(input.timestamp, now)
        }
        return event
    }
}

/**
 * Dot-flattens nested maps (`{a: {b: 1}}` to `{"a.b": 1}`). A list keeps its place, and each map
 * inside it is flattened under `key[index]`, which is the shape the wire's stack traces take; any
 * other collection or array is a list. Values JSON cannot carry are made safe here, once, by
 * [jsonLeaf]: a non-finite number becomes null, and any other object its string form.
 */
internal fun flattenAttributes(attributes: Map<*, *>): Map<String, Any?> =
    flatten(attributes, "", Collections.newSetFromMap(IdentityHashMap()), 0)

private fun flatten(
    obj: Map<*, *>,
    prefix: String,
    seen: MutableSet<Any>,
    depth: Int
): Map<String, Any?> {
    if (depth >= MAX_FORMAT_DEPTH) return mapOf(prefix.ifEmpty { "depth_limit" } to "[Depth Limit]")
    if (!seen.add(obj)) return mapOf(prefix.ifEmpty { "circular_reference" } to "[Circular]")
    return try {
        val out = LinkedHashMap<String, Any?>()
        for ((key, value) in obj) {
            val newKey = if (prefix.isEmpty()) "$key" else "$prefix.$key"
            val items = asList(value)
            when {
                value is Map<*, *> -> out.putAll(flatten(value, newKey, seen, depth + 1))
                items != null -> out[newKey] = flattenList(value!!, items, newKey, seen, depth)
                else -> out[newKey] = jsonLeaf(value)
            }
        }
        out
    } catch (error: Exception) {
        RumDiagnostics.shared.log(
            "[event-enricher.flattenAttributes] Error formatting event object",
            error
        )
        mapOf(prefix.ifEmpty { "format_error" } to "[Error formatting object]")
    } finally {
        seen.remove(obj)
    }
}

// A list's items, each map among them flattened under `key[index]`. The list itself joins [seen]:
// a nested list is walked as an index-keyed map, a new object every time, which would never be seen
// twice.
private fun flattenList(
    list: Any,
    items: List<Any?>,
    key: String,
    seen: MutableSet<Any>,
    depth: Int
): Any? {
    if (!seen.add(list)) return "[Circular]"
    try {
        return items.mapIndexed { index, item ->
            val nested = asList(item)
            when {
                item is Map<*, *> -> flatten(item, "$key[$index]", seen, depth + 1)

                nested != null ->
                    if (seen.contains(item!!)) {
                        "[Circular]"
                    } else {
                        val byIndex = nested.withIndex().associate { (i, it) -> i to it }
                        flatten(byIndex, "$key[$index]", seen, depth + 1)
                    }

                else -> jsonLeaf(item)
            }
        }
    } finally {
        seen.remove(list)
    }
}
