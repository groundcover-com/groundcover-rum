package com.groundcover.rum.engine.appstart

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.view.Choreographer

/**
 * Stamps launch timings before the host app's own code runs: a ContentProvider in the library
 * manifest has `onCreate` called BEFORE `Application.onCreate`, earlier than any hook the app
 * could give us. A standard trick (AndroidX Startup and many SDKs use it) needing no integration
 * step. It provides no data — being a ContentProvider is purely how it runs early.
 */
internal class GcRumStartupProvider : ContentProvider() {

    /**
     * CONTAINED IN FULL, and this is the one place in the SDK where that matters most.
     *
     * A ContentProvider's `onCreate` runs during process startup, before `Application.onCreate` —
     * that earliness is the entire reason this class exists, and it is also why a throw here is
     * unsurvivable: it aborts provider installation and takes the host app down on EVERY launch,
     * before any of our own error handling exists to say why. `GcRumEngine.start`'s `runCatching`
     * is far too late to help; it has not run yet and never will.
     *
     * Returns true regardless. The value only tells the system whether the provider loaded
     * successfully, and this one serves no data to anybody — reporting a failure would gain
     * nothing and risks a host that inspects provider state doing something with it. A launch
     * whose timings were not stamped simply reports no app-start metric.
     */
    override fun onCreate(): Boolean {
        runCatching { install() }
        return true
    }

    private fun install() {
        GcRumAppStartTracker.recordProviderCreate()

        (context?.applicationContext as? Application)?.registerActivityLifecycleCallbacks(
            object : Application.ActivityLifecycleCallbacks {
                override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
                    // A null saved state on the FIRST activity means a fresh
                    // start rather than the system restoring a killed one.
                    GcRumAppStartTracker.recordActivityCreate(isFreshLaunch = savedInstanceState == null)
                }

                override fun onActivityResumed(activity: Activity) {
                    // The first frame after resume is the first thing the user
                    // actually sees, which is what a start time should measure.
                    awaitFirstFrame()
                }

                override fun onActivityStarted(activity: Activity) {
                    GcRumAppStartTracker.recordActivityStarted()
                }

                override fun onActivityStopped(activity: Activity) {
                    GcRumAppStartTracker.recordActivityStopped(activity.isChangingConfigurations)
                }

                override fun onActivityPaused(activity: Activity) = Unit
                override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
                override fun onActivityDestroyed(activity: Activity) = Unit
            }
        )
    }

    private fun awaitFirstFrame() {
        runCatching {
            Choreographer.getInstance().postFrameCallback {
                GcRumAppStartTracker.recordFirstFrame()
            }
        }
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}

/**
 * Where the timings collected above are held until someone asks for them.
 *
 * Static, because the provider runs long before the engine exists — there is no
 * instance to hand them to yet. The engine drains them once JavaScript is ready.
 */
internal object GcRumAppStartTracker {
    /**
     * How many starts may queue before a handler exists.
     *
     * A cold start plus one warm start per foreground, and only while nobody is draining — which
     * is the whole life of a process whose host never enables `appStart`, since [drain] is the only
     * thing that installs a handler and the engine only calls it for that feature. Unbounded, that
     * is one retained record per trip to the background for the life of the process.
     *
     * OLDEST-wins on overflow: the cold start is the first thing in here and the one worth keeping,
     * so a full buffer drops the new warm start rather than evicting it. Matches iOS's `maxPending`.
     */
    private const val MAX_PENDING = 16

    data class AppStart(val type: String, val startMs: Long, val firstFrameMs: Long)

    private val lock = Any()

    /** Guarded by [lock]: the provider's callbacks arrive on main, the drain on the engine's thread. */
    private val state = GcRumAppStartState()

    private var pending = mutableListOf<AppStart>()
    private var handler: ((AppStart) -> Unit)? = null

    fun recordProviderCreate() {
        synchronized(lock) {
            if (state.processStartMs != 0L) return
            state.processStartMs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                // Elapsed-realtime based, so convert to wall clock for the wire.
                System.currentTimeMillis() -
                    (SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime())
            } else {
                System.currentTimeMillis()
            }
        }
    }

    fun recordActivityStarted() {
        synchronized(lock) { state.activityStarted(System.currentTimeMillis()) }
    }

    fun recordActivityStopped(isChangingConfigurations: Boolean) {
        synchronized(lock) { state.activityStopped(isChangingConfigurations) }
    }

    fun recordActivityCreate(isFreshLaunch: Boolean) {
        synchronized(lock) { state.activityCreated(isFreshLaunch, System.currentTimeMillis()) }
    }

    fun recordFirstFrame() {
        val start = synchronized(lock) { state.firstFrame(System.currentTimeMillis()) }
        start?.let(::dispatch)
    }

    /** Hands over anything measured before JavaScript was listening, then keeps
     *  streaming later warm and hot starts. */
    fun drain(into: (AppStart) -> Unit) {
        val buffered = synchronized(lock) {
            handler = into
            val copy = pending
            pending = mutableListOf()
            copy
        }
        buffered.forEach(into)
    }

    fun reset() {
        synchronized(lock) {
            handler = null
            pending = mutableListOf()
            // The in-flight foreground bookkeeping goes too: a pending type left here would be
            // reported against the NEXT arming's first frame. The cold start's bookkeeping
            // deliberately survives — it is a property of the process, not of an engine instance.
            state.forgetForegroundReturn()
        }
    }

    private fun dispatch(start: AppStart) {
        val target = synchronized(lock) {
            val current = handler
            if (current == null && pending.size < MAX_PENDING) pending.add(start)
            current
        }
        target?.invoke(start)
    }
}
