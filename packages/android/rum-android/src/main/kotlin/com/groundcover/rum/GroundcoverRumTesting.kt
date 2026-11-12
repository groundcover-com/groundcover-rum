package com.groundcover.rum

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import com.groundcover.rum.capture.Instrumentation
import com.groundcover.rum.core.nativeengine.InteractiveMarks

/**
 * Hooks for an app's tests and for end-to-end harnesses. Not for production code.
 *
 * The session hooks change the persisted session state the SDK reads when it starts, so their
 * effect shows on the next launch, exactly as it would in the field, and no harness depends on
 * the SDK's storage. Each write is on disk when the call returns, with `commit()` rather than
 * `apply()`: a harness kills the app right after, and the next launch has to read the change.
 *
 * The crash and hang hooks work in debuggable apps only. Anywhere else they do nothing.
 */
@SuppressLint("ApplySharedPref")
object GroundcoverRumTesting {
    /**
     * Moves the last-activity time [byMs] milliseconds into the past. Past 30 minutes, the next
     * launch starts a new session.
     */
    @JvmStatic
    fun backdateLastActivity(context: Context, byMs: Long) {
        val ms = System.currentTimeMillis() - byMs
        SessionStorage.prefs(context).edit().putString(SessionStorage.LAST_ACTIVITY, "$ms").commit()
    }

    /**
     * Moves the session start [byMs] milliseconds into the past. Past `sessionMaxDurationMs`, the
     * next launch starts a new session.
     */
    @JvmStatic
    fun backdateSessionStart(context: Context, byMs: Long) {
        val ns = (System.currentTimeMillis() - byMs) * 1_000_000
        SessionStorage.prefs(context).edit().putString(SessionStorage.START_TIME, "$ns").commit()
    }

    /**
     * Forgets the persisted session: its id, start, last activity and sampling verdict. The next
     * launch starts a session no user has touched yet.
     */
    @JvmStatic
    fun forgetSession(context: Context) {
        val editor = SessionStorage.prefs(context).edit()
        SessionStorage.SESSION_KEYS.forEach { editor.remove(it) }
        editor.commit()
    }

    /**
     * Crashes the app with an uncaught exception on the main thread, so it reaches the same
     * handler a genuine crash would. Returns first: the crash is posted to the main thread.
     */
    @JvmStatic
    fun triggerTestCrash(context: Context) {
        if (!isDebuggable(context)) return
        Handler(Looper.getMainLooper()).post {
            throw IllegalStateException("groundcover test crash")
        }
    }

    /**
     * Blocks the main thread for [ms] milliseconds, at most 30 seconds, so the hang watchdog fires.
     * Returns first: the block is posted to the main thread.
     */
    @JvmStatic
    fun blockMainThread(context: Context, ms: Long) {
        if (!isDebuggable(context)) return
        val bounded = ms.coerceIn(0L, 30_000L)
        Handler(Looper.getMainLooper()).post {
            runCatching { Thread.sleep(bounded) }
        }
    }

    /**
     * Stops the SDK and undoes what it installed, so a test that started it can end cleanly. A
     * later [Groundcover.start] starts afresh.
     */
    @JvmStatic
    fun reset() {
        Instrumentation.disarm()
        Groundcover.runtime.reset()
        InteractiveMarks.shared.reset()
    }

    /**
     * Whether the host app is debuggable, from its manifest flag: a library's own build type says
     * nothing about the app it ends up in. Gated rather than merely undocumented: a reachable
     * "crash the app" call in a release build is a liability no amount of naming prevents.
     */
    private fun isDebuggable(context: Context): Boolean =
        runCatching { (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 }
            .getOrDefault(false)
}

/**
 * Where the session state persists: the Flutter SDK's preferences file, keys and string values,
 * so the two SDKs keep one format.
 */
internal object SessionStorage {
    private const val FILE = "groundcover_rum"

    const val ID = "gcId"

    /** Nanoseconds since the epoch, as a decimal string. */
    const val START_TIME = "gcStartTime"

    /** Milliseconds since the epoch, as a decimal string. */
    const val LAST_ACTIVITY = "gcLastActivity"

    const val SAMPLING = "gcSample"

    val SESSION_KEYS = listOf(ID, START_TIME, LAST_ACTIVITY, SAMPLING)

    fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
