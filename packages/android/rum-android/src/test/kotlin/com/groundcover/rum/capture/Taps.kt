package com.groundcover.rum.capture

import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.Window

/** [view]'s centre on screen. */
internal fun centre(view: View): Pair<Float, Float> {
    val location = IntArray(2)
    view.getLocationOnScreen(location)
    return (location[0] + view.width / 2f) to (location[1] + view.height / 2f)
}

/** A finger down on [view]'s centre and up 80 ms later, through [window]'s callback chain. */
internal fun tap(window: Window, view: View) {
    val (x, y) = centre(view)
    val down = SystemClock.uptimeMillis()
    window.callback.dispatchTouchEvent(
        MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0)
    )
    window.callback.dispatchTouchEvent(
        MotionEvent.obtain(down, down + 80, MotionEvent.ACTION_UP, x, y, 0)
    )
}
