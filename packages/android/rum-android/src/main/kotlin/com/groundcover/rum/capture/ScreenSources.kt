package com.groundcover.rum.capture

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.view.View
import java.util.WeakHashMap

/**
 * Reports the screens the app shows, from three sources, the innermost winning inside one
 * Activity: a navigation destination (`GroundcoverNavigationEffect`), then a Fragment, then the
 * Activity itself. An Activity or a Fragment is decided once its first frame is posted, when a
 * Compose destination has reported itself and a ViewPager2 has added its pages. An Activity is
 * reported only if, by then, no destination reported in it and no Fragment that may be a screen
 * resumed in it; a Fragment isn't reported while a navigation effect runs in its Activity, so a
 * Fragment hosted by a destination is one screen, not two. An Activity a navigation effect runs
 * in reports its last destination again as it resumes. When the effect that reported last ends
 * while its Activity is shown (a modal's NavHost closing), the screen under it is reported again,
 * since it wouldn't report itself: another effect's destination at once, or else, decided after
 * the next frame as on resume, the screen Fragment or the Activity shown then. Main thread only.
 */
internal class ScreenSources(
    private val application: Application,
    private val activities: Boolean,
    private val fragments: Boolean,
    private val report: (name: String, key: String) -> Unit
) : Application.ActivityLifecycleCallbacks {
    private class ActivityState {
        /**
         * A destination, or a Fragment that may be a screen, since the Activity resumed or its
         * last navigation effect ended.
         */
        var nestedSinceResume = false

        /** Between the Activity's resume and its pause: a screen reported meanwhile is shown. */
        var resumed = false

        /**
         * The navigation effects running here, each with its last destination (name and key), in
         * the order they reported: the last one's is the screen.
         */
        val effects = LinkedHashMap<Any, Pair<String, String>>()

        val destination: Pair<String, String>? get() = effects.values.lastOrNull()
    }

    private val states = WeakHashMap<Activity, ActivityState>()
    private val keys = WeakHashMap<Any, String>()
    private val counters = mutableMapOf<String, Int>()

    /** False after `stopNavigationTracking`: the automatic sources report nothing more. */
    var tracking = true

    fun start() {
        application.registerActivityLifecycleCallbacks(this)
    }

    fun stop() {
        application.unregisterActivityLifecycleCallbacks(this)
        states.clear()
    }

    /** [effect]'s controller in [activity] is on a new destination. */
    fun navigationDestination(activity: Activity?, effect: Any, name: String, key: String) {
        activity?.let { state(it) }?.apply {
            nestedSinceResume = true
            effects.remove(effect)
            effects[effect] = name to key
        }
        if (tracking) report(name, key)
    }

    /**
     * [effect] left the composition. When it was the last to report and its Activity is shown,
     * the screen under it is current again. An Activity that is going (Back, a rotation) disposes
     * its effects once paused, and the next screen reports itself.
     */
    fun navigationEffectEnded(activity: Activity?, effect: Any) {
        val state = activity?.let { states[it] } ?: return
        val wasCurrent = state.effects.keys.lastOrNull() === effect
        state.effects.remove(effect)
        if (!wasCurrent || !tracking || !state.resumed) return
        state.destination?.let {
            report(it.first, it.second)
            return
        }
        // The last effect: decided after the next frame, as on resume, so a Fragment shown in
        // its place reports itself instead.
        state.nestedSinceResume = false
        activity.window?.decorView?.post {
            if (!tracking || !state.resumed || state.nestedSinceResume) return@post
            if (state.destination != null) return@post
            shownScreen(activity)?.let { report(it.first, it.second) }
        }
    }

    /**
     * The screen [activity] shows without a navigation effect, found now: its shown screen
     * Fragment, or else the Activity itself, as each would report itself.
     */
    private fun shownScreen(activity: Activity): Pair<String, String>? {
        val instance = (if (fragments) FragmentScreens.shownScreen(activity) else null)
            ?: activity.takeIf { activities }
            ?: return null
        val name = instance.javaClass.simpleName
        return if (name.isEmpty()) null else name to key(instance, name)
    }

    /**
     * A Fragment that may be a screen resumed, or was shown again, in [activity], with [view] its
     * view. [isScreen] decides once the view's first frame is posted: a ViewPager2 adds its pages
     * at its first layout, so a tab host only holds them by then. The Activity isn't reported
     * meanwhile.
     */
    fun fragmentShown(activity: Activity, fragment: Any, view: View, isScreen: () -> Boolean) {
        val state = state(activity)
        if (state.destination != null) return
        state.nestedSinceResume = true
        view.post {
            if (!tracking || state.destination != null || !isScreen()) return@post
            val name = fragment.javaClass.simpleName
            if (name.isNotEmpty()) report(name, key(fragment, name))
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (fragments) FragmentScreens.register(activity, this)
    }

    override fun onActivityResumed(activity: Activity) {
        val state = state(activity)
        state.resumed = true
        state.nestedSinceResume = false
        // Back from another Activity: the NavController doesn't report the destination it is
        // still on, so it is the screen again from here. The same screen twice is one screen.
        if (tracking) state.destination?.let { report(it.first, it.second) }
        if (!activities) return
        val decor = activity.window?.decorView ?: return
        // After the first frame's traversal, where a Compose destination reports itself.
        decor.post {
            if (!tracking || state.nestedSinceResume || state.destination != null) return@post
            val name = activity.javaClass.simpleName
            if (name.isNotEmpty()) report(name, key(activity, name))
        }
    }

    override fun onActivityStarted(activity: Activity) {}

    override fun onActivityPaused(activity: Activity) {
        states[activity]?.resumed = false
    }

    override fun onActivityStopped(activity: Activity) {}

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

    override fun onActivityDestroyed(activity: Activity) {
        states.remove(activity)
    }

    private fun state(activity: Activity): ActivityState = states.getOrPut(activity) {
        ActivityState()
    }

    /**
     * `name-n`, fixed per instance: two instances of one screen are told apart, and a return to an
     * instance that is still alive reuses its key.
     */
    private fun key(instance: Any, name: String): String = keys.getOrPut(instance) {
        val next = (counters[name] ?: 0) + 1
        counters[name] = next
        "$name-$next"
    }
}
