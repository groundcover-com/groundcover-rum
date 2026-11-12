package com.groundcover.rum.capture

import com.groundcover.rum.core.events.GestureDirection
import com.groundcover.rum.core.events.GestureMeasure
import com.groundcover.rum.core.events.InteractionKind
import com.groundcover.rum.engine.gestures.GcRumGestureClassifier
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

/** One pointer's phase, as the tracker reads it. */
internal enum class TouchPhase { BEGAN, MOVED, ENDED, CANCELLED }

/** One pointer at one moment: dp on screen, and a monotonic time in milliseconds. */
internal class TouchSample(
    val id: Int,
    val phase: TouchPhase,
    val x: Double,
    val y: Double,
    val timeMs: Double
)

/**
 * A finished touch sequence, from the first finger down to the last one up. Its positions are the
 * first finger's: the one a tap or a drag is about.
 */
internal data class TouchSequence(
    val startX: Double,
    val startY: Double,
    val endX: Double,
    val endY: Double,
    val startMs: Double,
    val endMs: Double,
    /** The most fingers down at once. */
    val pointerCount: Int,
    /** The farthest the first finger got from where it went down. */
    val maxTravel: Double,
    /** The system cancelled the touch, rather than a finger lifting. */
    val cancelled: Boolean,
    /** The first finger's speed at release, dp per second, over its last ~100 ms. */
    val releaseVelocityX: Double = 0.0,
    val releaseVelocityY: Double = 0.0,
    /**
     * How far apart the first two fingers were when both were first down, and when one of them
     * lifted: a pinch's measure.
     */
    val startSpread: Double = 0.0,
    val endSpread: Double = 0.0
) {
    val durationMs: Double get() = max(0.0, endMs - startMs)

    /** Start to end, straight. */
    val distance: Double get() = hypot(endX - startX, endY - startY)
}

/**
 * What a finished sequence was, by RN's and Flutter's thresholds: within 10 dp of touch-down, one
 * finger, a tap up to 500 ms and a long press after; two fingers, a pinch; a single finger that
 * travelled 32 dp or more, a scroll or a swipe by the engine's classifier.
 */
internal object TouchClassifier {
    const val TAP_SLOP_DP = 10.0
    const val TAP_MAX_MS = 500.0

    class Result(val kind: InteractionKind, val gesture: GestureMeasure? = null)

    fun classify(sequence: TouchSequence): Result? {
        val durationMs = sequence.durationMs.roundToInt()
        if (sequence.pointerCount >= 2) {
            val spread = abs(sequence.endSpread - sequence.startSpread)
            val seconds = sequence.durationMs / 1000
            return Result(
                InteractionKind.PINCH,
                GestureMeasure(
                    distanceDp = spread.roundToInt(),
                    velocityDpS = if (seconds > 0) (spread / seconds).roundToInt() else 0,
                    durationMs = durationMs,
                    pointerCount = sequence.pointerCount,
                    partial = sequence.cancelled
                )
            )
        }
        if (sequence.maxTravel <= TAP_SLOP_DP) {
            if (sequence.cancelled) return null
            if (sequence.durationMs <= TAP_MAX_MS) return Result(InteractionKind.TAP)
            return Result(
                InteractionKind.LONG_PRESS,
                GestureMeasure(
                    distanceDp = sequence.distance.roundToInt(),
                    velocityDpS = 0,
                    durationMs = durationMs,
                    pointerCount = 1
                )
            )
        }
        val movement = GcRumGestureClassifier.classify(
            sequence.startX,
            sequence.startY,
            sequence.endX,
            sequence.endY,
            hypot(sequence.releaseVelocityX, sequence.releaseVelocityY),
            pointerCount = 1
        ) ?: return null
        return Result(
            if (movement.kind == "swipe") InteractionKind.SWIPE else InteractionKind.SCROLL,
            GestureMeasure(
                direction = GestureDirection.entries.firstOrNull {
                    it.wireName == movement.direction
                },
                distanceDp = movement.distanceDp.roundToInt(),
                velocityDpS = movement.velocityDpS.roundToInt(),
                durationMs = durationMs,
                pointerCount = 1,
                partial = sequence.cancelled
            )
        )
    }
}

