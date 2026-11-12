package com.groundcover.rum.core.events

import com.groundcover.rum.core.common.truncate
import com.groundcover.rum.core.privacy.EffectivePrivacy
import com.groundcover.rum.core.privacy.redactLogFields

// The events the app sends itself: custom events and logs.

/** `Groundcover.sendCustomEvent`, sent as given: custom events are not auto-redacted. */
internal fun shapeCustomEvent(capture: CustomEventCapture) = EnrichInput(
    type = "custom",
    timestamp = capture.timestampNs,
    attributes = mapOf(
        "custom_event_name" to capture.name,
        "custom_event_attributes" to capture.attributes
    )
)

/**
 * A log line. The keys the event stamps itself (`message`, `level`, and the enricher's
 * [reservedKeys]) are stripped from the user's attributes, so they can't be shadowed; then the log
 * privacy rules apply to the message and the attributes alike.
 */
internal fun shapeLogEvent(
    capture: LogCapture,
    privacy: EffectivePrivacy,
    reservedKeys: List<String> = emptyList()
): EnrichInput {
    val userAttributes = LinkedHashMap(capture.attributes ?: emptyMap())
    userAttributes.remove("message")
    userAttributes.remove("level")
    reservedKeys.forEach { userAttributes.remove(it) }
    val safe = redactLogFields(privacy, capture.message, userAttributes)
    return EnrichInput(
        type = "log",
        timestamp = capture.timestampNs,
        attributes = LinkedHashMap(safe.attributes ?: emptyMap()).apply {
            put("message", truncate(safe.message))
            put("level", capture.level.wireName)
        }
    )
}
