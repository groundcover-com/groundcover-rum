package com.groundcover.rum

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The session hooks write the persisted state the SDK reads at start, in its format: milliseconds
// for the last activity, nanoseconds for the start, both decimal strings.
@RunWith(RobolectricTestRunner::class)
class TestingHooksTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val prefs = app.getSharedPreferences("groundcover_rum", Context.MODE_PRIVATE)

    @Before
    fun clear() {
        prefs.edit().clear().commit()
    }

    @Test
    fun backdatingActivityWritesItInMilliseconds() {
        val expected = System.currentTimeMillis() - 31 * 60_000L
        GroundcoverRumTesting.backdateLastActivity(app, 31 * 60_000L)

        val stored = prefs.getString("gcLastActivity", null)
        assertNotNull(stored)
        assertTrue(abs(stored!!.toLong() - expected) < 5_000)
    }

    @Test
    fun backdatingTheStartWritesItInNanoseconds() {
        val expected = (System.currentTimeMillis() - 5 * 3_600_000L) * 1_000_000
        GroundcoverRumTesting.backdateSessionStart(app, 5 * 3_600_000L)

        val stored = prefs.getString("gcStartTime", null)
        assertNotNull(stored)
        assertTrue(abs(stored!!.toLong() - expected) < 5_000_000_000L)
        assertEquals(19, stored.length)
    }

    @Test
    fun forgettingTheSessionRemovesEveryKey() {
        val keys = listOf("gcId", "gcStartTime", "gcLastActivity", "gcSample")
        val editor = prefs.edit()
        keys.forEach { editor.putString(it, "x") }
        editor.commit()

        GroundcoverRumTesting.forgetSession(app)

        keys.forEach { assertFalse(prefs.contains(it)) }
    }
}
