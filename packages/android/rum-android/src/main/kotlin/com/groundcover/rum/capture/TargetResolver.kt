package com.groundcover.rum.capture

import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.Checkable
import android.widget.EditText
import android.widget.TextView
import com.groundcover.rum.core.events.InteractionTarget
import com.groundcover.rum.groundcoverPrivate

/**
 * Names what a touch landed on the way TalkBack would: the view under the finger, or the Compose
 * element there, its content description (else its visible text), role, hint, state and value.
 * Runs once per finished touch sequence, on the main thread, with every walk bounded.
 */
internal object TargetResolver {
    const val NODE_BUDGET = 500
    const val MAX_DEPTH = 32
    const val MAX_PATH_SEGMENTS = 10
    const val MAX_PATH_LENGTH = 200
    const val MAX_LABEL_LENGTH = 200

    /** The target at ([rawX], [rawY]), screen pixels, inside the window whose root is [root]. */
    fun resolve(root: View, rawX: Float, rawY: Float): InteractionTarget {
        val budget = intArrayOf(NODE_BUDGET)
        val found = deepestHit(root, rawX, rawY, budget, 0)
        val hit = found ?: root
        if (ComposeTargets.available && ComposeTargets.isComposeView(hit)) {
            ComposeTargets.resolve(hit, rawX, rawY, componentPath(hit), isPrivate(hit))?.let {
                return it
            }
        }
        val target = actionable(hit)
        val textEntry = target is EditText
        val privateText = booleanArrayOf(false)
        // A point outside every view (a tap outside a dialog lands in its window) names nothing
        // there: the root's text would be the whole window's.
        val label = if (found == null) "" else label(target, privateText)
        return InteractionTarget(
            component = target.javaClass.simpleName,
            label = label,
            role = role(target),
            hint = "",
            state = state(target),
            valueText = if (textEntry) null else stateDescription(target),
            componentPath = componentPath(target),
            // The view under the finger may be private inside a target that isn't, and so may a
            // view whose text names it.
            masked = isPrivate(hit) || isPrivate(target) || privateText[0]
        )
    }

    /**
     * The deepest visible view containing the point, the topmost child first. Compose keeps its
     * interop views (an `AndroidView`, an `AndroidFragment`) in a holder as large as the whole
     * Compose view: the holder is passed through unless one of those views is under the finger,
     * so a touch on Compose content lands on the Compose view itself. The holder is known by where
     * it sits, any view directly inside a Compose view, never by its class name, which a minified
     * app renames.
     */
    private fun deepestHit(view: View, x: Float, y: Float, budget: IntArray, depth: Int): View? {
        if (budget[0]-- <= 0 || depth > MAX_DEPTH) return null
        if (view.visibility != View.VISIBLE || view.alpha <= 0f || !contains(view, x, y)) {
            return null
        }
        if (view is ViewGroup) {
            for (index in view.childCount - 1 downTo 0) {
                val child = view.getChildAt(index) ?: continue
                deepestHit(child, x, y, budget, depth + 1)?.let { return it }
            }
        }
        return if (isInteropHolder(view)) null else view
    }

    private fun isInteropHolder(view: View): Boolean {
        val parent = view.parent as? View ?: return false
        return ComposeTargets.available && ComposeTargets.isComposeView(parent)
    }

    private fun contains(view: View, x: Float, y: Float): Boolean {
        val location = IntArray(2)
        view.getLocationOnScreen(location)
        return x >= location[0] && x < location[0] + view.width &&
            y >= location[1] && y < location[1] + view.height
    }

    /**
     * The first node, depth first from [root], that [accept]s, the walk bounded as every other:
     * [NODE_BUDGET] nodes and [MAX_DEPTH] levels at most.
     */
    fun <T> firstWithin(root: T, children: (T) -> List<T>, accept: (T) -> Boolean): T? =
        firstWithin(root, children, accept, intArrayOf(NODE_BUDGET), 0)

    private fun <T> firstWithin(
        node: T,
        children: (T) -> List<T>,
        accept: (T) -> Boolean,
        budget: IntArray,
        depth: Int
    ): T? {
        if (budget[0]-- <= 0 || depth > MAX_DEPTH) return null
        if (accept(node)) return node
        for (child in children(node)) {
            firstWithin(child, children, accept, budget, depth + 1)?.let { return it }
        }
        return null
    }

