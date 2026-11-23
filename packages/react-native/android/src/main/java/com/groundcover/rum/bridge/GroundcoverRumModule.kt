package com.groundcover.rum.bridge

import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.groundcover.rum.engine.GcRumEngine
import com.groundcover.rum.engine.GcRumEngineConfig
import com.groundcover.rum.engine.GcRumEngineListener
import com.groundcover.rum.engine.GcRumEngineStatus

/**
 * Thin adapter: JSON in, JSON out, engine in the middle. No capture logic here, so the engine
 * stays usable without React Native.
 *
 * RN interop exposes this classic module on both architectures.
 */
class GroundcoverRumModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    // The activity is read lazily, per call: at construction time there may not
    // be one yet, and by the time JS arms the engine there is.
    private val engine = GcRumEngine(
        reactContext.applicationContext,
        currentActivity = { reactApplicationContext?.currentActivity },
    ).apply {
        listener = GcRumEngineListener { kind, payload -> emitSignal(kind, payload) }
    }

    override fun getName(): String = NAME

    /**
     * Exported CONSTANT (readable synchronously on the first event, before `nativeInit` resolves),
     * mirroring iOS's `deviceModel`. `Build.DEVICE` is the industrial-design codename (e.g. `"o1s"`
     * for a Galaxy S21); JS folds it into `device.codename`. Google's device catalog resolves a
     * marketing name from codename + model — `Build.MODEL` alone (`"SM-G991B"`) is ambiguous across
     * regional variants. iOS deliberately exports no equivalent, since its model identifier already
     * keys that lookup.
     */
    override fun getConstants(): MutableMap<String, Any> =
        mutableMapOf("deviceCodename" to Build.DEVICE)

    @ReactMethod
    fun nativeInit(configJson: String, promise: Promise) {
        // Never rejects: a native failure must degrade to "no features armed",
        // not to an unhandled rejection inside the host app's startup path.
        val status = runCatching {
            engine.start(GcRumEngineConfig.decode(configJson))
        }.getOrElse { GcRumEngineStatus() }
        promise.resolve(status.encodedJson())
    }

    @ReactMethod
    fun updateSessionSnapshot(snapshotJson: String?) {
        runCatching { engine.updateSessionSnapshot(snapshotJson) }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun writePendingCrashReport(id: String, json: String): Boolean =
        runCatching { engine.writePendingCrashReport(id, json) }.getOrDefault(false)

    @ReactMethod
    fun getPendingCrashReports(promise: Promise) {
        promise.resolve(runCatching { engine.pendingCrashReportsJson() }.getOrDefault("[]"))
    }

    @ReactMethod
    fun clearPendingCrashReports(ids: ReadableArray, promise: Promise) {
        runCatching {
            engine.clearPendingCrashReports(
                (0 until ids.size()).mapNotNull { ids.getString(it) }
            )
        }
        promise.resolve(null)
    }

    /**
     * Closes the open frame segment and hands it to JavaScript, which stamps it
     * with the screen being LEFT. Resolves `"null"` when there is nothing to
     * report — the common case for a screen the app never drew a frame on.
     */
    @ReactMethod
    fun flushFrameSegment(promise: Promise) {
        // Never rejects (see nativeInit): a screen change must not fail because
        // vitals could not be read. And it must always SETTLE — the engine
        // guarantees exactly one callback, and this covers a throw before that.
        runCatching { engine.flushFrameSegmentJson { promise.resolve(it) } }
            .onFailure { promise.resolve("null") }
    }

    @ReactMethod
    fun stop() {
        runCatching { engine.stop() }
    }

    /**
     * React Native is destroying this instance — a full JS reload, or a host that
     * resets its ReactHost. The module goes with it, so the engine has to be
     * released here: nothing else will, and a `stop()` from JS never arrives on a
     * teardown the JS side did not initiate.
     *
     * `invalidate()` rather than `onCatalystInstanceDestroy`, which is deprecated
     * for removal.
     */
    override fun invalidate() {
        runCatching { engine.release() }
        super.invalidate()
    }

    /**
     * Whether the HOST APP is debuggable.
     *
     * Deliberately not `BuildConfig.DEBUG`: AGP 8 does not generate BuildConfig
     * for libraries unless asked, and a library's own build type says nothing
     * about the app it ends up in. The app's manifest flag is both available and
     * the thing that actually matters — a release app never exposes the triggers
     * below, whatever this library was compiled as.
     */
    private val isDebuggableApp: Boolean by lazy {
        runCatching {
            (reactApplicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        }.getOrDefault(false)
    }

    /**
     * Deliberately crashes the app, for driving the e2e suite.
     *
     * Gated rather than merely undocumented: shipping a reachable "crash the
     * app" method in a release build is a liability no amount of naming
     * prevents.
     */
    @ReactMethod
    fun triggerTestCrash(kind: String) {
        if (!isDebuggableApp) return
        // Thrown from the main thread so it reaches the same uncaught handler a
        // real crash would, rather than dying on a worker.
        Handler(Looper.getMainLooper()).post {
            throw IllegalStateException("groundcover test crash ($kind)")
        }
    }

    /** Blocks the main thread so the ANR watchdog fires. Debuggable apps only. */
    @ReactMethod
    fun blockMainThread(ms: Double) {
        if (!isDebuggableApp) return
        Handler(Looper.getMainLooper()).post {
            runCatching { Thread.sleep(ms.toLong()) }
        }
    }

    // NativeEventEmitter requires these on Android; without them RN logs a
    // warning on every subscribe. Registration is handled by the emitter itself.
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Double) = Unit

    private fun emitSignal(kind: String, payload: Map<String, Any?>) {
        runCatching {
            val body: WritableMap = Arguments.createMap().apply {
                putString("kind", kind)
                putMap("payload", Arguments.makeNativeMap(payload))
            }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT_CHANNEL, body)
        }
    }

    companion object {
        const val NAME = "GroundcoverRum"
        private const val EVENT_CHANNEL = "groundcover.rum"
    }
}
