package com.groundcover.rum.capture

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.ViewTreeObserver
import android.view.Window
import androidx.annotation.RequiresApi
import com.groundcover.rum.core.common.handleError
import java.lang.ref.WeakReference
import java.lang.reflect.Field

/**
 * The SDK's link in a window's callback chain: it reads each touch, hands it on unchanged, and
 * looks again once the app has handled it. Whatever wrapped the window before stays inside it, and
 * whatever wraps after calls it. It also follows focus between the window's views.
 */
internal class GroundcoverWindowCallback(
    val delegate: Window.Callback,
    private val window: Window,
    private val observer: WindowObserver
) : Window.Callback by delegate {
    private val focusListener = ViewTreeObserver.OnGlobalFocusChangeListener { _, _ ->
        try {
            observer.onViewFocusChanged(window)
        } catch (error: Throwable) {
            handleError(error)
        }
    }

    override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
        if (event != null) {
            try {
                observer.onTouch(window, event)
            } catch (error: Throwable) {
                handleError(error)
            }
        }
        val handled = delegate.dispatchTouchEvent(event)
        if (event != null) {
            try {
                observer.afterTouch(window, event)
            } catch (error: Throwable) {
                handleError(error)
            }
        }
        return handled
    }

    override fun onAttachedToWindow() {
        delegate.onAttachedToWindow()
        try {
            followFocus()
        } catch (error: Throwable) {
            handleError(error)
        }
    }

    /**
     * Listens to focus moving between the window's views, once they exist. An attached window's
     * views share a tree observer of their own, so this runs again at every attach.
     */
    fun followFocus() {
        val tree = window.peekDecorView()?.viewTreeObserver ?: return
        tree.removeOnGlobalFocusChangeListener(focusListener)
        tree.addOnGlobalFocusChangeListener(focusListener)
    }

    fun unfollowFocus() {
        window.peekDecorView()?.viewTreeObserver?.removeOnGlobalFocusChangeListener(focusListener)
    }

    override fun dispatchKeyEvent(event: KeyEvent?): Boolean {
        if (event != null) {
            try {
                observer.onKey(window, event)
            } catch (error: Throwable) {
                handleError(error)
            }
        }
        return delegate.dispatchKeyEvent(event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        delegate.onWindowFocusChanged(hasFocus)
        try {
            observer.onFocusChanged(window, hasFocus)
        } catch (error: Throwable) {
            handleError(error)
        }
    }

    // Window.Callback's default methods, which Kotlin's delegation leaves to the interface's
    // empty defaults: forwarded, as AppCompat's WindowCallbackWrapper forwards them.
    @RequiresApi(Build.VERSION_CODES.N)
    override fun onProvideKeyboardShortcuts(
        data: MutableList<KeyboardShortcutGroup>?,
        menu: Menu?,
        deviceId: Int
    ) {
        delegate.onProvideKeyboardShortcuts(data, menu, deviceId)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    override fun onPointerCaptureChanged(hasCapture: Boolean) {
        delegate.onPointerCaptureChanged(hasCapture)
    }
}

/** What a wrapped window tells the SDK. */
internal interface WindowObserver {
    fun onTouch(window: Window, event: MotionEvent)

    /** [event] once the app has handled it. */
    fun afterTouch(window: Window, event: MotionEvent)

    fun onKey(window: Window, event: KeyEvent)

    /** The window gained or lost focus; also, as it is wrapped, that it already has focus. */
    fun onFocusChanged(window: Window, hasFocus: Boolean)

    /** Focus moved from one of the window's views to another, or to none. */
    fun onViewFocusChanged(window: Window)
}

/**
 * Wraps the callback of every window the app shows: each Activity's, from the lifecycle callbacks,
 * and every other one (a Dialog, a bottom sheet), from the window manager's list of root views.
 * That list is hidden API, read by reflection as Square's Curtains reads it; if a future Android
 * refuses, only Activity windows are covered, and the debug log says so once. Main thread only.
 */
internal class WindowTracker(
    private val application: Application,
    private val observer: WindowObserver,
    private val log: (String) -> Unit
) : Application.ActivityLifecycleCallbacks {
    private val wrapped = mutableListOf<WeakReference<Window>>()
    private val main = Handler(Looper.getMainLooper())

    fun start(initial: Activity?) {
        application.registerActivityLifecycleCallbacks(this)
        initial?.window?.let { wrap(it) }
        scanRootWindows()
    }

    /** Takes the SDK's link out of every chain where it is still the outermost one. */
    fun stop() {
        application.unregisterActivityLifecycleCallbacks(this)
        main.removeCallbacksAndMessages(null)
        for (reference in wrapped) {
            val window = reference.get() ?: continue
            val callback = window.callback
            if (callback is GroundcoverWindowCallback) {
                window.callback = callback.delegate
                callback.unfollowFocus()
            }
        }
        wrapped.clear()
    }

    /** [scanRootWindows] once the current dispatch is done; [stop] cancels it. */
    fun scanSoon() {
        main.post { scanRootWindows() }
    }

    /** Wraps windows that appeared since: a Dialog takes focus from the window below it. */
    fun scanRootWindows() {
        val windows = RootWindows.list() ?: return log(RootWindows.FALLBACK_MESSAGE)
        windows.forEach { wrap(it) }
    }

    /**
     * Wraps [window] once. Another SDK may wrap after us and hide our link inside its own, so the
     * windows already wrapped are remembered rather than found in the chain. A window that
     * already has focus (the SDK started late, or a dialog took focus before a scan found it) is
     * reported as focused now: no focus change will say so.
     */
    fun wrap(window: Window) {
        val callback = window.callback ?: return
        if (wrapped.any { it.get() === window }) return
        val ours = GroundcoverWindowCallback(callback, window, observer)
        window.callback = ours
        ours.followFocus()
        wrapped.removeAll { it.get() == null }
        wrapped.add(WeakReference(window))
        if (window.peekDecorView()?.hasWindowFocus() == true) {
            try {
                observer.onFocusChanged(window, true)
            } catch (error: Throwable) {
                handleError(error)
            }
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        activity.window?.let { wrap(it) }
    }

    override fun onActivityResumed(activity: Activity) {
        activity.window?.let { wrap(it) }
        // A dialog shown while the Activity starts takes focus before its window has it, so no
        // focus loss finds it: look once the resume is done.
        scanSoon()
    }

    override fun onActivityStarted(activity: Activity) {}

    override fun onActivityPaused(activity: Activity) {}

    override fun onActivityStopped(activity: Activity) {}

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

    override fun onActivityDestroyed(activity: Activity) {}
}

/** Every window's root view, through hidden fields, and each root's window. */
internal object RootWindows {
    const val FALLBACK_MESSAGE =
        "[capture] the window list can't be read; only Activity windows are covered"

    private var warned = false

    private val getInstance by lazy {
        try {
            Class.forName("android.view.WindowManagerGlobal").getMethod("getInstance")
        } catch (_: Throwable) {
            null
        }
    }

    private val viewsField by lazy {
        try {
            Class.forName("android.view.WindowManagerGlobal").getDeclaredField("mViews")
                .apply { isAccessible = true }
        } catch (_: Throwable) {
            null
        }
    }

    private val windowField by lazy {
        val names = listOf(
            "com.android.internal.policy.DecorView",
            "com.android.internal.policy.PhoneWindow\$DecorView"
        )
        names.firstNotNullOfOrNull { name ->
            try {
                windowFieldOf(Class.forName(name))
            } catch (_: Throwable) {
                null
            }
        }
    }

    /**
     * A DecorView class's reference to its window: `mWindow`, or on API 23, where DecorView is an
     * inner class of PhoneWindow, the outer instance (`this$0`), as Curtains reads it.
     */
    fun windowFieldOf(decor: Class<*>): Field? = listOf("mWindow", "this\$0").firstNotNullOfOrNull {
        try {
            decor.getDeclaredField(it).apply { isAccessible = true }
        } catch (_: NoSuchFieldException) {
            null
        }
    }

    /** The windows behind every root view, or null when the list can't be read (once). */
    fun list(): List<Window>? {
        val views = try {
            val global = getInstance?.invoke(null)
            (viewsField?.get(global) as? List<*>)?.toList()
        } catch (_: Throwable) {
            null
        }
        val field = windowField
        if (views == null || field == null) {
            if (warned) return emptyList()
            warned = true
            return null
        }
        return views.mapNotNull { view ->
            try {
                if (view is View) field.get(view) as? Window else null
            } catch (_: Throwable) {
                null
            }
        }
    }
}
