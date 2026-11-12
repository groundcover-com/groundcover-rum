package com.groundcover.rum.flutter

import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.groundcover.rum.engine.GcRumEngine
import com.groundcover.rum.engine.GcRumEngineConfig
import com.groundcover.rum.engine.GcRumEngineListener
import com.groundcover.rum.engine.GcRumEngineStatus
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Registers the host API and the signal stream (RumApi.g.kt, generated from
 * pigeons/rum_api.dart) on every engine that attaches. Attached once per Flutter engine, so
 * everything here tolerates several engines in one process.
 */
class GroundcoverFlutterPlugin : FlutterPlugin, ActivityAware {
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        RumEngineHost.attach(binding.applicationContext)
        RumHostApi.setUp(binding.binaryMessenger, RumHostApiImpl(binding.applicationContext))
        SignalsStreamHandler.register(binding.binaryMessenger, RumSignals())
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        RumHostApi.setUp(binding.binaryMessenger, null)
        RumEngineHost.detach()
    }

    // The activity on screen, which the engine's foreground tracking needs: by the time it
    // starts, the launch activity's lifecycle callbacks have already fired.
    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        RumEngineHost.activity = binding.activity
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        RumEngineHost.activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        RumEngineHost.activity = null
    }

    override fun onDetachedFromActivity() {
        RumEngineHost.activity = null
    }
}

/** The engine's signals (hang, app_start, ping) for Dart, through the host that owns them. */
internal class RumSignals : SignalsStreamHandler() {
    override fun onListen(p0: Any?, sink: PigeonEventSink<NativeSignal>) = RumEngineHost.listen(sink)

    override fun onCancel(p0: Any?) = RumEngineHost.cancel()
}

/**
 * The process's one native engine, shared by every Flutter engine that
 * attaches the plugin, and the signals it emits on their way to Dart. One per process because the
 * engine's crash handler and watchdog are.
 *
 * Built by the first start and released when the last Flutter engine detaches, both on
 * [lifecycle], never on the main thread: building reads the snapshot store from disk, and
 * releasing fsyncs it and waits for the engine's queued work. A plugin attaches inside
 * `FlutterActivity.onCreate`, before the first frame, and detaches when Back finishes the
 * activity. One thread for both also orders them: a new engine's start waits for the old one's
 * release, whose crash-handler uninstall must come before the new install.
 *
 * Signals cross to Dart on the main thread only, as Flutter requires of an event sink; the sink
 * and the queue below are touched there alone.
 */
internal object RumEngineHost : GcRumEngineListener {
    private val main = Handler(Looper.getMainLooper())
    private var engine: GcRumEngine? = null
    private var attached = 0
    private var context: Context? = null

    private val lifecycle: ExecutorService =
        Executors.newSingleThreadExecutor { task ->
            Thread(task, "groundcover-rum-lifecycle").apply { isDaemon = true }
        }

    @Volatile
    var activity: Activity? = null

    private var sink: PigeonEventSink<NativeSignal>? = null
    private val pending = ArrayDeque<NativeSignal>()

    /**
     * Signals emitted before Dart listens, kept up to this many. `app_start` and `ping` fire
     * inside `start`, and Dart's listen arrives asynchronously on another channel, so call order
     * alone can't promise a listener exists.
     */
    private const val PENDING_LIMIT = 64

    @Synchronized
    fun attach(context: Context) {
        attached++
        this.context = context.applicationContext
    }

    /** On the main thread: the release itself runs on [lifecycle]. */
    @Synchronized
    fun detach() {
        attached--
        if (attached > 0) return
        attached = 0
        val released = engine ?: return
        engine = null
        lifecycle.execute { runCatching { released.release() } }
    }

    /** The engine if a start built it; null before, and once released. */
    @Synchronized
    fun engine(): GcRumEngine? = engine

    /**
     * Starts the engine, building it first, on [lifecycle]: after any release still running.
     * Blocks the caller, which is Pigeon's background task queue.
     */
    fun start(config: GcRumEngineConfig): GcRumEngineStatus =
        lifecycle.submit<GcRumEngineStatus> {
            val engine = synchronized(this) {
                val appContext = context
                if (attached == 0 || appContext == null) return@submit GcRumEngineStatus()
                engine ?: GcRumEngine(appContext) { activity }.also {
                    it.listener = this
                    engine = it
                }
            }
            engine.start(config)
        }.get()

    /** Off the main thread: stop() fsyncs the snapshot store. */
    fun stop() {
        val current = engine() ?: return
        lifecycle.execute { runCatching { current.stop() } }
    }