/**
 * Follows the touches a window receives and reports when a sequence starts (the first finger
 * down: presence) and when it ends (the last one up). Main thread only.
 */
internal class TouchTracker {
    sealed class Edge {
        object Began : Edge()

        class Ended(val sequence: TouchSequence) : Edge()
    }

    private class Position(val x: Double, val y: Double, val t: Double)

    private var sequence: TouchSequence? = null
    private var primary = -1
    private var secondary = -1
    private var secondaryX = 0.0
    private var secondaryY = 0.0
    private val down = mutableSetOf<Int>()
    private val recent = ArrayDeque<Position>()

    /** Feeds one sample; returns the edge it crossed, if any. */
    fun process(sample: TouchSample): Edge? {
        when (sample.phase) {
            TouchPhase.BEGAN -> {
                val current = sequence
                if (current != null) {
                    down.add(sample.id)
                    var next = current.copy(pointerCount = max(current.pointerCount, down.size))
                    if (secondary < 0) {
                        secondary = sample.id
                        secondaryX = sample.x
                        secondaryY = sample.y
                        val spread = spread(next)
                        next = next.copy(startSpread = spread, endSpread = spread)
                    }
                    sequence = next
                    return null
                }
                sequence = TouchSequence(
                    startX = sample.x,
                    startY = sample.y,
                    endX = sample.x,
                    endY = sample.y,
                    startMs = sample.timeMs,
                    endMs = sample.timeMs,
                    pointerCount = 1,
                    maxTravel = 0.0,
                    cancelled = false
                )
                primary = sample.id
                secondary = -1
                down.clear()
                down.add(sample.id)
                recent.clear()
                recent.addLast(Position(sample.x, sample.y, sample.timeMs))
                return Edge.Began
            }

            TouchPhase.MOVED -> {
                var current = sequence ?: return null
                when (sample.id) {
                    secondary -> {
                        secondaryX = sample.x
                        secondaryY = sample.y
                    }

                    primary -> current = moved(current, sample)

                    else -> return null
                }
                if (down.size >= 2) current = current.copy(endSpread = spread(current))
                sequence = current
                return null
            }

            TouchPhase.ENDED, TouchPhase.CANCELLED -> {
                var current = sequence ?: return null
                if (sample.id !in down) return null
                if (sample.id == primary) {
                    current = moved(current, sample)
                    val first = recent.firstOrNull()
                    val last = recent.lastOrNull()
                    if (first != null && last != null && last.t > first.t) {
                        val seconds = (last.t - first.t) / 1000
                        current = current.copy(
                            releaseVelocityX = (last.x - first.x) / seconds,
                            releaseVelocityY = (last.y - first.y) / seconds
                        )
                    }
                }
                if (sample.phase == TouchPhase.CANCELLED) current = current.copy(cancelled = true)
                down.remove(sample.id)
                if (down.isNotEmpty()) {
                    sequence = current
                    return null
                }
                sequence = null
                return Edge.Ended(current)
            }
        }
    }

    /** Forgets a sequence in flight: arming or disarming midway must not report half of one. */
    fun reset() {
        sequence = null
        down.clear()
        recent.clear()
    }

    private fun moved(current: TouchSequence, sample: TouchSample): TouchSequence {
        recent.addLast(Position(sample.x, sample.y, sample.timeMs))
        val cutoff = sample.timeMs - VELOCITY_WINDOW_MS
        while (recent.size > 2 && recent.first().t < cutoff) recent.removeFirst()
        return current.copy(
            endX = sample.x,
            endY = sample.y,
            endMs = sample.timeMs,
            maxTravel = max(
                current.maxTravel,
                hypot(sample.x - current.startX, sample.y - current.startY)
            )
        )
    }

    private fun spread(current: TouchSequence): Double =
        hypot(secondaryX - current.endX, secondaryY - current.endY)

    private companion object {
        /** The window a release velocity is measured over, as UIKit's pan measures it. */
        const val VELOCITY_WINDOW_MS = 100.0
    }
}
