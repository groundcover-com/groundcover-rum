package com.groundcover.rum.core.platform

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.GroundcoverRumTesting
import com.groundcover.rum.core.common.SafeStorage
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The core keeps session state where the testing hooks, and the Flutter SDK, keep it: the
// groundcover_rum preferences, as decimal strings.
@RunWith(RobolectricTestRunner::class)
class SharedPreferencesStorageTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun theSessionStartTheTestingHookWritesReadsBackAsExactNanoseconds() {
        val expected = (System.currentTimeMillis() - 3_600_000L) * 1_000_000
        GroundcoverRumTesting.backdateSessionStart(app, 3_600_000L)

        val ns = SafeStorage(SharedPreferencesStorage(app)).getIntegerItem("gcStartTime")
        assertTrue(abs(ns - expected) < 5_000_000_000L)
        assertEquals(0L, ns % 1_000_000)
    }

    @Test
    fun whatItStoresTheTestingHookForgets() {
        val storage = SharedPreferencesStorage(app)
        storage.setItem("gcId", "abc")
        assertEquals("abc", storage.getItem("gcId"))
        GroundcoverRumTesting.forgetSession(app)
        assertNull(storage.getItem("gcId"))
    }
}