    override fun onSignal(kind: String, payload: Map<String, Any?>) {
        // A payload JSON can't carry (a non-finite number) is dropped, as Dart would drop it.
        val json = runCatching { JSONObject(payload).toString() }.getOrNull() ?: return
        val signal = NativeSignal(kind, json)
        main.post { deliver(signal) }
    }

    private fun deliver(signal: NativeSignal) {
        val current = sink
        if (current != null) {
            current.success(signal)
            return
        }
        pending.addLast(signal)
        if (pending.size > PENDING_LIMIT) pending.removeFirst()
    }

    /** Called on the main thread, as a stream handler is. */
    fun listen(sink: PigeonEventSink<NativeSignal>) {
        this.sink = sink
        while (pending.isNotEmpty()) sink.success(pending.removeFirst())
    }

    fun cancel() {
        sink = null
    }
}

/**
 * Storage, device info, and the native engine. The calls Pigeon marks for a task queue run off
 * the main thread.
 */
internal class RumHostApiImpl(private val context: Context) : RumHostApi {
    /** A file of its own, so the SDK's keys never mix with the app's preferences. */
    private val prefs by lazy { context.getSharedPreferences("groundcover_rum", Context.MODE_PRIVATE) }

    override fun loadStorage(): Map<String, String> =
        prefs.all.mapNotNull { (key, value) -> (value as? String)?.let { key to it } }.toMap()

    override fun writeStorage(changes: Map<String, String?>) {
        val editor = prefs.edit()
        for ((key, value) in changes) {
            if (value == null) editor.remove(key) else editor.putString(key, value)
        }
        // commit, not apply: it says whether the write reached disk, and this already runs on a
        // background task queue. A failed one is an error the Dart side reports, as RN reports a
        // rejected AsyncStorage write; nothing retries it.
        if (!editor.commit()) {
            throw FlutterError("storage-write-failed", "SharedPreferences could not commit the SDK's state")
        }
    }

    // The native engine.

    /**
     * Never throws: a native failure degrades to nothing armed, not to an error in the app's
     * startup. Idempotent: a second start, as after a hot restart, returns the first's status.
     */
    override fun startEngine(configJson: String): String =
        runCatching {
            RumEngineHost.start(GcRumEngineConfig.decode(configJson)).encodedJson()
        }.getOrElse { GcRumEngineStatus().encodedJson() }

    override fun updateSessionSnapshot(json: String?) {
        RumEngineHost.engine()?.updateSessionSnapshot(json)
    }

    override fun pendingCrashReports(): String =
        runCatching { RumEngineHost.engine()?.pendingCrashReportsJson() }.getOrNull() ?: "[]"

    override fun clearPendingCrashReports(ids: List<String>) {
        RumEngineHost.engine()?.clearPendingCrashReports(ids)
    }

    override fun stopEngine() {
        RumEngineHost.stop()
    }

    /**
     * Crashes the app, for testing crash capture. Thrown on the main thread so it reaches the
     * same uncaught handler a real crash would.
     */
    override fun triggerTestCrash(kind: String) {
        if (!isDebuggableApp) return
        Handler(Looper.getMainLooper()).post {
            throw IllegalStateException("groundcover test crash ($kind)")
        }
    }

    /** Blocks the main thread (where Dart runs too) so the ANR watchdog fires. */
    override fun blockMainThread(ms: Long) {
        if (!isDebuggableApp) return
        // Bounded here too, whatever the caller sent: the Dart API caps it at 30 s.
        val bounded = ms.coerceIn(0L, 30_000L)
        Handler(Looper.getMainLooper()).post {
            runCatching { Thread.sleep(bounded) }
        }
    }

    /**
     * Whether the HOST APP is debuggable, from its manifest flag, as RN's module asks: a
     * library's own build type says nothing about the app it ends up in. Gated rather than
     * merely undocumented: a reachable "crash the app" call in a release build is a liability
     * no amount of naming prevents.
     */
    private val isDebuggableApp: Boolean by lazy {
        runCatching { (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 }
            .getOrDefault(false)
    }

    override fun deviceInfo(): NativeDeviceInfo {
        var version: String? = null
        var build: String? = null
        try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            version = info.versionName
            build =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    info.longVersionCode.toString()
                } else {
                    @Suppress("DEPRECATION") info.versionCode.toString()
                }
        } catch (_: PackageManager.NameNotFoundException) {
            // Leave the app version unset rather than fail device info.
        }
        return NativeDeviceInfo(
            // The API level, as the RN SDK reports on Android.
            osVersion = Build.VERSION.SDK_INT.toString(),
            model = Build.MODEL ?: "unknown",
            brand = Build.BRAND ?: "unknown",
            codename = Build.DEVICE?.takeIf { it.isNotBlank() },
            appVersion = version,
            appBuild = build,
        )
    }
}
