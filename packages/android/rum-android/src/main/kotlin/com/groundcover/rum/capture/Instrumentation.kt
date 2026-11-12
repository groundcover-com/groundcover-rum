package com.groundcover.rum.capture

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.events.InteractionCapture
import com.groundcover.rum.core.events.ScreenCapture
import com.groundcover.rum.core.pipeline.RumRuntime

/**
 * What the SDK watches in the host app, armed by `Groundcover.start` with the hooks the
 * configuration leaves on, and disarmed by `GroundcoverRumTesting.reset`. Nothing is armed for a
 * session the sampling verdict left out. Every observer runs on the main thread and hands its
 * capture to the core thread.
 */
internal object Instrumentation {
    private val main = Handler(Looper.getMainLooper())
    private var lifecycle: HostLifecycleObserver? = null
    private var windows: WindowTracker? = null
    private var touches: TouchObserver? = null
    private var screens: ScreenSources? = null

    fun arm(context: Context, config: GroundcoverConfig, runtime: RumRuntime) {
        val application = context.applicationContext as? Application ?: return
        onMain { armOnMain(application, config, runtime) }
    }

    fun disarm() {
        onMain { disarmOnMain() }
    }

    private fun armOnMain(
        application: Application,
        config: GroundcoverConfig,
        runtime: RumRuntime
    ) {
        disarmOnMain()
        lifecycle = HostLifecycleObserver(application) { state ->
            runtime.dispatch("lifecycle") { it.lifecycle(state) }
        }.also { it.start(hasVisibleActivity = false) }
        val hooks = config.options.hooks
        screens = ScreenSources(application, hooks.activities, hooks.fragments) { name, key ->
            runtime.dispatch("screen") { it.submit(ScreenCapture(name, key)) }
        }.also { it.start() }
        if (hooks.windowCallback) {
            val submit: (InteractionCapture) -> Unit = { capture ->
                val stamped = InteractionCapture(
                    capture.kind,
                    capture.target,
                    capture.x,
                    capture.y,
                    capture.gesture,
                    timestampNs = msToNs(runtime.now())
                )
                runtime.dispatch("interaction") { it.submit(stamped) }
            }
            val fields = if (hooks.textFields) TextFieldObserver(submit) else null
            lateinit var tracker: WindowTracker
            val observer = TouchObserver(
                onPresence = { runtime.dispatch("presence") { it.presence() } },
                onInteraction = submit,
                onFocusLost = {
                    fields?.onWindowFocusLost()
                    tracker.scanSoon()
                },
                onTap = { x, y -> fields?.onTap(x, y) },
                checkFocus = { window -> fields?.refresh(window) },
                onKeyEvent = { window, event -> fields?.onKey(window, event) }
            )
            tracker = WindowTracker(application, observer) { RumDiagnostics.shared.log(it) }
            tracker.start(initial = null)
            touches = observer
            windows = tracker
        }
    }

    private fun disarmOnMain() {
        lifecycle?.stop()
        lifecycle = null
        windows?.stop()
        windows = null
        touches?.reset()
        touches = null
        screens?.stop()
        screens = null
    }

    /** `Groundcover.stopNavigationTracking`: the automatic screen sources report nothing more. */
    fun stopNavigationTracking() {
        onMain { screens?.tracking = false }
    }

    /** `GroundcoverNavigationEffect`'s report, through [GroundcoverInternal]. */
    fun navigationDestination(activity: Activity?, effect: Any, name: String, key: String) {
        onMain { screens?.navigationDestination(activity, effect, name, key) }
    }

    fun navigationEffectEnded(activity: Activity?, effect: Any) {
        onMain { screens?.navigationEffectEnded(activity, effect) }
    }

    private fun onMain(work: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) work() else main.post(work)
    }
}
