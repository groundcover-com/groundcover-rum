package com.groundcover.rum

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowApplication

// Application.onCreate, and so start, runs in every process of an app: the SDK runs in the main
// one only, since its session state and crash snapshot are one per app, not per process.
@RunWith(RobolectricTestRunner::class)
class MainProcessTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val config = GroundcoverConfig("key", "localhost:9393", "c", "dev", "app")

    @After
    fun stopTheSdk() {
        GroundcoverRumTesting.reset()
        ShadowApplication.setProcessName(app.applicationInfo.processName)
    }

    @Test
    fun aSecondaryProcessDoesNotStartTheSdk() {
        ShadowApplication.setProcessName("${app.applicationInfo.processName}:push")

        Groundcover.start(app, config)

        assertFalse(Groundcover.runtime.isStarted)
    }

    @Test
    fun theMainProcessStartsTheSdk() {
        ShadowApplication.setProcessName(app.applicationInfo.processName)

        Groundcover.start(app, config)

        assertTrue(Groundcover.runtime.isStarted)
    }
}
