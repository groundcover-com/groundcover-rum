package com.groundcover.rum.engine.lifecycle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The accounting behind "is the app in the foreground", which is what decides
 * whether a watchdog should be probing at all.
 *
 * Every case here is a way a naive implementation (a boolean flipped in
 * onActivityStopped) would get it wrong: a rotation, a screen handoff, a stop for
 * an activity that started before the engine did.
 */
class GcRumForegroundMonitorTest {

    private class Recorder {
        val calls = mutableListOf<String>()

        /** A monitor that is counting but not yet reporting — the state between
         *  engine construction and JS arming native capture. */
        fun rawMonitor() = GcRumForegroundMonitor(
            onForeground = { calls.add("foreground") },
            onBackground = { calls.add("background") },
        )

        /**
         * The common case: armed, with nothing on screen yet. Counting and
         * reporting are separate concerns ([GcRumForegroundMonitor.beginCounting]
         * vs [GcRumForegroundMonitor.startObserving]), and most tests here are
         * about the transitions rather than about that split.
         */
        fun monitor() = rawMonitor().apply {
            beginCounting(hasVisibleActivity = false)
            startObserving(hasVisibleActivity = false)
        }
    }

    @Test
    fun `starts out backgrounded and says nothing until an activity starts`() {
        val r = Recorder()
        val monitor = r.monitor()

        assertFalse(monitor.isForeground)
        assertEquals(emptyList<String>(), r.calls)
    }

    @Test
    fun `the first activity start reports foreground exactly once`() {
        val r = Recorder()
        val monitor = r.monitor()

        monitor.activityStarted()
        monitor.activityStarted()

        assertTrue(monitor.isForeground)
        assertEquals(listOf("foreground"), r.calls)
    }

    @Test
    fun `background is reported only when the LAST activity stops`() {
        val r = Recorder()
        val monitor = r.monitor()

        monitor.activityStarted()   // A
        monitor.activityStarted()   // B on top of A
        monitor.activityStopped(isChangingConfigurations = false) // A
        assertEquals(listOf("foreground"), r.calls)
        assertTrue(monitor.isForeground)

        monitor.activityStopped(isChangingConfigurations = false) // B — now empty
        assertEquals(listOf("foreground", "background"), r.calls)
        assertFalse(monitor.isForeground)
    }

    /**
     * A screen-to-screen handoff overlaps: the incoming activity starts before the
     * outgoing one stops. The app never left, so nothing should be reported.
     */
    @Test
    fun `a navigation handoff does not look like a trip to the background`() {
        val r = Recorder()
        val monitor = r.monitor()

        monitor.activityStarted()                                 // first screen
        monitor.activityStarted()                                 // second starts
        monitor.activityStopped(isChangingConfigurations = false)  // first stops

        assertEquals(listOf("foreground"), r.calls)
        assertTrue(monitor.isForeground)
    }

    /**
     * The case that makes the `isChangingConfigurations` parameter earn its keep:
     * a rotation drops the count to zero and immediately restores it. Reporting a
     * background here would pause the watchdog at the moment a config change is
     * most likely to stall the main thread.
     */
    @Test
    fun `a rotation reports neither background nor a second foreground`() {
        val r = Recorder()
        val monitor = r.monitor()

        monitor.activityStarted()
        monitor.activityStopped(isChangingConfigurations = true)
        monitor.activityStarted()

        assertEquals(listOf("foreground"), r.calls)
        assertTrue(monitor.isForeground)
    }

    /** …and the app can still go to the background AFTER a rotation. */
    @Test
    fun `a real departure after a rotation is still reported`() {
        val r = Recorder()
        val monitor = r.monitor()

        monitor.activityStarted()
        monitor.activityStopped(isChangingConfigurations = true)
        monitor.activityStarted()
        monitor.activityStopped(isChangingConfigurations = false)

        assertEquals(listOf("foreground", "background"), r.calls)
        assertFalse(monitor.isForeground)
    }

    /**
     * The engine arms long after the launch activity started, so its first
     * callback can be a STOP for an activity it never saw start. An underflow
     * there would strand the app as permanently backgrounded and silence the
     * watchdog for the rest of the process.
     */
    @Test
    fun `a stop with no matching start neither underflows nor reports`() {
        val r = Recorder()
        val monitor = r.monitor()

        monitor.activityStopped(isChangingConfigurations = false)
        monitor.activityStopped(isChangingConfigurations = false)

        assertEquals(emptyList<String>(), r.calls)
        assertFalse(monitor.isForeground)

        // And the next genuine start still registers, rather than being eaten by a
        // negative count.
        monitor.activityStarted()
        assertEquals(listOf("foreground"), r.calls)
        assertTrue(monitor.isForeground)
    }

    /**
     * One monitor lives for the engine's whole life, but JS can stop and re-arm capture on
     * it — a re-init after login does — and seeding the count on every arming would
     * accumulate seeds with no matching stop. A count stuck one too high means a
     * genuine backgrounding never reaches zero, so neither the ANR watchdog's pause nor the
     * snapshot store's final flush ever fires again.
     */
    @Test
    fun `a stop and restart does not leave the monitor over-counted`() {
        val r = Recorder()
        val monitor = r.rawMonitor()

        // Engine constructed, launch activity already on screen.
        monitor.beginCounting(hasVisibleActivity = true)
        monitor.startObserving(hasVisibleActivity = false)
        assertTrue(monitor.isForeground)

        // JS called destroy(): the engine stops reporting, but the app has not
        // gone anywhere and the activity is still on screen.
        monitor.stopObserving()

        // JS called init() again on the same engine. The count was never lost, so
        // nothing is re-seeded on top of it.
        monitor.startObserving(hasVisibleActivity = false)

        // The user now genuinely leaves. This must still be reported — it is the
        // whole assertion, and with a re-seeding startObserving it would never fire.
        monitor.activityStopped(isChangingConfigurations = false)

        assertTrue("the background edge must survive a restart", "background" in r.calls)
        assertFalse(monitor.isForeground)

        // The second "foreground" is the re-arm telling a freshly built watchdog
        // where it stands, which is the same job the seed does on a cold start.
        // Both consumers are idempotent, so saying it twice costs nothing.
        assertEquals(listOf("foreground", "foreground", "background"), r.calls)
    }

