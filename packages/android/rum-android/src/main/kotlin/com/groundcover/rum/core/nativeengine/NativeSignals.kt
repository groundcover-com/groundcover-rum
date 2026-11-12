package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.core.crash.crashTime
import com.groundcover.rum.core.crash.finiteNumber
import com.groundcover.rum.core.crash.stackFrames
import com.groundcover.rum.core.events.Capture
import com.groundcover.rum.core.events.FrameSegmentCapture
import com.groundcover.rum.core.events.FrameSegmentReason
import com.groundcover.rum.core.events.HangCapture
import com.groundcover.rum.core.events.HangKind
import kotlin.math.roundToLong

// The engine's signals as captures. A signal that breaks the contract is dropped rather than
// repaired: a payload that lost a field is no measurement, and a zero-filled one would assert
// something that never happened.

/**
 * The capture a [kind] signal's [payload] carries, or null for one that carries none (`ping` marks
 * the engine live; `app_start` goes to the app-start tracker, see [appStartOfSignal]) or one that
 * breaks the contract.
 */
internal fun captureOfSignal(kind: String, payload: Map<String, Any?>): Capture? = when (kind) {
    "hang" -> {
        val startedAtMs = crashTime(payload["startedAtMs"])
        val durationMs = finiteNumber(payload["durationMs"])
        if (startedAtMs == null || durationMs == null) {
            null
        } else {
            HangCapture(
                kind = if (payload["kind"] == "anr") HangKind.ANR else HangKind.APP_HANG,
                startedAtMs = startedAtMs,
                durationMs = durationMs,
                frames = stackFrames(payload["mainThreadStack"])
            )
        }
    }

    else -> null
}

/** A count the engine reports, within what a frame count can be. */
private fun frameCount(value: Any?): Int? =
    finiteNumber(value)?.takeIf { it >= 0 && it <= Int.MAX_VALUE }?.toInt()

/**
 * The segment a `frame_segment` [payload] closes, drawn on the screen [screenName] and [screenKey]
 * name, unless it breaks the contract. A missing budget is no budget; a missing delay is no
 * measurement, and a reason outside the three is a payload from another engine.
 */
internal fun frameSegmentOf(
    payload: Map<String, Any?>,
    screenName: String,
    screenKey: String
): FrameSegmentCapture? {
    val startMs = crashTime(payload["segmentStartMs"]) ?: return null
    val endMs = crashTime(payload["segmentEndMs"]) ?: return null
    val total = frameCount(payload["total"]) ?: return null
    val slow = frameCount(payload["slow"]) ?: return null
    val frozen = frameCount(payload["frozen"]) ?: return null
    val refreshRate = finiteNumber(payload["refreshRate"]) ?: return null
    val delayMs = finiteNumber(payload["delayMs"])?.takeIf { it >= 0 } ?: return null
    val reason = FrameSegmentReason.entries.firstOrNull { it.wireName == payload["reason"] }
        ?: return null
    return FrameSegmentCapture(
        startMs = startMs.roundToLong(),
        endMs = endMs.roundToLong(),
        total = total,
        slow = slow,
        frozen = frozen,
        refreshRate = refreshRate,
        delayMs = delayMs,
        budgetMs = finiteNumber(payload["budgetMs"]) ?: 0.0,
        reason = reason,
        screenName = screenName,
        screenKey = screenKey
    )
}

/**
 * The launch an `app_start` signal's [payload] reports, unless it breaks the contract. Both
 * anchors are epoch times nanoseconds can hold, as a crash's must be: TTI is measured from the
 * start.
 */
internal fun appStartOfSignal(payload: Map<String, Any?>): AppStartSignal? {
    val type = payload["type"] as? String ?: return null
    val startMs = crashTime(payload["startMs"]) ?: return null
    val firstFrameMs = crashTime(payload["firstFrameMs"]) ?: return null
    return AppStartSignal(type, startMs, firstFrameMs)
}
