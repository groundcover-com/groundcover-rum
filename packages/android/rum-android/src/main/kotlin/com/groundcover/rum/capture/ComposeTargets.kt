package com.groundcover.rum.capture

import android.view.View
import com.groundcover.rum.core.events.InteractionTarget

/**
 * Compose tap targets, when the app has Compose: compose-ui is compiled against, never shipped.
 * The semantics reading lives in [ComposeSemantics], which only loads once Compose is known to be
 * there.
 */
internal object ComposeTargets {
    val available: Boolean by lazy {
        try {
            Class.forName("androidx.compose.ui.node.RootForTest")
            true
        } catch (_: Throwable) {
            false
        }
    }

    /** The Compose text field that has focus in [view], if one does. */
    fun focusedField(view: View): FocusedField? = try {
        ComposeSemantics.focusedField(view)
    } catch (_: Throwable) {
        null
    }

    fun isComposeView(view: View): Boolean = try {
        ComposeSemantics.isRoot(view)
    } catch (_: Throwable) {
        false
    }

    /**
     * The element at ([rawX], [rawY]) in [view]'s semantics, or null when it has none there.
     * [viewPath] and [viewPrivate] are the hosting view's.
     */
    fun resolve(
        view: View,
        rawX: Float,
        rawY: Float,
        viewPath: String,
        viewPrivate: Boolean
    ): InteractionTarget? = try {
        ComposeSemantics.resolve(view, rawX, rawY, viewPath, viewPrivate)
    } catch (_: Throwable) {
        null
    }
}
