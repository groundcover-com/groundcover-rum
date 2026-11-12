package com.groundcover.nativeplayground

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The shared Mobilewright suite (tests/e2e/mobile) finds controls by these strings, the way the
// device's accessibility tree reports them, so a rename here breaks e2e on a device. This pins
// the contract without one, as apps/flutter-playground/test/locator_contract_test.dart does for
// Flutter. Each list is what the specs locate on that screen; add to it whenever a spec starts
// locating something new.
//
// The matchers apply Mobilewright's rules (its query-engine) to the merged Compose semantics tree,
// the one TalkBack and the device's accessibility tree see (clearAndSetSemantics hides a node's
// children there, and only there):
//   - text:  getByText, an exact match on a node's text, or on its content description when it
//            has no text. So a button whose label replaces its text must carry no text at all,
//            which is what this checks for the label-replacing ones.
//   - label: getByLabel, an exact match on the content description.
//   - id:    getByTestId, the test tag (a resource id on the device, testTagsAsResourceId).

/** Strings the specs locate on each tab's screen, by the locator they use. */
private val byTab =
    linkedMapOf(
        "Taps" to
            listOf(
                text("Taps"),
                text("Increment counter"),
                label("Increment counter"),
                text("Bare button (no testID/label)"),
                label("Private action"),
                text("Go to Detail screen"),
                text("A11y annotated button"),
                id("home-text-input"),
                label("Search field"),
            ),
        "Network" to
            listOf(
                text("Network"),
                text("fetch GET"),
                text("fetch POST"),
                text("abort in-flight"),
                text("large response"),
                text("failing request"),
                text("sensitive request"),
                text("OkHttp enqueue GET"),
                text("OkHttp execute GET"),
                text("OkHttp derived client GET"),
            ),
        "Logs" to
            listOf(
                text("Logs"),
                text("platform log"),
                text("logger.info"),
                text("logger.warn"),
                text("captureException"),
                text("throw uncaught"),
                text("log sensitive"),
                text("capture sensitive error"),
            ),
        "Custom" to listOf(text("sendCustomEvent"), text("identifyUser"), text("show session id")),
        "Native" to
            listOf(
                text("Crash natively"),
                label("Crash natively"),
                label("Block main thread"),
                label("Open modal"),
                label("Open checkout"),
                text("Row 3"),
                label("Scrollable list"),
                id("native-scroll-list"),
            ),
        "Config" to
            listOf(
                text("preset: default"),
                text("Session: —"),
                text("Last action: —"),
                text("tap DROPME (beforeSend drops this)"),
                text("tap survivor (beforeSend keeps this)"),
                text("show session id"),
                text("setSessionId fixed"),
                text("clear identity"),
                text("manual navigation"),
                text("manual navigation unnamed"),
                text("markAppInteractive"),
                text("stopNavigationTracking"),
                text("backdate activity 31m"),
                text("backdate session start 5h"),
                text("forget session"),
            ),
    )

/** What the specs find inside the modal the Native tab opens. */
private val inModal =
    listOf(
        text("Modal list"),
        text("Modal row 1"),
        label("Close modal"),
        label("Modal scrollable list"),
        id("modal-scroll-list"),
    )

/** What the specs find on Detail, a View-based Fragment: TextView text, as getByText reads it. */
private val onDetail = listOf("Detail", "Back")

private fun SemanticsNode.text(): String? =
    config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }?.ifEmpty { null }
        ?: config.getOrNull(SemanticsProperties.EditableText)?.text?.ifEmpty { null }

private fun SemanticsNode.label(): String? =
    config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(",")?.ifEmpty { null }

private fun text(value: String) =
    SemanticsMatcher("getByText(\"$value\")") { (it.text() ?: it.label()) == value }

private fun label(value: String) = SemanticsMatcher("getByLabel(\"$value\")") { it.label() == value }

private fun id(value: String) = hasTestTag(value)

@RunWith(RobolectricTestRunner::class)
// A Pixel 6's screen, the emulators' profile.
@Config(qualifiers = "w411dp-h914dp-xxhdpi")
class LocatorContractTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private fun expectOne(matcher: SemanticsMatcher) {
        compose.onAllNodes(matcher).assertCountEquals(1)
    }

    private fun openTab(tab: String) {
        compose.onNode(label("$tab tab")).performClick()
        compose.waitForIdle()
    }

    @Test
    fun everyTabHasTheStringsTheSpecsLocate() {
        for ((tab, locators) in byTab) {
            openTab(tab)
            locators.forEach(::expectOne)
        }
    }

    @Test
    fun everyTabIsOneNodeByItsLabel() {
        for (tab in byTab.keys) expectOne(label("$tab tab"))
    }

    @Test
    fun detailIsAFragmentWithTheStringsTheSpecsLocate() {
        compose.onNode(text("Go to Detail screen")).performClick()
        compose.waitForIdle()
        for (value in onDetail) assertNotNull("Detail: \"$value\"", findTextView(value))

        findTextView("Back")!!.performClick()
        compose.waitForIdle()
        expectOne(text("Taps"))
    }

    @Test
    fun theModalHasTheStringsTheSpecsLocate() {
        openTab("Native")
        compose.onNode(label("Open modal")).performClick()
        compose.waitForIdle()
        inModal.forEach(::expectOne)

        compose.onNode(label("Close modal")).performClick()
        compose.waitForIdle()
        compose.onAllNodes(text("Modal list")).assertCountEquals(0)
    }

    @Test
    fun theCheckoutFlowHasTheStringsTheSpecsLocate() {
        openTab("Native")
        compose.onNode(label("Open checkout")).performClick()
        compose.waitForIdle()
        expectOne(text("Cart"))
        expectOne(label("Close checkout"))

        compose.onNode(label("Close checkout")).performClick()
        compose.waitForIdle()
        compose.onAllNodes(text("Cart")).assertCountEquals(0)
    }

    private fun findTextView(value: String): View? {
        fun walk(view: View): View? {
            if (view is TextView && view.isShown && view.text.toString() == value) return view
            if (view is ViewGroup) {
                for (i in 0 until view.childCount) walk(view.getChildAt(i))?.let { return it }
            }
            return null
        }
        return walk(compose.activity.window.decorView)
    }
}
