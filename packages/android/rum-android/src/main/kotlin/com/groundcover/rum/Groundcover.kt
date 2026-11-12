package com.groundcover.rum

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.groundcover.rum.capture.Instrumentation
import com.groundcover.rum.capture.throwableCauses
import com.groundcover.rum.capture.throwableFrames
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.events.CustomEventCapture
import com.groundcover.rum.core.events.ErrorCapture
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.LogLevel
import com.groundcover.rum.core.events.NavigationEndCapture
import com.groundcover.rum.core.events.NavigationStartCapture
import com.groundcover.rum.core.nativeengine.InteractiveMarks
import com.groundcover.rum.core.pipeline.CorePipeline
import com.groundcover.rum.core.pipeline.RumRuntime
import com.groundcover.rum.core.platform.devicePlatform
import com.groundcover.rum.core.platform.isMainProcess

/**
 * The SDK's entry point.
 *
 * ```kotlin
 * class MyApp : Application() {
 *     override fun onCreate() {
 *         super.onCreate()
 *         try {
 *             Groundcover.start(
 *                 this,
 *                 GroundcoverConfig(
 *                     apiKey = "your-rum-ingestion-key",
 *                     dsn = "https://example.platform.grcv.io",
 *                     cluster = "your-cluster",
 *                     environment = "production",
 *                     appId = "my-android-app",
 *                 ),
 *             )
 *         } catch (e: GroundcoverInitException) {
 *             // The SDK couldn't start, and the app runs unmonitored.
 *             Log.w("MyApp", "groundcover", e)
 *         }
 *     }
 * }
 * ```
 *
 * Calls made before [start] are dropped, with a warning when `debug` is on. No call throws into
 * the app except [start], and every call returns at once: the work happens off the main thread.
 */
object Groundcover {
    @Volatile
    private var appContext: Context? = null

    internal val runtime =
        RumRuntime(makePlatform = { config -> devicePlatform(appContext!!, config) })

    /**
     * Starts the SDK. Call it once, in `Application.onCreate`; it runs in the app's main process
     * only (its default one, named after the package unless the manifest renames it), and in any
     * other process does nothing. An app whose Activities run in a named process isn't supported.
     * Throws [GroundcoverInitException]
     * when the start is invalid: a blank `appId`, or a null context or config from Java. Nothing
     * else it does throws: past that check, a failure leaves the app running unmonitored. A later
     * call does nothing.
     */
    @JvmStatic
    @Throws(GroundcoverInitException::class)
    fun start(context: Context, config: GroundcoverConfig) {
        // Java can pass null, which Kotlin's types don't stop.
        val givenContext: Context = (context as Context?)
            ?: throw GroundcoverInitException("start requires a context")
        val given: GroundcoverConfig = (config as GroundcoverConfig?)
            ?: throw GroundcoverInitException("start requires a config")
        if ((given.appId as String?).isNullOrBlank()) {
            throw GroundcoverInitException("start requires a nonblank appId")
        }
        try {
            val appContext = givenContext.applicationContext ?: givenContext
            // Application.onCreate runs in every process of the app, and the session state and
            // crash snapshot are one per app: a second process would overwrite the main one's.
            if (!isMainProcess(appContext)) {
                RumDiagnostics.shared.configure(debug = given.options.debug)
                RumDiagnostics.shared.log("start: not the app's main process; the SDK runs there")
                return
            }
            this.appContext = appContext
            if (runtime.start(given) && !runtime.isUnsampled) {
                Instrumentation.arm(appContext, given, runtime)
            }
        } catch (error: GroundcoverInitException) {
            throw error
        } catch (error: Throwable) {
            handleError(error)
        }
    }

    /** Stamps [user] on every batch from now on, merged into any identity set before. */
    @JvmStatic
    fun identifyUser(user: RumUser) {
        // Java can pass null, which Kotlin's types don't stop.
        val given: RumUser? = user
        if (given != null) dispatch("identifyUser") { it.identifyUser(given) }
    }

    /**
     * Changes the configuration after [start]. What is fixed at start isn't part of
     * [GroundcoverConfigUpdate].
     */
    @JvmStatic
    fun updateConfig(update: GroundcoverConfigUpdate) {
        val given: GroundcoverConfigUpdate? = update
        if (given != null) dispatch("updateConfig") { it.updateConfig(given) }
    }

    /**
     * Sends a custom event named [name]. Its [attributes] are sent as given: custom events are not
     * redacted, so scrub them in `enrichEvent` if they can carry personal data.
     */
    @JvmStatic
    @JvmOverloads
    fun sendCustomEvent(name: String, attributes: Map<String, Any?> = emptyMap()) {
        val given: String = (name as String?) ?: return
        // Copied now: the app may change its map before the core thread reads it.
        val capture = CustomEventCapture(given, copyOf(attributes) ?: emptyMap(), nowNs())
        dispatch("sendCustomEvent") { it.submit(capture) }
    }

