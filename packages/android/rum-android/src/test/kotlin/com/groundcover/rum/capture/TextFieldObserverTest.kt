package com.groundcover.rum.capture

import android.app.Activity
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.core.events.InteractionCapture
import com.groundcover.rum.core.events.InteractionKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

// One input per edit of an EditText, labelled and never the text; the edit ends when focus leaves
// it or its window, at Enter, or at a tap outside it, and reports once. Driven as a phone drives
// it: taps through the wrapped window, the tap before the focus it gives, and typing through the
// field's input connection, as a soft keyboard types, with no key events.

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TextFieldObserverTest {
    private lateinit var controller: ActivityController<Activity>
    private lateinit var activity: Activity
    private lateinit var field: EditText
    private lateinit var other: EditText
    private lateinit var pay: Button
    private val captures = mutableListOf<InteractionCapture>()
    private val observer = TextFieldObserver { captures.add(it) }

    /**
     * An Activity whose window is wrapped as it is created, as the SDK wraps one, with a form laid
     * out in onCreate, then shown and given window focus as a phone shows it. [fieldFocused]: the
     * form gives the field focus there, before the window is shown. [wrappedLate]: the window is
     * wrapped only once it has focus, as when the SDK starts late.
     */
    private fun setUp(fieldFocused: Boolean = false, wrappedLate: Boolean = false) {
        // Wired as Instrumentation wires it.
        val touches = TouchObserver(
            onPresence = {},
            onInteraction = {},
            onFocusLost = { observer.onWindowFocusLost() },
            onTap = { x, y -> observer.onTap(x, y) },
            checkFocus = { observer.refresh(it) },
            onKeyEvent = { window, event -> observer.onKey(window, event) }
        )
        val tracker = WindowTracker(ApplicationProvider.getApplicationContext(), touches) {}
        if (!wrappedLate) tracker.start(null)
        controller = Robolectric.buildActivity(Activity::class.java).create()
        activity = controller.get()
        val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        // A form's IME actions: Next moves focus itself, sending no key event.
        field = EditText(activity).apply {
            contentDescription = "Search field"
            imeOptions = EditorInfo.IME_ACTION_NEXT
        }
        other = EditText(activity).apply {
            hint = "Name"
            imeOptions = EditorInfo.IME_ACTION_DONE
        }
        pay = Button(activity).apply { text = "Pay" }
        column.addView(field, ViewGroup.LayoutParams(300, 100))
        column.addView(other, ViewGroup.LayoutParams(300, 100))
        column.addView(pay, ViewGroup.LayoutParams(300, 100))
        activity.setContentView(column)
        if (fieldFocused) field.requestFocus()
        controller.start().resume().visible().windowFocusChanged(true)
        if (wrappedLate) tracker.start(activity)
        idle()
        assertTrue(activity.window.callback is GroundcoverWindowCallback)
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun tap(view: View) {
        tap(activity.window, view)
        idle()
    }

    /** As a soft keyboard types: through the input connection, no key events. */
    private fun type(into: EditText, text: String) {
        into.onCreateInputConnection(EditorInfo()).commitText(text, 1)
        idle()
    }

    @Test
    fun anEditThatChangedTheFieldIsOneLabelledInputWithoutTheText() {
        setUp()
        tap(field)
        assertTrue(field.isFocused)
        type(field, "hunter2@example.com")
        tap(other)
        assertEquals(1, captures.size)
        assertEquals(InteractionKind.INPUT, captures.single().kind)
        assertEquals("Search field", captures.single().target.label)
        assertEquals("textfield", captures.single().target.role)
        assertFalse(captures.single().target.toString().contains("hunter2"))
        assertTrue(captures.single().x == null)
    }

    /** As a soft keyboard's Next: focus moves on to the next field, with no key event. */
    private fun next(from: EditText) {
        from.onCreateInputConnection(EditorInfo()).performEditorAction(EditorInfo.IME_ACTION_NEXT)
        idle()
    }

    @Test
    fun aFieldFocusedAsTheScreenOpensIsFollowedFromTheWindowsFocus() {
        // That focus moved before the window was shown, so no view-focus change follows, and with
        // the keyboard already up the user types without touching the screen.
        setUp(fieldFocused = true)
        type(field, "hunter2@example.com")
        next(field)
        assertEquals(listOf("Search field"), captures.map { it.target.label })
    }

    @Test
    fun aFieldFocusedBeforeItsWindowIsWrappedIsFollowedFromTheWrap() {
        // The window already has focus, so no focus change will tell the SDK.
        setUp(fieldFocused = true, wrappedLate = true)
        type(field, "hunter2@example.com")
        next(field)
        assertEquals(listOf("Search field"), captures.map { it.target.label })
    }

    @Test
    fun anEditThatChangedNothingSendsNothing() {
        setUp()
        tap(field)
        tap(other)
        tap(pay)
        assertTrue(captures.isEmpty())
    }

    @Test
    fun anImesNextEndsTheEditAndTheNextFieldsEditIsItsOwn() {
        setUp()
        tap(field)
        type(field, "hunter2@example.com")
        next(field)
        assertTrue(other.isFocused)
        assertEquals(listOf("Search field"), captures.map { it.target.label })
        type(other, "Dana")
        tap(pay)
        assertEquals(listOf("Search field", "Name"), captures.map { it.target.label })
    }

    @Test
    fun enterThenATapOutsideReportOnce() {
        setUp()
        tap(field)
        type(field, "hunter2@example.com")
        activity.window.callback.dispatchKeyEvent(
            KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER)
        )
        idle()
        tap(pay)
        assertEquals(1, captures.size)
    }

    @Test
    fun leavingTheWindowEndsTheEditAndTheFieldIsStillFollowed() {
        // Back or Home moves no view focus and needs no touch: the window losing focus is all.
        setUp()
        tap(field)
        type(field, "hunter2@example.com")
        controller.windowFocusChanged(false)
        assertEquals(listOf("Search field"), captures.map { it.target.label })
        // Back to it: the next typing is an edit of its own.
        controller.windowFocusChanged(true)
        type(field, "!")
        tap(pay)
        assertEquals(listOf("Search field", "Search field"), captures.map { it.target.label })
    }

    @Test
    fun aTapOutsideEndsTheEditAndATapInsideDoesNot() {
        setUp()
        tap(field)
        type(field, "x")
        tap(field)
        assertTrue(captures.isEmpty())
        tap(pay)
        assertEquals(1, captures.size)
    }

    @Test
    fun aFieldWithNoDescriptionIsNamedByItsHint() {
        setUp()
        tap(other)
        type(other, "Dana")
        tap(field)
        assertEquals("Name", captures.single().target.label)
    }
}
