package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.core.common.fractionalMsToNs
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.events.AppStartCapture
import com.groundcover.rum.core.events.EnrichInput
import com.groundcover.rum.core.events.FrameSegmentCapture
import com.groundcover.rum.core.events.HangCapture
import kotlin.math.roundToLong

// The events the engine's signals become.

/**
 * The `performance` event for [start], with a fresh metric id. Stamped when it is sent, as RN's: it
 * describes the launch, which has no single moment of its own.
 */
internal fun shapeAppStartEvent(start: AppStartCapture, metricId: String): EnrichInput =
    EnrichInput(
        type = "performance",
        attributes = mapOf(
            "performance_metric_name" to start.metric.wireName,
            "performance_metric_value" to start.valueMs,
            "performance_metric_id" to metricId,
            "performance_metric_navigation_type" to start.navigationType
        )
    )

/**
 * Two decimals: whole milliseconds would round one marginally slow frame's delay (0.28 ms at
 * 60 Hz) down to a smooth screen's zero.
 */
private fun twoDecimals(value: Double): Double = Math.round(value * 100) / 100.0

/**
 * The `performance` event for [segment], one `frames_delay_total`, with a fresh metric id. No frame
 * count and no rate: platforms don't count the same frames.
 */
internal fun shapeFrameSegmentEvent(segment: FrameSegmentCapture, metricId: String): EnrichInput {
    val attributes = linkedMapOf<String, Any?>(
        "performance_metric_name" to "frames_delay_total",
        "performance_metric_value" to twoDecimals(segment.delayMs),
        "performance_metric_id" to metricId,
        // Launch context means nothing for a steady-state metric; the screen stamp attributes it.
        "performance_metric_navigation_type" to "",
        "performance_refresh_rate_hz" to segment.refreshRate,
        "performance_segment_reason" to segment.reason.wireName,
        // Nanoseconds, as navigation events ship under these names, so a segment intersects the
        // navigations around it with no conversion.
        "start_timestamp" to msToNs(segment.startMs),
        "end_timestamp" to msToNs(segment.endMs),
        // Absolute counts, which a consumer sums across segments.
        "performance_frames_slow" to segment.slow,
        "performance_frames_frozen" to segment.frozen
    )
    if (segment.budgetMs.isFinite() && segment.budgetMs > 0) {
        attributes["performance_frame_budget_ms"] = twoDecimals(segment.budgetMs)
    }
    // The segment's end, not now: it describes a past interval, and stamping it when sent would
    // place a screen's jank after the navigation that ended it.
    return EnrichInput("performance", attributes, timestamp = msToNs(segment.endMs))
}

/** The longest duration a hang reports, so rounding a broken one can't overflow. */
private const val MAX_HANG_DURATION_MS = (Long.MAX_VALUE / 2).toDouble()

/**
 * Groups by duration bucket, not exact milliseconds; otherwise every hang is its own issue and the
 * pattern (this screen freezes for about 5 s) never surfaces.
 */
private fun durationBucket(ms: Long): String = when {
    ms < 1_000 -> "<1s"
    ms >= 30_000 -> "30s+"
    else -> "${ms / 1_000}s"
}

/**
 * The `exception` event for [hang]. A frozen app is an error the user experienced, so a hang is
 * one, not a type of its own: it lands in the same view, under the same fingerprint rules.
 */
internal fun shapeHangEvent(hang: HangCapture): EnrichInput {
    val durationMs = hang.durationMs.coerceIn(0.0, MAX_HANG_DURATION_MS).roundToLong()
    val type = hang.kind.wireName
    return EnrichInput(
        type = "exception",
        attributes = mapOf(
            "error_type" to type,
            "error_message" to "Main thread blocked for ${durationMs}ms",
            "error_stacktrace" to hang.frames.map { it.toJson() },
            "error_fingerprint" to "$type:${durationBucket(durationMs)}",
            // The user couldn't use the app: nobody handled it.
            "error_handled" to false,
            "error_metadata" to mapOf(
                "native" to true,
                "hang_duration_ms" to durationMs,
                "hang_started_at" to hang.startedAtMs,
                // Tells it apart from the post-mortem ANR record, a stall the process never came
                // back from.
                "recovered" to true
            )
        ),
        // When the stall began, not now: it is reported only on recovery, after the taps and
        // navigations it blocked.
        timestamp = fractionalMsToNs(hang.startedAtMs)
    )
}
