package com.groundcover.rum.core.events

import com.groundcover.rum.RumEvent
import com.groundcover.rum.core.common.decodeJsonObject
import com.groundcover.rum.core.common.encodeJson

/**
 * The event as the wire carries it. A network event has `start_timestamp` (and `end_timestamp`
 * when known) instead of `timestamp`.
 */
internal fun RumEvent.wireJson(): Map<String, Any?> = LinkedHashMap<String, Any?>().apply {
    put("type", type)
    put("id", id)
    put("spanId", spanId)
    put("parentSpanId", parentSpanId)
    put("traceId", traceId)
    spanName?.let { put("span_name", it) }
    timestamp?.let { put("timestamp", it) }
    startTimestamp?.let { put("start_timestamp", it) }
    endTimestamp?.let { put("end_timestamp", it) }
    put("attributes", attributes)
}

/**
 * [event] with its attributes copied all the way down, through JSON as the wire carries them, so a
 * hook's changes to the copy never reach it. Next to the wire shape, so a field added to the event
 * is copied too.
 */
internal fun copyRumEvent(event: RumEvent) = RumEvent(
    type = event.type,
    id = event.id,
    spanId = event.spanId,
    parentSpanId = event.parentSpanId,
    traceId = event.traceId,
    timestamp = event.timestamp,
    startTimestamp = event.startTimestamp,
    endTimestamp = event.endTimestamp,
    spanName = event.spanName,
    attributes = decodeJsonObject(encodeJson(event.attributes))?.toMutableMap() ?: mutableMapOf()
)