    /**
     * The seed has to be a COUNT, not "is anything on screen". Two started activities is
     * reachable (a dialog-themed activity over the main one, a native screen pushed during
     * startup) and a boolean cannot describe it: seeded with 1, the FIRST stop takes the
     * count to zero and reports a departure the user never made — then leaves it at zero with
     * an activity still started, so the real departure is never reported either.
     */
    @Test
    fun `arming with two activities already started does not report a premature background`() {
        val r = Recorder()
        val monitor = r.rawMonitor()

        // Counting starts when the engine is constructed. The launch activity's
        // onStart already fired — the bridge module did not exist yet — so it is
        // seeded rather than observed.
        monitor.beginCounting(hasVisibleActivity = true)
        // A second activity starts while JS is still booting. This one IS observed.
        monitor.activityStarted()

        // JS arms native capture.
        monitor.startObserving(hasVisibleActivity = false)
        assertEquals(listOf("foreground"), r.calls)

        // The second activity goes away. One is still on screen: the app has not
        // gone anywhere.
        monitor.activityStopped(isChangingConfigurations = false)
        assertEquals(
            "a departure was reported while an activity was still started",
            listOf("foreground"),
            r.calls,
        )
        assertTrue(monitor.isForeground)

        // Now the last one stops — this is the real departure.
        monitor.activityStopped(isChangingConfigurations = false)
        assertEquals(listOf("foreground", "background"), r.calls)
        assertFalse(monitor.isForeground)
    }

    /**
     * The floor under the count, for a host where counting began too late.
     *
     * `beginCounting` runs when the engine is constructed, and on some hosts that
     * is already after the launch activity's onStart — so nothing is counted for an
     * app that is plainly on screen. Reporting nothing there would leave the ANR
     * watchdog paused for the whole first visit and the snapshot store without its
     * before-the-process-dies flush, which is worse than any miscount.
     */
    @Test
    fun `arming with nothing counted but something on screen still reports foreground`() {
        val r = Recorder()
        val monitor = r.rawMonitor()

        monitor.beginCounting(hasVisibleActivity = false) // construction missed it
        monitor.startObserving(hasVisibleActivity = true)  // but it IS on screen

        assertEquals(listOf("foreground"), r.calls)
        assertTrue(monitor.isForeground)

        // And it still leaves when it leaves.
        monitor.activityStopped(isChangingConfigurations = false)
        assertEquals(listOf("foreground", "background"), r.calls)
    }

    /** The floor only ever raises a ZERO. A genuinely observed count of two must
     *  survive, or the first stop would read as the app leaving. */
    @Test
    fun `the visible-activity floor never overwrites a count that was observed`() {
        val r = Recorder()
        val monitor = r.rawMonitor()

        monitor.beginCounting(hasVisibleActivity = true)
        monitor.activityStarted()                          // two on screen
        monitor.startObserving(hasVisibleActivity = true)   // floor must not clamp to 1

        monitor.activityStopped(isChangingConfigurations = false)

        assertEquals(listOf("foreground"), r.calls)
        assertTrue(monitor.isForeground)
    }

    /** A restart while the app really is backgrounded must not claim foreground. */
    @Test
    fun `restarting with nothing on screen stays backgrounded`() {
        val r = Recorder()
        val monitor = r.rawMonitor()

        monitor.beginCounting(hasVisibleActivity = false)
        monitor.startObserving(hasVisibleActivity = false)

        assertEquals(emptyList<String>(), r.calls)
        assertFalse(monitor.isForeground)
    }

    /**
     * Counting is not gated on reporting, which is the whole reason the two are
     * separate calls. An activity that starts between engine construction and JS
     * arming is real and must be in the count — otherwise arming mid-startup
     * undercounts, as a boolean seed would, and a stop reads as a departure.
     */
    @Test
    fun `activities that start before arming are still counted`() {
        val r = Recorder()
        val monitor = r.rawMonitor()

        monitor.beginCounting(hasVisibleActivity = true)
        monitor.activityStarted()   // counted, not reported — nobody is listening

        assertEquals("nothing may be reported before arming", emptyList<String>(), r.calls)

        monitor.startObserving(hasVisibleActivity = false)
        monitor.activityStopped(isChangingConfigurations = false)

        assertEquals(
            "the second activity's start was dropped, so this looked like a departure",
            listOf("foreground"),
            r.calls,
        )
        assertTrue(monitor.isForeground)
    }

    @Test
    fun `returning to the foreground reports again`() {
        val r = Recorder()
        val monitor = r.monitor()

        monitor.activityStarted()
        monitor.activityStopped(isChangingConfigurations = false)
        monitor.activityStarted()

        assertEquals(listOf("foreground", "background", "foreground"), r.calls)
    }
}
