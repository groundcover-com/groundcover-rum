package com.groundcover.rum.capture

import android.graphics.Rect
import android.view.View
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import com.groundcover.rum.core.events.InteractionTarget
import java.lang.ref.WeakReference

/**
 * Reads a Compose root's merged semantics, the tree TalkBack reads. Only touched after
 * [ComposeTargets.available] said Compose is in the app.
 */
internal object ComposeSemantics {
    /** The key `Modifier.groundcoverPrivate()` sets, matched by name across modules. */
    private const val PRIVATE_KEY = "GroundcoverPrivate"

    fun isRoot(view: View): Boolean = view is RootForTest

    fun resolve(
        view: View,
        rawX: Float,
        rawY: Float,
        viewPath: String,
        viewPrivate: Boolean
    ): InteractionTarget? {
        val root = (view as? RootForTest)?.semanticsOwner?.rootSemanticsNode ?: return null
        val onScreen = IntArray(2)
        val inWindow = IntArray(2)
        view.getLocationOnScreen(onScreen)
        view.getLocationInWindow(inWindow)
        val x = rawX - (onScreen[0] - inWindow[0])
        val y = rawY - (onScreen[1] - inWindow[1])
        val budget = intArrayOf(TargetResolver.NODE_BUDGET)
        val node = deepest(root, x, y, budget, 0, actionable = true)
            ?: deepest(root, x, y, intArrayOf(TargetResolver.NODE_BUDGET), 0, actionable = false)
            ?: return null
        return targetOf(node, viewPath, viewPrivate)
    }

    /** The text field that has focus in [view]'s semantics, if one does. */
    fun focusedField(view: View): FocusedField? {
        val node = find(view) {
            it.config.getOrNull(SemanticsProperties.Focused) == true &&
                it.config.getOrNull(SemanticsProperties.EditableText) != null
        } ?: return null
        return ComposeField(WeakReference(view), node.id)
    }

    /**
     * The first node of [view]'s merged semantics that [accept]s, the walk bounded as the tap's
     * is: it runs on the main thread after every touch sequence and key.
     */
    private fun find(view: View?, accept: (SemanticsNode) -> Boolean): SemanticsNode? {
        val root = (view as? RootForTest)?.semanticsOwner?.rootSemanticsNode ?: return null
        return TargetResolver.firstWithin(root, { it.children }, accept)
    }

    private class ComposeField(val view: WeakReference<View>, val id: Int) : FocusedField {
        private fun node(): SemanticsNode? = find(view.get()) { it.id == id }

        override fun sameAs(other: FocusedField): Boolean =
            other is ComposeField && other.id == id && other.view.get() === view.get()

        override fun textHash(): Int? =
            node()?.config?.getOrNull(SemanticsProperties.EditableText)?.text?.hashCode()

        override fun bounds(): Rect? {
            val root = view.get() ?: return null
            val bounds = node()?.boundsInWindow ?: return null
            val onScreen = IntArray(2)
            val inWindow = IntArray(2)
            root.getLocationOnScreen(onScreen)
            root.getLocationInWindow(inWindow)
            val dx = onScreen[0] - inWindow[0]
            val dy = onScreen[1] - inWindow[1]
            return Rect(
                bounds.left.toInt() + dx,
                bounds.top.toInt() + dy,
                bounds.right.toInt() + dx,
                bounds.bottom.toInt() + dy
            )
        }

        override fun target(): InteractionTarget? {
            val root = view.get() ?: return null
            val node = node() ?: return null
            return targetOf(
                node,
                TargetResolver.componentPath(root),
                TargetResolver.isPrivate(root)
            )
        }
    }

    private fun targetOf(
        node: SemanticsNode,
        viewPath: String,
        viewPrivate: Boolean
    ): InteractionTarget {
        val config = node.config
        val editable = config.getOrNull(SemanticsProperties.EditableText) != null
        val description = config.getOrNull(SemanticsProperties.ContentDescription)
            ?.joinToString(" ")
        val text = if (editable) {
            null
        } else {
            config.getOrNull(SemanticsProperties.Text)
                ?.joinToString(" ") { it.text }
        }
        val state = linkedMapOf<String, Any>()
        if (config.getOrNull(SemanticsProperties.Selected) == true) state["selected"] = true
        when (config.getOrNull(SemanticsProperties.ToggleableState)) {
            ToggleableState.On -> state["checked"] = true
            ToggleableState.Off -> state["checked"] = false
            ToggleableState.Indeterminate -> state["checked"] = "mixed"
            null -> {}
        }
        if (config.contains(SemanticsProperties.Disabled)) state["disabled"] = true
        if (config.getOrNull(SemanticsActions.Collapse) != null) state["expanded"] = true
        if (config.getOrNull(SemanticsActions.Expand) != null) state["expanded"] = false
        return InteractionTarget(
            component = "",
            label = TargetResolver.clean(description?.takeIf { it.isNotBlank() } ?: text),
            role = role(node, editable),
            hint = TargetResolver.clean(config.getOrNull(SemanticsActions.OnClick)?.label),
            state = state.takeIf { it.isNotEmpty() },
            valueText = if (editable) {
                null
            } else {
                config.getOrNull(SemanticsProperties.StateDescription)
                    ?.let { TargetResolver.clean(it) }?.takeIf { it.isNotEmpty() }
            },
            componentPath = viewPath,
            masked = viewPrivate || isPrivate(node)
        )
    }

    /**
     * The deepest node containing the point; with [actionable], the deepest one that can be
     * clicked, as the element a tap acts on.
     */
    private fun deepest(
        node: SemanticsNode,
        x: Float,
        y: Float,
        budget: IntArray,
        depth: Int,
        actionable: Boolean
    ): SemanticsNode? {
        if (budget[0]-- <= 0 || depth > TargetResolver.MAX_DEPTH) return null
        val bounds = node.boundsInWindow
        if (!(x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom)) {
            return null
        }
        for (child in node.children.asReversed()) {
            deepest(child, x, y, budget, depth + 1, actionable)?.let { return it }
        }
        if (!actionable) return node
        val config = node.config
        val clickable = config.getOrNull(SemanticsActions.OnClick) != null ||
            config.getOrNull(SemanticsActions.OnLongClick) != null
        return if (clickable) node else null
    }

    private fun role(node: SemanticsNode, editable: Boolean): String {
        if (editable) return "textfield"
        return when (node.config.getOrNull(SemanticsProperties.Role)) {
            Role.Button -> "button"
            Role.Checkbox -> "checkbox"
            Role.Switch -> "switch"
            Role.RadioButton -> "radio"
            Role.Tab -> "tab"
            Role.Image -> "image"
            Role.DropdownList -> "combobox"
            else -> ""
        }
    }

    private fun isPrivate(node: SemanticsNode): Boolean {
        var current: SemanticsNode? = node
        var depth = 0
        while (current != null && depth <= TargetResolver.MAX_DEPTH) {
            if (current.config.any { it.key.name == PRIVATE_KEY }) return true
            current = current.parent
            depth++
        }
        return false
    }
}