    /**
     * Reports a handled [throwable], with its stack trace, its cause chain and optional [metadata].
     */
    @JvmStatic
    @JvmOverloads
    fun captureException(throwable: Throwable, metadata: Map<String, Any?>? = null) {
        val given: Throwable = (throwable as Throwable?) ?: return
        // Where a crash carries its own: the wrapper alone hides the root cause.
        val causes = throwableCauses(given)
        val capture = ErrorCapture(
            // The fully qualified name, as a crash and each cause carry it, so one exception
            // groups as one error_type whether it was handled or fatal. A simple name would also
            // merge unrelated classes once R8 renames them.
            type = given.javaClass.name,
            message = given.message ?: "",
            frames = throwableFrames(given),
            handled = true,
            metadata = if (causes.isEmpty()) {
                copyOf(metadata)
            } else {
                metadata.orEmpty() + ("causes" to causes)
            },
            timestampNs = nowNs()
        )
        dispatch("captureException") { it.submit(capture) }
    }

    /** Sends log events. */
    @JvmStatic
    val logger: RumLogger = RumLogger()

    /**
     * The current session id, or `""` before the SDK has started or when this session isn't
     * sampled.
     */
    @JvmStatic
    val sessionId: String
        get() = runtime.sessionId

    /**
     * Starts a new session, with [id] or a generated one. Whatever the old session buffered is sent
     * under it first; [onComplete] runs on the main thread once it has been handed over (or at once
     * there, when the call is dropped), so it can update the UI. What it throws is the app's own.
     */
    @JvmStatic
    @JvmOverloads
    fun setSessionId(id: String? = null, onComplete: Runnable? = null) {
        runtime.setSessionId(id) { if (onComplete != null) mainThread.post(onComplete) }
    }

    private val mainThread by lazy { Handler(Looper.getMainLooper()) }

    /**
     * Starts a manual navigation to [screen], with an optional [key] telling two visits to it
     * apart. It is stamped on events from now on; a blank [screen] is never reported. [metadata]
     * travels with the navigation.
     */
    @JvmStatic
    @JvmOverloads
    fun startNavigation(screen: String, key: String = "", metadata: Map<String, Any?>? = null) {
        // Java can pass null, which Kotlin's types don't stop.
        val name: String? = screen
        val given: String? = key
        val capture = NavigationStartCapture(name ?: "", given ?: "", copyOf(metadata))
        dispatch("startNavigation") { it.submit(capture) }
    }

    /** Ends the manual navigation [startNavigation] began and reports it, both calls' metadata merged. */
    @JvmStatic
    @JvmOverloads
    fun endNavigation(metadata: Map<String, Any?>? = null) {
        val capture = NavigationEndCapture(copyOf(metadata))
        dispatch("endNavigation") { it.submit(capture) }
    }

    /** Stops automatic screen tracking. Manual navigations still report. */
    @JvmStatic
    fun stopNavigationTracking() {
        Instrumentation.stopNavigationTracking()
    }

    /**
     * Marks the moment the app became usable, for time to interactive when [NativeOptions.tti] is
     * [TtiMode.MANUAL]. Call it once, when the first screen is genuinely ready. Only the first call
     * counts, and it counts before [start] too.
     */
    @JvmStatic
    fun markAppInteractive() {
        if (InteractiveMarks.shared.markManual(runtime.now()) && runtime.isStarted) {
            dispatch("markAppInteractive") { it.interactiveMarked() }
        }
    }

    internal fun log(level: LogLevel, message: String?, attributes: Map<String, Any?>?) {
        // A null message (e.getMessage() of an exception without one) is still a log line.
        val capture = LogCapture(message ?: "", level, copyOf(attributes), nowNs())
        dispatch("logger.${level.wireName}") { it.submit(capture) }
    }

    // Stamped on the caller's thread: when the app made the call, not when the core thread got
    // to it.
    private fun nowNs() = msToNs(runtime.now())

    private fun copyOf(map: Map<String, Any?>?): Map<String, Any?>? = map?.let(::LinkedHashMap)

    // No call but start throws into the app.
    private fun dispatch(name: String, work: (CorePipeline) -> Unit) {
        try {
            runtime.dispatch(name, work)
        } catch (error: Exception) {
            handleError(error)
        }
    }
}

/** Log events, one method per level. [attributes][info] travel with the message. */
class RumLogger internal constructor() {
    @JvmOverloads
    fun log(message: String, attributes: Map<String, Any?>? = null) {
        Groundcover.log(LogLevel.LOG, message, attributes)
    }

    @JvmOverloads
    fun info(message: String, attributes: Map<String, Any?>? = null) {
        Groundcover.log(LogLevel.INFO, message, attributes)
    }

    @JvmOverloads
    fun warn(message: String, attributes: Map<String, Any?>? = null) {
        Groundcover.log(LogLevel.WARN, message, attributes)
    }

    @JvmOverloads
    fun error(message: String, attributes: Map<String, Any?>? = null) {
        Groundcover.log(LogLevel.ERROR, message, attributes)
    }

    @JvmOverloads
    fun debug(message: String, attributes: Map<String, Any?>? = null) {
        Groundcover.log(LogLevel.DEBUG, message, attributes)
    }

    @JvmOverloads
    fun trace(message: String, attributes: Map<String, Any?>? = null) {
        Groundcover.log(LogLevel.TRACE, message, attributes)
    }
}

/** Thrown by [Groundcover.start] when the SDK can't start. Its message is the reason. */
class GroundcoverInitException
@JvmOverloads
constructor(
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)
