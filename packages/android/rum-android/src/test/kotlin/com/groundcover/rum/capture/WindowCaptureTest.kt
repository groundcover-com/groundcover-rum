package com.groundcover.rum.capture

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.os.Looper
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.Button
import android.widget.CheckBox
import android.widget.Checkable
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.ui.node.RootForTest
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.core.events.InteractionCapture
import com.groundcover.rum.core.events.InteractionKind
import com.groundcover.rum.groundcoverPrivate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// The window glue and target resolution, on Robolectric's views: wrapping and unwrapping a
// window's callback chain, a tap through it, and the target a tap names.

/** A view the capture takes for a Compose root, through the stand-in [RootForTest]. */
class ComposeRootLike(context: Context) :
    FrameLayout(context),
    RootForTest

/**
 * MaterialButton's and MaterialCardView's shape: Checkable by type, while TalkBack hears it as
 * checkable only when the app makes it so.
 */
class TypeCheckableButton(context: Context) :
    Button(context),
    Checkable {
    private var checked = false

    override fun isChecked(): Boolean = checked

    override fun setChecked(checked: Boolean) {
        this.checked = checked
    }

    override fun toggle() {
        checked = !checked
    }
}

/** PhoneWindow and its inner DecorView, as API 23 has them. */
class WindowLike {
    inner class DecorLike
}

/** A launch-time dialog: shown from onResume, before the Activity's window has focus. */
class DialogOnResumeActivity : Activity() {
    var dialog: Dialog? = null

