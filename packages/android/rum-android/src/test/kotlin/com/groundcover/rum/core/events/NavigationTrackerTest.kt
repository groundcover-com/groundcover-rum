package com.groundcover.rum.core.events

import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.privacy.resolvePrivacy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

// The navigation tracker on its own, mirroring the Dart tracker's tests.

class NavigationTrackerTest {
    private val privacy = resolvePrivacy(null)

    @Test
    fun aScreenChangeReportsTheScreenLeftAndHowLongItShowed() {
        val tracker = NavigationTracker()
        val first = tracker.handle(ScreenCapture("Home", "Home-1"), 1000, privacy)!!
        assertEquals(0L, first.attributes["duration_ms"])
        assertFalse(first.attributes.containsKey("from_screen"))
        val second = tracker.handle(ScreenCapture("Detail", "Detail-2"), 1400, privacy)!!
        assertEquals("Home", second.attributes["from_screen"])
        assertEquals("Home-1", second.attributes["from_key"])
        assertEquals(400L, second.attributes["duration_ms"])
        assertEquals(msToNs(1000), second.attributes["start_timestamp"])
        assertEquals(msToNs(1400), second.attributes["end_timestamp"])
        assertEquals("Detail" to "Detail-2", tracker.screenName to tracker.screenKey)
    }

    @Test
    fun theSameScreenAgainOrABlankOneReportsNothing() {
        val tracker = NavigationTracker()
        tracker.handle(ScreenCapture("Home", "Home-1"), 1000, privacy)
        assertNull(tracker.handle(ScreenCapture("Home", "Home-1"), 1200, privacy))
        assertNull(tracker.handle(ScreenCapture("", "x"), 1300, privacy))
    }

    @Test
    fun aManualNavigationStampsItsScreenAtOnceAndReportsAtItsEnd() {
        val tracker = NavigationTracker()
        assertNull(
            tracker.handle(NavigationStartCapture("Manual", "m-1", mapOf("a" to 1)), 100, privacy)
        )
        assertEquals("Manual" to "m-1", tracker.screenName to tracker.screenKey)
        val end = tracker.handle(NavigationEndCapture(mapOf("b" to 2)), 350, privacy)!!
        assertEquals(250L, end.attributes["duration_ms"])
        assertEquals(mapOf("a" to 1, "b" to 2), end.attributes["metadata"])
    }

    @Test
    fun aBlankManualKeyIsNoKeyAsRNReadsIt() {
        val tracker = NavigationTracker()
        tracker.handle(NavigationStartCapture("Checkout", "  "), 100, privacy)
        assertEquals("", tracker.screenKey)
    }

    @Test
    fun aManualNavigationWithABlankScreenOrNoStartReportsNothing() {
        val tracker = NavigationTracker()
        tracker.handle(NavigationStartCapture("  "), 100, privacy)
        assertNull(tracker.handle(NavigationEndCapture(), 200, privacy))
        assertNull(tracker.handle(NavigationEndCapture(), 300, privacy))
        assertEquals("", tracker.screenName)
    }
}
