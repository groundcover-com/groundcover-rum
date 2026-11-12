package com.groundcover.rum.core.events

import com.groundcover.rum.core.privacy.EffectivePrivacy

// Interaction shaping, as the React Native SDK does it: the label, hint and value text are masked
// under mask-all or maskInteractionLabels, or when the element is private; the role, state flags
// and component path are structural, and always kept.

private const val MASKED = "***"

/** A tap, a gesture or a finished edit, as an `interaction` event. */
internal fun shapeInteractionEvent(
    capture: InteractionCapture,
    privacy: EffectivePrivacy
): EnrichInput {
    val target = capture.target
    val mask = privacy.maskInteractionLabels || target.masked
    val targetAttributes = linkedMapOf<String, Any?>(
        "component" to target.component,
        "label" to if (mask) MASKED else target.label,
        "role" to target.role,
        "hint" to if (mask && target.hint.isNotEmpty()) MASKED else target.hint
    )
    if (!target.state.isNullOrEmpty()) targetAttributes["state"] = target.state
    target.valueText?.let { targetAttributes["value"] = mapOf("text" to if (mask) MASKED else it) }
    val attributes = linkedMapOf<String, Any?>(
        "interaction_type" to capture.kind.wireName,
        "interaction_target" to targetAttributes,
        "interaction_component_path" to target.componentPath
    )
    if (capture.x != null && capture.y != null) {
        attributes["interaction_coordinates"] = mapOf("x" to capture.x, "y" to capture.y)
    }
    capture.gesture?.let { gesture ->
        val measure = linkedMapOf<String, Any?>()
        gesture.direction?.let { measure["direction"] = it.wireName }
        measure["distance_dp"] = gesture.distanceDp
        measure["velocity_dp_s"] = gesture.velocityDpS
        measure["duration_ms"] = gesture.durationMs
        measure["pointer_count"] = gesture.pointerCount
        if (gesture.partial) measure["partial"] = true
        measure["capture_source"] = "native"
        attributes["interaction_gesture"] = measure
    }
    return EnrichInput(
        type = "interaction",
        attributes = attributes,
        timestamp = capture.timestampNs
    )
}
