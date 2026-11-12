package com.groundcover.rum.capture

import android.app.Activity
import android.view.View
import android.view.ViewTreeObserver
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.fragment.app.FragmentManager

/**
 * Fragment screens, when the app has androidx.fragment: compiled against, never shipped. The
 * Fragment types are only touched in [FragmentHook], which loads once the library is known to be
 * there.
 */
internal object FragmentScreens {
    private val available: Boolean by lazy {
        try {
            Class.forName("androidx.fragment.app.FragmentActivity")
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun register(activity: Activity, sources: ScreenSources) {
        if (!available) return
        try {
            FragmentHook.register(activity, sources)
        } catch (_: Throwable) {
            // A Fragment library too old for these callbacks: Activities still report.
        }
    }

    /** The app's screen Fragment [activity] shows now, or null: see [FragmentHook.shownScreen]. */
    fun shownScreen(activity: Activity): Any? {
        if (!available) return null
        return try {
            FragmentHook.shownScreen(activity)
        } catch (_: Throwable) {
            null
        }
    }
}

/**
 * Reports each of a FragmentActivity's screen Fragments, nested ones too, once it has resumed, or
 * been shown again while resumed, and its first frame is posted.
 */
internal object FragmentHook {
    /** Child Fragments walked under one, at most; past it, it is taken to hold a screen. */
    private const val MAX_DESCENDANTS = 50

    fun register(activity: Activity, sources: ScreenSources) {
        val host = activity as? FragmentActivity ?: return
        host.supportFragmentManager.registerFragmentLifecycleCallbacks(Screens(host, sources), true)
    }

    /**
     * One Activity's screen Fragments. Switching show/hide tabs changes no lifecycle state, only
     * the views' visibility, so after each layout the resumed Fragments' hidden flags are looked
     * at: one shown again is a screen the way a resumed one is.
     */
    private class Screens(
        private val activity: FragmentActivity,
        private val sources: ScreenSources
    ) : FragmentManager.FragmentLifecycleCallbacks(),
        ViewTreeObserver.OnGlobalLayoutListener {
        /** The resumed Fragments with a view, each with whether it was hidden at the last look. */
        private val hidden = HashMap<Fragment, Boolean>()
        private var listening = false

        override fun onFragmentResumed(manager: FragmentManager, fragment: Fragment) {
            val view = fragment.view ?: return
            hidden[fragment] = fragment.isHidden
            if (!listening) {
                activity.window?.decorView?.viewTreeObserver?.addOnGlobalLayoutListener(this)
                listening = true
            }
            if (isScreen(fragment)) shown(fragment, view)
        }

        override fun onFragmentPaused(manager: FragmentManager, fragment: Fragment) {
            hidden.remove(fragment)
        }

        override fun onGlobalLayout() {
            for (entry in hidden.entries) {
                val fragment = entry.key
                val isHidden = fragment.isHidden
                if (isHidden == entry.value) continue
                entry.setValue(isHidden)
                val view = fragment.view
                if (!isHidden && view != null && isScreen(fragment)) shown(fragment, view)
            }
        }

        private fun shown(fragment: Fragment, view: View) {
            // Asked again after the first frame, when a tab host holds its pages: still resumed,
            // with the same view, and still a screen.
            sources.fragmentShown(activity, fragment, view) {
                fragment.isResumed && fragment.view === view && isScreen(fragment)
            }
        }
    }

    /**
     * The screen Fragment [activity] shows now: a resumed one [isScreen] takes, nested ones
     * too, the last found when there are several. Asked when a modal's NavHost closes over it.
     */
    fun shownScreen(activity: Activity): Fragment? {
        val host = activity as? FragmentActivity ?: return null
        var found: Fragment? = null
        fun walk(manager: FragmentManager) {
            for (fragment in manager.fragments) {
                if (!fragment.isAdded) continue
                if (fragment.isResumed && isScreen(fragment)) found = fragment
                if (fragment !is DialogFragment) walk(fragment.childFragmentManager)
            }
        }
        walk(host.supportFragmentManager)
        return found
    }

    /**
     * The app's own shown Fragment, outside any dialog, that holds none of the app's own:
     * children resume before their parent, so a tab host or a Fragment around a NavHost would
     * replace the screen it shows.
     */
    private fun isScreen(fragment: Fragment): Boolean = isAppsOwn(fragment) &&
        !inDialog(fragment) && !holdsScreen(fragment, intArrayOf(MAX_DESCENDANTS))

    /**
     * Whether a shown Fragment under [fragment] is the app's own, looking through androidx's and
     * Google's (a NavHostFragment holds screens; a SupportMapFragment is part of one), but not
     * into a dialog's.
     */
    private fun holdsScreen(fragment: Fragment, budget: IntArray): Boolean =
        fragment.childFragmentManager.fragments.any { child ->
            budget[0]-- <= 0 ||
                (child !is DialogFragment && (isAppsOwn(child) || holdsScreen(child, budget)))
        }

    /**
     * Whether a dialog (a bottom sheet) holds [fragment]. Neither a dialog nor the Fragments in
     * it are screens: once it is dismissed, nothing would report the screen below again.
     */
    private fun inDialog(fragment: Fragment): Boolean =
        generateSequence(fragment.parentFragment) { it.parentFragment }
            .any { it is DialogFragment }

    /**
     * A shown Fragment with a view of its own that isn't androidx's or Google's, nor a dialog. A
     * hidden one (a show/hide tab, or any Fragment under one) keeps its view and resumes with the
     * shown one, so it would take the screen from it; it is a screen once shown.
     */
    private fun isAppsOwn(fragment: Fragment): Boolean {
        val name = fragment.javaClass.name
        return fragment.view != null && !fragment.isHidden && fragment !is DialogFragment &&
            !name.startsWith("androidx.") && !name.startsWith("com.google.")
    }
}
