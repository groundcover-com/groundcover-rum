package com.groundcover.rum.capture

import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Window
import com.groundcover.rum.core.events.InteractionCapture
import com.groundcover.rum.core.events.InteractionKind
import com.groundcover.rum.core.events.InteractionTarget
import java.lang.ref.WeakReference

/**
 * Reads the touches of every wrapped window: the first finger down is presence, and a finished
 * sequence that classifies as an interaction is handed on, named by what the first finger went down
 * on, read when it went down: by the end of a drag the content under it has moved. Main thread
 * only.
 */
internal class TouchObserver(
    private val onPresence: () -> Unit,
    private val onInteraction: (InteractionCapture) -> Unit,
    private val onFocusLost: () -> Unit,
    /** Where a tap landed (screen pixels), before the app handles it, for the text fields. */
    private val onTap: (Float, Float) -> Unit = { _, _ -> },
    /**
     * Where focus is worth a look, for the text fields: once the app has handled a finished
     * sequence (a tap may have focused a field), whenever focus moves between the window's views
     * (an IME's Next), and when the window gains focus (a field focused before it was shown).
     */
    private val checkFocus: (Window) -> Unit = {},
    private val onKeyEvent: (Window, KeyEvent) -> Unit = { _, _ -> }
) : WindowObserver {
    private val tracker = TouchTracker()
    private var touchedWindow: WeakReference<Window>? = null

    /** What the first finger went down on. */
    private var downTarget: InteractionTarget? = null

    override fun onTouch(window: Window, event: MotionEvent) {
        val density = window.context.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
        for (sample in samples(event, density)) {
            when (val edge = tracker.process(sample)) {
                is TouchTracker.Edge.Began -> {
                    touchedWindow = WeakReference(window)
                    onPresence()
                    // Named now: by the time a drag ends, the content under its start has moved.
                    downTarget = window.peekDecorView()?.let {
                        TargetResolver.resolve(
                            it,
                            (sample.x * density).toFloat(),
                            (sample.y * density).toFloat()
                        )
                    }
                }

                is TouchTracker.Edge.Ended -> finish(edge.sequence, density)

                null -> {}
            }
        }
    }

    override fun afterTouch(window: Window, event: MotionEvent) {
        val action = event.actionMasked
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            checkFocus(window)
        }
    }

    override fun onKey(window: Window, event: KeyEvent) {
        onKeyEvent(window, event)
    }

    override fun onFocusChanged(window: Window, hasFocus: Boolean) {
        if (hasFocus) checkFocus(window) else onFocusLost()
    }

    override fun onViewFocusChanged(window: Window) {
        checkFocus(window)
    }

    fun reset() {
        tracker.reset()
        touchedWindow = null
        downTarget = null
    }

    private fun finish(sequence: TouchSequence, density: Float) {
        val window = touchedWindow?.get() ?: return
        touchedWindow = null
        val named = downTarget
        downTarget = null
        val result = TouchClassifier.classify(sequence)
        val tap = result?.kind == InteractionKind.TAP
        if (tap) onTap((sequence.endX * density).toFloat(), (sequence.endY * density).toFloat())
        if (result == null) return
        val root = window.peekDecorView() ?: return
        val x = if (tap) sequence.endX else sequence.startX
        val y = if (tap) sequence.endY else sequence.startY
        val target = named
            ?: TargetResolver.resolve(root, (x * density).toFloat(), (y * density).toFloat())
        onInteraction(
            InteractionCapture(result.kind, target, x = x, y = y, gesture = result.gesture)
        )
    }

    /**
     * The event's pointers that changed, in dp on screen, a move's batched history first so a
     * release velocity sees every position.
     */
    private fun samples(event: MotionEvent, density: Float): List<TouchSample> {
        // The window's offset on screen, the same for every pointer and every sample.
        val offsetX = event.rawX - event.x
        val offsetY = event.rawY - event.y
        fun at(index: Int, phase: TouchPhase) = TouchSample(
            id = event.getPointerId(index),
            phase = phase,
            x = ((event.getX(index) + offsetX) / density).toDouble(),
            y = ((event.getY(index) + offsetY) / density).toDouble(),
            timeMs = event.eventTime.toDouble()
        )
        return when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> listOf(at(0, TouchPhase.BEGAN))

            MotionEvent.ACTION_POINTER_DOWN -> listOf(at(event.actionIndex, TouchPhase.BEGAN))

            MotionEvent.ACTION_MOVE -> {
                val history = (0 until event.historySize).flatMap { h ->
                    (0 until event.pointerCount).map { index ->
                        TouchSample(
                            id = event.getPointerId(index),
                            phase = TouchPhase.MOVED,
                            x = ((event.getHistoricalX(index, h) + offsetX) / density).toDouble(),
                            y = ((event.getHistoricalY(index, h) + offsetY) / density).toDouble(),
                            timeMs = event.getHistoricalEventTime(h).toDouble()
                        )
                    }
                }
                history + (0 until event.pointerCount).map { at(it, TouchPhase.MOVED) }
            }

            MotionEvent.ACTION_POINTER_UP -> listOf(at(event.actionIndex, TouchPhase.ENDED))

            MotionEvent.ACTION_UP -> listOf(at(event.actionIndex, TouchPhase.ENDED))

            MotionEvent.ACTION_CANCEL ->
                (0 until event.pointerCount).map { at(it, TouchPhase.CANCELLED) }

            else -> emptyList()
        }
    }
}
