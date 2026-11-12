package com.groundcover.rum.capture

import android.graphics.Rect
import android.view.KeyEvent
import android.view.View
import android.view.Window
import android.widget.EditText
import com.groundcover.rum.core.events.InteractionCapture
import com.groundcover.rum.core.events.InteractionKind
import com.groundcover.rum.core.events.InteractionTarget
import java.lang.ref.WeakReference

/**
 * One `input` interaction per edit of a text field, an `EditText` or a Compose text field, labelled
 * as TalkBack names it, and never the text: an edit counts only when the text's hash, kept in
 * memory and never sent, moved. The edit ends when focus leaves the field or its window, at Enter,
 * or at a tap outside it (Compose keeps a field focused through a tap elsewhere), whichever comes
 * first, and reports once. Focus is followed as a window gains it, as it moves between the window's
 * views and once the app has handled each touch sequence, so a field is known before a soft
 * keyboard types into it, even one focused before its window was shown: the keyboard can't type
 * before its window has focus. A tap is checked before the app handles it, so the edit it ends
 * comes before the tap. Compose moves focus between its own fields without moving the View focus: a
 * Compose field reached by an IME's Next is only seen at the next touch or key, after its typing.
 * Main thread only.
 */
internal class TextFieldObserver(private val report: (InteractionCapture) -> Unit) {
    /** The field being edited, and the hash of its text when the edit began or last reported. */
    private class Editing(val field: FocusedField, var baseline: Int)

    private var editing: Editing? = null

    /** A tap at ([tapX], [tapY]), screen pixels, before the app handles it. */
    fun onTap(tapX: Float, tapY: Float) {
        val current = editing ?: return
        val bounds = current.field.bounds() ?: return
        if (!bounds.contains(tapX.toInt(), tapY.toInt())) finish(current)
    }

    fun onKey(window: Window, event: KeyEvent) {
        if (event.action != KeyEvent.ACTION_UP) return
        refresh(window)
        val current = editing ?: return
        if (event.keyCode == KeyEvent.KEYCODE_ENTER ||
            event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
        ) {
            finish(current)
        }
    }

    /**
     * The window lost focus: Back, Home or a dialog over it move no view focus and need no touch,
     * so the edit ends here. The field is still followed, and typing after a return to it is an
     * edit of its own.
     */
    fun onWindowFocusLost() {
        editing?.let { finish(it) }
    }

    fun reset() {
        editing = null
    }

    /** Ends the edit of a field that lost focus, and starts following the one that has it. */
    fun refresh(window: Window) {
        val focused = focusedField(window)
        val current = editing
        if (current != null && (focused == null || !focused.sameAs(current.field))) {
            finish(current)
            editing = null
        }
        if (focused != null && editing == null) {
            editing = Editing(focused, focused.textHash() ?: return)
        }
    }

    private fun finish(current: Editing) {
        val hash = current.field.textHash() ?: return
        if (hash == current.baseline) return
        current.baseline = hash
        val target = current.field.target() ?: return
        report(InteractionCapture(InteractionKind.INPUT, target))
    }

    private fun focusedField(window: Window): FocusedField? {
        val focus = window.peekDecorView()?.findFocus() ?: return null
        if (focus is EditText) return EditTextField(WeakReference(focus))
        if (ComposeTargets.available && ComposeTargets.isComposeView(focus)) {
            return ComposeTargets.focusedField(focus)
        }
        return null
    }
}

/** A field that can be edited: who it is, its text's hash, where it is and what it's called. */
internal interface FocusedField {
    fun sameAs(other: FocusedField): Boolean

    fun textHash(): Int?

    /** On screen, in pixels. */
    fun bounds(): Rect?

    fun target(): InteractionTarget?
}

private class EditTextField(private val view: WeakReference<EditText>) : FocusedField {
    override fun sameAs(other: FocusedField): Boolean =
        other is EditTextField && other.view.get() === view.get()

    override fun textHash(): Int? = view.get()?.text?.toString()?.hashCode()

    override fun bounds(): Rect? = view.get()?.let { field ->
        val location = IntArray(2)
        field.getLocationOnScreen(location)
        Rect(location[0], location[1], location[0] + field.width, location[1] + field.height)
    }

    override fun target(): InteractionTarget? = view.get()?.let { field ->
        InteractionTarget(
            component = field.javaClass.simpleName,
            label = TargetResolver.clean(field.contentDescription).ifEmpty {
                TargetResolver.clean(field.hint)
            },
            role = "textfield",
            componentPath = TargetResolver.componentPath(field),
            masked = isPrivate(field)
        )
    }

    private fun isPrivate(view: View): Boolean = TargetResolver.isPrivate(view)
}
