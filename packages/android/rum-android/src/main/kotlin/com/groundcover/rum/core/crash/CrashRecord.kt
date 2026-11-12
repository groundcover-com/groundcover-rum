package com.groundcover.rum.core.crash

import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.parseOrderedJson
import com.groundcover.rum.core.events.ErrorFrame

/** The screen a crash happened on. */
internal data class CrashScreen(val name: String, val key: String)

/**
 * A crash record as the engine filed it, coerced at the trust boundary: the JSON comes off the
 * device's disk, possibly written by another SDK version. Coerced, never dropped, apart from the
 * ack key: each fallback is what the drain uses for an absent field.
 */
internal class CrashRecord(
    /** The ack key, stable across redeliveries, so a duplicate can be recognised. */
    val id: String,
    /**
     * When it crashed, or null when the record lost it or holds a time no clock could, the engines'
     * 0 "unknown" sentinel included (the event then takes the send time).
     */
    val crashEpochMs: Double? = null,
    val errorType: String = "",
    val errorMessage: String = "",
    val frames: List<ErrorFrame> = emptyList(),
    val metadata: Map<String, Any?> = emptyMap(),
    /** The session the engine filed it under. */
    val sessionSnapshotJson: String? = null,
    /** The crash-time screen, when the engine could read one. */
    val screen: CrashScreen? = null
)

/**
 * The cause chain a record may carry, above the producers' own cap (Kotlin's 5; iOS writes none):
 * a resource guard against a corrupt record, not a restatement of their contract.
 */
private const val MAX_CAUSE_ENTRIES = 20

/** The latest crash time whose nanoseconds fit a Long; past it, the record is corrupt or in µs. */
private const val MAX_CRASH_EPOCH_MS = Long.MAX_VALUE / 1_000_000

/**
 * The records in the engine's JSON array. Only one without an id is dropped: it could never be
 * acked, so it would be redelivered forever.
 */
internal fun parseCrashRecords(json: String): List<CrashRecord> {
    val decoded = try {
        parseOrderedJson(json)
    } catch (error: Exception) {
        handleError(error)
        return emptyList()
    }
    if (decoded !is List<*>) return emptyList()
    return decoded.mapNotNull { raw ->
        val record = raw as? Map<*, *> ?: return@mapNotNull null
        val id = (record["id"] as? String)?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        CrashRecord(
            id = id,
            crashEpochMs = crashTime(record["crashEpochMs"]),
            errorType = record["errorType"] as? String ?: "",
            errorMessage = record["errorMessage"] as? String ?: "",
            frames = stackFrames(record["stacktrace"]),
            metadata = (record["metadata"] as? Map<*, *>)?.let(::cappingCauses) ?: emptyMap(),
            sessionSnapshotJson = record["sessionSnapshotJson"] as? String,
            screen = crashScreen(record["screen"])
        )
    }
}

private fun cappingCauses(metadata: Map<*, *>): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    for ((key, value) in metadata) out[key.toString()] = value
    val causes = out["causes"]
    if (causes is List<*> && causes.size > MAX_CAUSE_ENTRIES) {
        out["causes"] = causes.take(MAX_CAUSE_ENTRIES)
    }
    return out
}

/**
 * Both members strings, and not the engines' "couldn't read one" sentinel (`{name: "", key: ""}`),
 * so the snapshot's screen still applies then.
 */
internal fun crashScreen(value: Any?): CrashScreen? {
    val screen = value as? Map<*, *> ?: return null
    val name = screen["name"] as? String ?: return null
    val key = screen["key"] as? String ?: return null
    return if (name.isEmpty() && key.isEmpty()) null else CrashScreen(name, key)
}

/**
 * [value] as an epoch time in milliseconds that nanoseconds can hold: a crash's, a hang's, a
 * launch's or a frame segment's. Zero or less is no time at all.
 */
internal fun crashTime(value: Any?): Double? =
    finiteNumber(value)?.takeIf { it > 0 && it <= MAX_CRASH_EPOCH_MS }

/**
 * [value] when it is a finite JSON number. Never a numeric string: the engine writes numbers, so a
 * string means its contract already broke.
 */
internal fun finiteNumber(value: Any?): Double? =
    (value as? Number)?.toDouble()?.takeIf { it.isFinite() }

/**
 * RN's normalizeStackFrames: a frame without a filename symbolicates to nothing and is dropped;
 * the other fields fall back to their documented values (no symbol is `""`; a native frame's line
 * is 0).
 */
internal fun stackFrames(value: Any?): List<ErrorFrame> {
    val frames = value as? List<*> ?: return emptyList()
    return frames.mapNotNull { raw ->
        val frame = raw as? Map<*, *> ?: return@mapNotNull null
        val filename = frame["filename"] as? String ?: return@mapNotNull null
        ErrorFrame(
            filename = filename,
            function = frame["function"] as? String ?: "",
            lineno = lineOrColumn(frame["lineno"]),
            colno = lineOrColumn(frame["colno"])
        )
    }
}

// A line or column outside 0..Int.MAX_VALUE is corrupt, and falls back as a missing one does.
private fun lineOrColumn(value: Any?): Int =
    finiteNumber(value)?.takeIf { it >= 0 && it <= Int.MAX_VALUE }?.toInt() ?: 0
