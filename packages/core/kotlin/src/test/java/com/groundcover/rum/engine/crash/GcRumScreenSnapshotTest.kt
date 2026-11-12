package com.groundcover.rum.engine.crash

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The screen lifter is shared by the in-process mapper and the exit-info harvester
 * precisely so the two cannot disagree; these pin the behavior both depend on.
 */
class GcRumScreenSnapshotTest {

    @Test
    fun `lifts name and key out of the snapshot's screen`() {
        val screen = GcRumScreenSnapshot.screenFrom(
            """{"session_id":"s-1","screen":{"name":"Checkout","key":"Checkout-1"}}"""
        )

        assertEquals("Checkout", screen.getString("name"))
        assertEquals("Checkout-1", screen.getString("key"))
    }

    @Test
    fun `is empty when there is no snapshot`() {
        val screen = GcRumScreenSnapshot.screenFrom(null)

        assertEquals("", screen.getString("name"))
        assertEquals("", screen.getString("key"))
    }

    @Test
    fun `is empty, not thrown, on a corrupt snapshot`() {
        val screen = GcRumScreenSnapshot.screenFrom("{not json")

        assertEquals("", screen.getString("name"))
        assertEquals("", screen.getString("key"))
    }

    @Test
    fun `is empty when the snapshot carries no screen`() {
        val screen = GcRumScreenSnapshot.screenFrom("""{"session_id":"s-1"}""")

        assertEquals("", screen.getString("name"))
        assertEquals("", screen.getString("key"))
    }

    @Test
    fun `defaults missing name or key to empty rather than omitting them`() {
        val screen = GcRumScreenSnapshot.screenFrom("""{"screen":{"name":"Home"}}""")

        assertEquals("Home", screen.getString("name"))
        // Absent key is present-and-empty, so the record's shape never varies.
        assertEquals("", screen.getString("key"))
    }

    @Test
    fun `reads only real strings, never coercing a numeric name to its digits`() {
        // optString would turn a number or object into its textual form; a screen name that
        // was 5 on a corrupt snapshot must read as absent, not as "5" on the wire.
        val screen = GcRumScreenSnapshot.screenFrom(
            """{"screen":{"name":5,"key":{"nested":true}}}"""
        )

        assertEquals("", screen.getString("name"))
        assertEquals("", screen.getString("key"))
    }

    @Test
    fun `the in-process mapper and the exit-info harvester agree, byte for byte`() {
        // The whole reason this is one function: a crash our handler saw and the same
        // session's death replayed from ApplicationExitInfo must land on the same screen.
        // Both routes read the screen through here, so they cannot drift.
        val snapshot = """{"session_id":"s-1","screen":{"name":"Cart","key":"Cart-9"}}"""

        val fromMapper = GcRumCrashRecordMapper
            .buildRecord(
                id = "c-1",
                crashEpochMs = 1_700_000_000_000,
                throwable = RuntimeException("boom"),
                threadName = "main",
                sessionSnapshotJson = snapshot,
            )
            .let { org.json.JSONObject(it).getJSONObject("screen") }

        val shared = GcRumScreenSnapshot.screenFrom(snapshot)

        assertEquals(shared.getString("name"), fromMapper.getString("name"))
        assertEquals(shared.getString("key"), fromMapper.getString("key"))
    }
}
