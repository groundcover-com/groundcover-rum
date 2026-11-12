package com.groundcover.rum.engine.gestures

import kotlin.math.abs
import kotlin.math.hypot

/**
 * Decides what a finished drag was — a transliteration of `GCRumGestureClassifier.swift`, kept
 * line-for-line comparable because three runtimes feed ONE `interaction_type` and there is no
 * shared runtime to put this in. Kept apart from [GcRumGestureRecognizer] because it is arithmetic
 * on two points and a velocity, which is what lets the JVM suite reach it. Getting it wrong is
 * silent: a mis-signed axis reports every scroll as its opposite and nothing crashes.
 */
internal object GcRumGestureClassifier {
    /** Below this a drag is a wobble, not a gesture worth reporting. */
    const val MIN_DISTANCE_DP = 32.0

    /**
     * A flick released with momentum is a swipe; a slower drag that came to rest is a scroll.
     * Ours, not the platform's: `onFling` fires above ~50 dp/s, which would put Android's line
     * roughly 6x below iOS's, so an ordinary deliberate drag would be a swipe here and a scroll
     * there. onFling hands us the velocity, so we can be stricter even though we cannot be
     * looser — and stricter is what matching iOS needs.
     *
     * Same value as `GCRumGestureClassifier.swipeVelocityDpS` and `MIN_SWIPE_VELOCITY_DP_S`.
     */
    const val SWIPE_VELOCITY_DP_S = 300.0

    data class Result(
        val kind: String,
        val direction: String,
        val distanceDp: Double,
        val velocityDpS: Double,
    )

    /**
     * @param velocityDpS release velocity, already in dp/s. Zero when the platform
     *   reported no fling, which means the release was below its own floor and so
     *   below ours too.
     * @param pointerCount the most simultaneous touches the sequence reached. Two or
     *   more is a pinch, which this classifier does not produce — see below.
     * @return the classified gesture, or null when the movement was too small to
     *   be one, or when it was not a single-finger movement at all.
     */
    fun classify(
        startXDp: Double,
        startYDp: Double,
        endXDp: Double,
        endYDp: Double,
        velocityDpS: Double,
        pointerCount: Int,
    ): Result? {
        // A pinch is JavaScript's to report: this classifier only ever answers "swipe" or "scroll",
        // and JS suppression covers exactly those two kinds — a `pinch` is never suppressed, because
        // JS's numbers are all there are for one. So emitting a two-finger drag as a `scroll` here
        // does not mislabel one event, it produces TWO for the same gesture: a native `scroll` and
        // an unsuppressed JS `pinch`. Declining is what keeps the pair mutually exclusive.
        if (pointerCount >= 2) return null

        val dx = endXDp - startXDp
        val dy = endYDp - startYDp
        val distanceDp = hypot(dx, dy)
        if (distanceDp < MIN_DISTANCE_DP) return null

        return Result(
            kind = if (velocityDpS >= SWIPE_VELOCITY_DP_S) "swipe" else "scroll",
            direction = direction(dx, dy),
            distanceDp = distanceDp,
            velocityDpS = velocityDpS,
        )
    }

    /**
     * Gestures are reported along their dominant axis; a diagonal drag is
     * whichever way it mostly went.
     *
     * Note the sign convention: these are screen coordinates, where y grows
     * DOWNWARD, so a positive dy is "down".
     */
    fun direction(dx: Double, dy: Double): String =
        if (abs(dx) >= abs(dy)) {
            if (dx >= 0) "right" else "left"
        } else {
            if (dy >= 0) "down" else "up"
        }
}