    override fun onResume() {
        super.onResume()
        if (dialog == null) {
            dialog = Dialog(this).apply {
                setContentView(TextView(this@DialogOnResumeActivity).apply { text = "Update" })
                show()
            }
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WindowCaptureTest {
    private fun anActivity(content: (Activity) -> View): Activity {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.setContentView(content(activity))
        shadowOf(Looper.getMainLooper()).idle()
        return activity
    }

    private class Recorder {
        var presences = 0
        val interactions = mutableListOf<InteractionCapture>()
        val observer = TouchObserver(
            onPresence = { presences++ },
            onInteraction = { interactions.add(it) },
            onFocusLost = {}
        )
    }

    @Test
    fun aTapThroughAWrappedWindowIsPresenceThenANamedInteractionAndTheAppStillGetsIt() {
        var clicks = 0
        lateinit var button: Button
        val activity = anActivity {
            LinearLayout(it).apply {
                button = Button(it).apply {
                    text = "Pay now"
                    setOnClickListener { clicks++ }
                }
                addView(button, ViewGroup.LayoutParams(400, 120))
            }
        }
        val recorder = Recorder()
        val tracker = WindowTracker(activity.application, recorder.observer) {}
        tracker.wrap(activity.window)
        tap(activity.window, button)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, recorder.presences)
        val capture = recorder.interactions.single()
        assertEquals(InteractionKind.TAP, capture.kind)
        assertEquals("Pay now", capture.target.label)
        assertEquals("button", capture.target.role)
        assertEquals("Button", capture.target.component)
        assertTrue(capture.target.componentPath.endsWith("LinearLayout > Button"))
        assertEquals(1, clicks)
    }

    @Test
    fun aWindowIsWrappedOnceAndUnwrappedOnlyWhereOursIsOutermost() {
        val activity = anActivity { FrameLayout(it) }
        val original = activity.window.callback
        val tracker = WindowTracker(activity.application, Recorder().observer) {}
        tracker.wrap(activity.window)
        val ours = activity.window.callback
        assertTrue(ours is GroundcoverWindowCallback)
        // Another SDK wraps after us; we must neither wrap again nor unwrap it.
        val theirs = object : Window.Callback by ours {}
        activity.window.callback = theirs
        tracker.wrap(activity.window)
        assertSame(theirs, activity.window.callback)
        tracker.stop()
        assertSame(theirs, activity.window.callback)

        val alone = anActivity { FrameLayout(it) }
        val aloneOriginal = alone.window.callback
        val second = WindowTracker(alone.application, Recorder().observer) {}
        second.wrap(alone.window)
        second.stop()
        assertSame(aloneOriginal, alone.window.callback)
        assertFalse(original is GroundcoverWindowCallback)
    }

    @Test
    fun theWindowCallbacksDefaultMethodsReachTheAppsCallback() {
        val activity = anActivity { FrameLayout(it) }
        var captureChanged: Boolean? = null
        var shortcutsAsked = false
        val original = activity.window.callback
        activity.window.callback = object : Window.Callback by original {
            override fun onPointerCaptureChanged(hasCapture: Boolean) {
                captureChanged = hasCapture
            }

            override fun onProvideKeyboardShortcuts(
                data: MutableList<KeyboardShortcutGroup>?,
                menu: Menu?,
                deviceId: Int
            ) {
                shortcutsAsked = true
            }
        }
        WindowTracker(activity.application, Recorder().observer) {}.wrap(activity.window)
        assertTrue(activity.window.callback is GroundcoverWindowCallback)
        activity.window.callback.onPointerCaptureChanged(true)
        activity.window.callback.onProvideKeyboardShortcuts(mutableListOf(), null, 0)
        assertEquals(true, captureChanged)
        assertTrue(shortcutsAsked)
    }

    @Test
    fun aDialogsWindowIsFoundAmongTheRootViews() {
        val activity = anActivity { FrameLayout(it) }
        val dialog = Dialog(activity).apply {
            setContentView(TextView(activity).apply { text = "Close modal" })
            show()
        }
        shadowOf(Looper.getMainLooper()).idle()
        val windows = RootWindows.list() ?: emptyList()
        assertTrue(windows.any { it === dialog.window })
        val tracker = WindowTracker(activity.application, Recorder().observer) {}
        tracker.scanRootWindows()
        assertTrue(dialog.window!!.callback is GroundcoverWindowCallback)
        tracker.stop()
        assertFalse(dialog.window!!.callback is GroundcoverWindowCallback)
    }

    @Test
    fun aDialogShownAsTheActivityResumesIsWrapped() {
        val tracker = WindowTracker(
            ApplicationProvider.getApplicationContext(),
            Recorder().observer
        ) {}
        tracker.start(null)
        val activity = Robolectric.buildActivity(DialogOnResumeActivity::class.java).setup().get()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(activity.dialog!!.window!!.callback is GroundcoverWindowCallback)
        tracker.stop()
    }

    @Test
    fun anInnerDecorViewsWindowIsItsOuterInstance() {
        // API 23's shape: DecorView is an inner class of PhoneWindow, with no mWindow field.
        val window = WindowLike()
        val field = RootWindows.windowFieldOf(WindowLike.DecorLike::class.java)
        assertSame(window, field?.get(window.DecorLike()))
    }

    @Test
    fun theContentDescriptionWinsOverTheTextAsTheBrowserDoes() {
        lateinit var button: Button
        anActivity {
            LinearLayout(it).apply {
                button = Button(it).apply {
                    text = "Well-tagged button (tapped 3)"
                    contentDescription = "Increment counter"
                }
                addView(button, ViewGroup.LayoutParams(400, 120))
            }
        }
        val (x, y) = centre(button)
        val target = TargetResolver.resolve(button.rootView, x, y)
        assertEquals("Increment counter", target.label)
    }

    @Test
    fun aClickableRowIsNamedByTheTextInsideItAndAPrivateAncestorMasks() {
        lateinit var row: LinearLayout
        lateinit var card: FrameLayout
        anActivity {
            FrameLayout(it).apply {
                card = this
                row = LinearLayout(it).apply {
                    isClickable = true
                    addView(TextView(it).apply { text = "Row 3" }, ViewGroup.LayoutParams(300, 80))
                }
                addView(row, ViewGroup.LayoutParams(400, 120))
            }
        }
        val (x, y) = centre(row)
        val plain = TargetResolver.resolve(row.rootView, x, y)
        assertEquals("Row 3", plain.label)
        assertEquals("LinearLayout", plain.component)
        assertFalse(plain.masked)
        card.groundcoverPrivate = true
        assertTrue(TargetResolver.resolve(row.rootView, x, y).masked)
    }

    @Test
    fun aTapOnAPrivateViewInsideAClickableRowIsMasked() {
        lateinit var row: LinearLayout
        lateinit var number: TextView
        anActivity {
            FrameLayout(it).apply {
                row = LinearLayout(it).apply {
                    isClickable = true
                    number = TextView(it).apply {
                        text = "4242 4242 4242 4242"
                        groundcoverPrivate = true
                    }
                    addView(number, ViewGroup.LayoutParams(300, 80))
                }
                addView(row, ViewGroup.LayoutParams(400, 120))
            }
        }
        val (x, y) = centre(number)
        val target = TargetResolver.resolve(row.rootView, x, y)
        assertEquals("LinearLayout", target.component)
        assertTrue(target.masked)
    }

    @Test
    fun aRowNamedByAPrivateViewsTextIsMasked() {
        lateinit var row: LinearLayout
        lateinit var title: TextView
        anActivity {
            FrameLayout(it).apply {
                row = LinearLayout(it).apply {
                    isClickable = true
                    title = TextView(it).apply { text = "Balance" }
                    addView(title, ViewGroup.LayoutParams(150, 80))
                    addView(
                        TextView(it).apply {
                            text = "$12,345"
                            groundcoverPrivate = true
                        },
                        ViewGroup.LayoutParams(150, 80)
                    )
                }
                addView(row, ViewGroup.LayoutParams(400, 120))
            }
        }
        val (x, y) = centre(title)
        assertTrue(TargetResolver.resolve(row.rootView, x, y).masked)
    }

    @Test
    fun aTapOutsideADialogIsNotNamedByItsText() {
        val activity = anActivity { FrameLayout(it) }
        val dialog = Dialog(activity).apply {
            setContentView(TextView(activity).apply { text = "Account 9876" })
            show()
        }
        shadowOf(Looper.getMainLooper()).idle()
        val decor = dialog.window!!.decorView
        val location = IntArray(2)
        decor.getLocationOnScreen(location)
        // Delivered to the dialog's window, outside its views, as a tap that dismisses it is.
        val outside = TargetResolver.resolve(
            decor,
            location[0] + decor.width + 100f,
            location[1] + decor.height + 100f
        )
        assertEquals("", outside.label)
    }

    @Test
    fun aButtonThatIsCheckableOnlyInTypeHasNoCheckedState() {
        lateinit var button: TypeCheckableButton
        anActivity {
            LinearLayout(it).apply {
                button = TypeCheckableButton(it).apply { text = "Pay now" }
                addView(button, ViewGroup.LayoutParams(400, 120))
            }
        }
        val (x, y) = centre(button)
        assertNull(TargetResolver.resolve(button.rootView, x, y).state?.get("checked"))
    }

    @Test
    fun aCheckedBoxIsStateAndATextFieldsTextIsNeverTheLabel() {
        lateinit var box: CheckBox
        lateinit var field: EditText
        anActivity {
            LinearLayout(it).apply {
                orientation = LinearLayout.VERTICAL
                box = CheckBox(it).apply {
                    text = "Remember me"
                    isChecked = true
                }
                field = EditText(it).apply { setText("hunter2@example.com") }
                addView(box, ViewGroup.LayoutParams(400, 120))
                addView(field, ViewGroup.LayoutParams(400, 120))
            }
        }
        val (bx, by) = centre(box)
        val boxTarget = TargetResolver.resolve(box.rootView, bx, by)
        assertEquals("checkbox", boxTarget.role)
        assertEquals(true, boxTarget.state?.get("checked"))
        val (fx, fy) = centre(field)
        val fieldTarget = TargetResolver.resolve(field.rootView, fx, fy)
        assertEquals("textfield", fieldTarget.role)
        assertEquals("", fieldTarget.label)
        assertNull(fieldTarget.valueText)
    }

    @Test
    fun composesInteropHolderIsPassedThroughUnlessAViewInItIsUnderTheFinger() {
        lateinit var composeLike: ComposeRootLike
        lateinit var interop: Button
        anActivity {
            ComposeRootLike(it).apply {
                composeLike = this
                contentDescription = "Compose content"
                // Any class: a minified app renames Compose's own.
                val holder = FrameLayout(it)
                interop = Button(it).apply { text = "Back" }
                holder.addView(interop, FrameLayout.LayoutParams(300, 120))
                addView(holder, ViewGroup.LayoutParams(800, 800))
            }
        }
        val (bx, by) = centre(interop)
        assertEquals("Back", TargetResolver.resolve(composeLike.rootView, bx, by).label)
        val location = IntArray(2)
        composeLike.getLocationOnScreen(location)
        // Inside the content, below the interop button.
        val elsewhere = TargetResolver.resolve(
            composeLike.rootView,
            location[0] + 100f,
            location[1] + 300f
        )
        assertEquals("ComposeRootLike", elsewhere.component)
        assertEquals("Compose content", elsewhere.label)
    }

    @Test
    fun thePathKeepsTheInnermostTenNames() {
        lateinit var leaf: View
        anActivity {
            var parent = FrameLayout(it)
            val top = parent
            repeat(15) { _ ->
                val child = FrameLayout(it)
                parent.addView(child)
                parent = child
            }
            leaf = parent
            top
        }
        val path = TargetResolver.componentPath(leaf)
        assertEquals(10, path.split(" > ").size)
        assertTrue(path.length <= 200)
    }
}
