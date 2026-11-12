package com.groundcover.rum.core.events

import com.groundcover.rum.RedactKind
import com.groundcover.rum.core.common.truncate
import com.groundcover.rum.core.privacy.EffectivePrivacy
import com.groundcover.rum.core.privacy.RedactOptions
import com.groundcover.rum.core.privacy.redactObject
import com.groundcover.rum.core.privacy.redactOptions
import com.groundcover.rum.core.privacy.redactText

// Capture and stack parsing are the platform's; every source hands its error here, so errors group
// identically on every SDK.

/** The `exception` event for [error]. */
internal fun shapeErrorEvent(error: ErrorCapture, privacy: EffectivePrivacy): EnrichInput {
    val opts = privacy.redactOptions(RedactKind.ERROR)
    val shouldMask = privacy.shouldMaskErrors
    val message = error.message.ifEmpty { "Unknown error" }
    val safeMessage = if (shouldMask) redactText(message, opts) else message
    val metadata = error.metadata
    val safeMetadata = if (shouldMask &&
        metadata != null
    ) {
        redactingCauseMessages(redactObject(metadata, opts), opts)
    } else {
        metadata
    }
    // The defaulted type in the fingerprint too, never an empty one.
    val type = error.type.ifEmpty { "Error" }

    return EnrichInput(
        type = "exception",
        timestamp = error.timestampNs,
        attributes = LinkedHashMap<String, Any?>().apply {
            put("error_type", type)
            put("error_message", safeMessage)
            put("error_stacktrace", error.frames.map { it.toJson() })
            put("error_fingerprint", "$type:${truncate(safeMessage, maxLength = 400)}")
            put("error_handled", error.handled)
            // Omitted rather than null when there is none, as JSON.stringify drops an undefined
            // field.
            if (safeMetadata != null) put("error_metadata", safeMetadata)
        }
    )
}

/**
 * Scans the cause chain's messages as text. Metadata redaction is by key, and `causes[].message`
 * is free text copied from the error, under a key no heuristic calls sensitive; the `caused by`
 * message is usually where the real failure is described, so it is scrubbed, not blanked.
 */
internal fun redactingCauseMessages(
    metadata: Map<String, Any?>,
    opts: RedactOptions
): Map<String, Any?> {
    val causes = metadata["causes"] as? List<*> ?: return metadata
    return metadata + (
        "causes" to causes.map { cause ->
            val entry = cause as? Map<*, *>
            val message = entry?.get("message") as? String
            if (entry == null || message == null) {
                cause
            } else {
                entry.mapKeys { it.key.toString() } + ("message" to redactText(message, opts))
            }
        }
        )
}
