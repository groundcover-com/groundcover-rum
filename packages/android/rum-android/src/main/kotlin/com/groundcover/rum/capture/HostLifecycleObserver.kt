package com.groundcover.rum.capture

import android.app.Activity
import android.app.Application
import android.os.Bundle
import com.groundcover.rum.core.pipeline.HostLifecycle
import com.groundcover.rum.engine.lifecycle.GcRumForegroundMonitor

/**
 * The app's foreground state, from the engine's count of started Activities: entering the
 * background persists activity and flushes; coming back is a return, and a return is presence.
 * The launch is not a return, so an app nobody touches sends nothing. Android has no inactive
 * state to report.
 */
internal class LifecycleMapper(private val report: (HostLifecycle) -> Unit) {
    private var away = false

    fun foreground() {
        if (!away) return
        away = false
        report(HostLifecycle.FOREGROUND)
    }

    fun background() {
        away = true
        report(HostLifecycle.BACKGROUND)
    }
}

/** Feeds the engine's foreground monitor from the Activity callbacks. Main thread only. */
internal class HostLifecycleObserver(
    private val application: Application,
    report: (HostLifecycle) -> Unit
) : Application.ActivityLifecycleCallbacks {
    private val mapper = LifecycleMapper(report)
    private val monitor = GcRumForegroundMonitor(
        onForeground = { mapper.foreground() },
        onBackground = { mapper.background() }
    )

    fun start(hasVisibleActivity: Boolean) {
        monitor.beginCounting(hasVisibleActivity)
        monitor.startObserving(hasVisibleActivity)
        application.registerActivityLifecycleCallbacks(this)
    }

    fun stop() {
        application.unregisterActivityLifecycleCallbacks(this)
        monitor.stopObserving()
    }

    override fun onActivityStarted(activity: Activity) = monitor.activityStarted()

    override fun onActivityStopped(activity: Activity) =
        monitor.activityStopped(activity.isChangingConfigurations)

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

    override fun onActivityResumed(activity: Activity) {}

    override fun onActivityPaused(activity: Activity) {}

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

    override fun onActivityDestroyed(activity: Activity) {}
}