    /** The view a tap acts on: the hit view, or its nearest clickable ancestor. */
    private fun actionable(hit: View): View {
        var current: View? = hit
        var depth = 0
        while (current != null && depth <= MAX_DEPTH) {
            if (current.isClickable || current.isLongClickable) return current
            current = current.parent as? View
            depth++
        }
        return hit
    }

    /**
     * The content description, else the view's text, else the text inside it; [privateText] is set
     * when that inner text came from a private view.
     */
    private fun label(view: View, privateText: BooleanArray): String {
        clean(view.contentDescription).takeIf { it.isNotEmpty() }?.let { return it }
        if (view is EditText) return ""
        if (view is TextView) clean(view.text).takeIf { it.isNotEmpty() }?.let { return it }
        val texts = mutableListOf<String>()
        collectText(view, texts, intArrayOf(50), false, privateText)
        return texts.joinToString(" ").take(MAX_LABEL_LENGTH)
    }

    private fun collectText(
        view: View,
        texts: MutableList<String>,
        budget: IntArray,
        insidePrivate: Boolean,
        privateText: BooleanArray
    ) {
        if (budget[0]-- <= 0 || texts.size >= 5 || view.visibility != View.VISIBLE) return
        if (view is EditText) return
        val private = insidePrivate || view.groundcoverPrivate
        if (view is TextView) {
            clean(view.text).takeIf { it.isNotEmpty() }?.let {
                texts.add(it)
                if (private) privateText[0] = true
            }
            return
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                view.getChildAt(index)?.let { collectText(it, texts, budget, private, privateText) }
            }
        }
    }

    /** RN's role for the view's accessibility class, which widgets set for TalkBack. */
    fun role(view: View): String = when (view.accessibilityClassName?.toString()) {
        "android.widget.Button", "android.widget.ImageButton" -> "button"
        "android.widget.CheckBox" -> "checkbox"
        "android.widget.Switch", "android.widget.ToggleButton" -> "switch"
        "android.widget.RadioButton" -> "radio"
        "android.widget.EditText" -> "textfield"
        "android.widget.ImageView" -> "image"
        "android.widget.SeekBar" -> "adjustable"
        "android.widget.TextView" -> "text"
        else -> ""
    }

    private fun state(view: View): Map<String, Any>? {
        val state = linkedMapOf<String, Any>()
        if (view.isSelected) state["selected"] = true
        // Checkable by type isn't checkable: MaterialButton and MaterialCardView always implement
        // it, and tell TalkBack they're checkable only when the app makes them so.
        if (view is Checkable && view.createAccessibilityNodeInfo().isCheckable) {
            state["checked"] = view.isChecked
        }
        if (!view.isEnabled) state["disabled"] = true
        return state.takeIf { it.isNotEmpty() }
    }

    private fun stateDescription(view: View): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return clean(view.stateDescription).takeIf { it.isNotEmpty() }
    }

    fun isPrivate(view: View): Boolean {
        var current: View? = view
        var depth = 0
        while (current != null && depth <= MAX_DEPTH) {
            if (current.groundcoverPrivate) return true
            current = current.parent as? View
            depth++
        }
        return false
    }

    /**
     * The views from the outside in (`DecorView > LinearLayout > Button`): the innermost
     * [MAX_PATH_SEGMENTS], cut from the outside to [MAX_PATH_LENGTH] characters.
     */
    fun componentPath(view: View): String {
        val names = mutableListOf<String>()
        var current: View? = view
        var depth = 0
        while (current != null && depth <= MAX_DEPTH) {
            val name = current.javaClass.simpleName
            if (name.isNotEmpty()) names.add(name)
            current = current.parent as? View
            depth++
        }
        val segments = names.take(MAX_PATH_SEGMENTS).reversed().toMutableList()
        while (segments.size > 1 && segments.joinToString(" > ").length > MAX_PATH_LENGTH) {
            segments.removeAt(0)
        }
        return segments.joinToString(" > ")
    }

    fun clean(text: CharSequence?): String {
        if (text == null) return ""
        return text.toString().trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            .joinToString(" ").take(MAX_LABEL_LENGTH)
    }
}
