package com.groundcover.rum.core.platform

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import com.groundcover.rum.core.common.decodeJsonObject
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.crash.CrashStore
import com.groundcover.rum.core.nativeengine.NativeEngine
import com.groundcover.rum.core.nativeengine.NativeEngineStatus
import com.groundcover.rum.engine.GcRumEngine
import com.groundcover.rum.engine.GcRumEngineConfig
import com.groundcover.rum.engine.GcRumEngineListener
import com.groundcover.rum.engine.crash.GcRumSnapshotStore
import java.lang.ref.WeakReference
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * The engine compiled into the SDK, behind the pipeline's seams. One per process: the crash
 * handler and the launch anchor are process-wide, and a start after a stop picks up where the last
 * one left off.
 */
internal class DeviceEngine internal constructor(
    private val context: Context,
    /**
     * Starts and stops run here, in the order they were asked for. Building the engine reads its
     * store from disk, and so do installing the crash handler and harvesting the last run's exit
     * reasons, none of which the app's launch should wait on. Until the crash handler is in, an
     * [EarlyCrashHandler] covers crashes. A parameter only so a test can hold that work back; the
     * app's one engine is [shared].
     */
    private val host: Executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "gc-rum-engine-host").apply { isDaemon = true }
    }
) : NativeEngine,
    CrashStore {

    /**
     * The Activity on screen, which the engine's trackers attach to when they start: by then the
     * launch Activity's callbacks have fired, and won't again until the app leaves the foreground.
     * Registered here, on the caller's thread, so it sees the launch Activity start.
     */
    private val activities = StartedActivity().also {
        (context as? Application)?.registerActivityLifecycleCallbacks(it)
    }

    /** The engine, once the first start has built it, on [host]. */
    @Volatile
    private var engine: GcRumEngine? = null

    @Volatile
    override var onSignal: ((String, Map<String, Any?>) -> Unit)? = null

    private val listener = GcRumEngineListener { kind, payload -> onSignal?.invoke(kind, payload) }

    override fun start(configJson: String, completion: (NativeEngineStatus) -> Unit) {
        val early = armEarlyCrashCapture(configJson)
        host.execute {
            val status = try {
                val built = engine ?: build()
                built.start(GcRumEngineConfig.decode(configJson)).let {
                    NativeEngineStatus(
                        crashes = it.crashes,
                        hangs = it.hangs,
                        appStart = it.appStart,
                        vitals = it.vitals,
                        crashesUnavailable = it.crashesUnavailable
                    )
                }
            } catch (error: Throwable) {
                // Throwable, as the engine itself catches: an Error escaping on this executor
                // reaches the default handler and ends the app, and the start never replies.
                handleError(error)
                NativeEngineStatus()
            }
            // The engine has decided about crash capture, its handler installed or not.
            early?.handOver()
            completion(status)
        }
    }

    /**
     * Covers crashes until the engine's handler is installed on [host], when crash capture is on:
     * see [EarlyCrashHandler]. Installed here, on the caller's thread: the core thread, inside the
     * pipeline start that `Groundcover.start` waits up to 1 s for. So it is in the chain before
     * start returns, unless that start takes longer, when it lands just after. Only before the first
     * engine is built: a later start finds the engine's own handler already armed or deliberately
     * stopped.
     */
    private fun armEarlyCrashCapture(configJson: String): EarlyCrashHandler? {
        if (engine != null) return null
        return try {
            val config = GcRumEngineConfig.decode(configJson)
            if (!config.features.crashes) return null
            EarlyCrashHandler(
                snapshotJson = config.snapshotJson,
                // Where the engine's store writes, built only if a crash comes: until then nothing
                // here touches disk.
                makeWriter = { GcRumSnapshotStore(context.noBackupFilesDir) }
            ).also { it.install() }
        } catch (error: Throwable) {
            handleError(error)
            null
        }
    }

    override fun stop() {
        host.execute {
            try {
                engine?.stop()
            } catch (error: Throwable) {
                handleError(error)
            }
        }
    }

    override fun flushFrameSegment(completion: (Map<String, Any?>?) -> Unit) {
        val built = engine ?: return completion(null)
        built.flushFrameSegmentJson { json -> completion(decodeJsonObject(json)) }
    }

    private fun build(): GcRumEngine = GcRumEngine(context) { activities.current }.also {
        it.listener = listener
        engine = it
    }

    // The crash store. The pipeline reaches it only once a start has replied, so by then the engine
    // is built.

    override fun updateSessionSnapshot(json: String?) {
        engine?.updateSessionSnapshot(json)
    }

    override fun pendingCrashReportsJson(): String = engine?.pendingCrashReportsJson() ?: "[]"

    override fun clearPendingCrashReports(ids: List<String>) {
        engine?.clearPendingCrashReports(ids)
    }

    companion object {
        @Volatile
        private var shared: DeviceEngine? = null

        fun shared(context: Context): DeviceEngine = shared ?: synchronized(this) {
            shared ?: DeviceEngine(context.applicationContext ?: context).also { shared = it }
        }
    }
}

/** The last Activity to start that hasn't stopped since. Main thread only, as its callbacks are. */
private class StartedActivity : Application.ActivityLifecycleCallbacks {
    @Volatile
    private var started: WeakReference<Activity>? = null

    val current: Activity? get() = started?.get()

    override fun onActivityStarted(activity: Activity) {
        started = WeakReference(activity)
    }

    override fun onActivityStopped(activity: Activity) {
        if (started?.get() === activity) started = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

    override fun onActivityResumed(activity: Activity) {}

    override fun onActivityPaused(activity: Activity) {}

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

    override fun onActivityDestroyed(activity: Activity) {}
}
