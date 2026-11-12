package com.groundcover.rum.core.events

import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.privacy.EffectivePrivacy
import com.groundcover.rum.core.privacy.redactMetadata

// The screen every event is stamped with, and the navigation events between screens.

/** A screen change: from a screen source, or the manual navigation API. */
internal sealed class NavigationCapture : Capture()

/**
 * A screen became current. The pipeline stamps it on every later event and reports the
 * navigation, with the screen it left and how long that one was shown. An empty name is ignored.
 */
internal class ScreenCapture(val name: String, val key: String) : NavigationCapture()

/** `Groundcover.startNavigation`. A blank [screen] is dropped at its end. */
internal class NavigationStartCapture(
    val screen: String,
    val key: String = "",
    val metadata: Map<String, Any?>? = null
) : NavigationCapture()

/**
 * `Groundcover.endNavigation`: reports the navigation started last, with both calls' metadata
 * merged.
 */
internal class NavigationEndCapture(val metadata: Map<String, Any?>? = null) : NavigationCapture()

/**
 * The screen stamped on events, the automatic sources' last screen (which a manual navigation
 * does not move), and the manual navigation in progress.
 */
internal class NavigationTracker {
    /**
     * The current screen, set before a navigation is built, so the navigation and everything after
     * it carry it. Empty before the first.
     */
    var screenName = ""
        private set
    var screenKey = ""
        private set

    private var lastName = ""
    private var lastKey = ""

    /** When the last automatic screen became current; 0 before the first. */
    private var lastChangeMs = 0L

    private class Manual(
        val name: String,
        val key: String,
        val metadata: Map<String, Any?>?,
        val startMs: Long
    )

    private var manual: Manual? = null

    /** The navigation event [capture] completes at [nowMs], if any. */
    fun handle(capture: NavigationCapture, nowMs: Long, privacy: EffectivePrivacy): EnrichInput? =
        when (capture) {
            is ScreenCapture -> onScreen(capture.name, capture.key, nowMs, privacy)

            is NavigationStartCapture -> {
                val name = if (capture.screen.isBlank()) "" else capture.screen
                val key = if (capture.key.isBlank()) "" else capture.key
                manual = Manual(name, key, capture.metadata, nowMs)
                if (name.isNotEmpty()) {
                    screenName = name
                    screenKey = key
                }
                null
            }

            is NavigationEndCapture -> {
                val active = manual
                manual = null
                // A record with no screen name is never shipped.
                if (active == null || active.name.isEmpty()) {
                    null
                } else {
                    screenName = active.name
                    screenKey = active.key
                    val merged = LinkedHashMap<String, Any?>()
                    active.metadata?.let { merged.putAll(it) }
                    capture.metadata?.let { merged.putAll(it) }
                    navigation(
                        privacy,
                        durationMs = nowMs - active.startMs,
                        metadata = merged,
                        startMs = active.startMs,
                        endMs = nowMs
                    )
                }
            }
        }

    private fun onScreen(
        name: String,
        key: String,
        nowMs: Long,
        privacy: EffectivePrivacy
    ): EnrichInput? {
        if (name.isEmpty() || (name == lastName && key == lastKey)) return null
        val from = lastName
        val fromKey = lastKey
        val durationMs = if (lastChangeMs == 0L) 0L else nowMs - lastChangeMs
        lastName = name
        lastKey = key
        screenName = name
        screenKey = key
        lastChangeMs = nowMs
        return navigation(
            privacy,
            from = from,
            fromKey = fromKey,
            durationMs = durationMs,
            startMs = nowMs - durationMs,
            endMs = nowMs
        )
    }

    private fun navigation(
        privacy: EffectivePrivacy,
        from: String = "",
        fromKey: String = "",
        durationMs: Long,
        metadata: Map<String, Any?>? = null,
        startMs: Long,
        endMs: Long
    ): EnrichInput {
        val attributes = linkedMapOf<String, Any?>()
        if (from.isNotEmpty()) attributes["from_screen"] = from
        if (fromKey.isNotEmpty()) attributes["from_key"] = fromKey
        redactMetadata(metadata, privacy)?.let { attributes["metadata"] = it }
        attributes["duration_ms"] = durationMs
        attributes["start_timestamp"] = msToNs(startMs)
        attributes["end_timestamp"] = msToNs(endMs)
        return EnrichInput(type = "navigation", attributes = attributes)
    }
}
