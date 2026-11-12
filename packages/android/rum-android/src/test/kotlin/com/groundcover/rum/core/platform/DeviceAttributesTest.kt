package com.groundcover.rum.core.platform

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The session envelope's device part, in the React Native SDK's shape, plus `sdk`, which tells
// native sessions from RN and Flutter ones under the shared `source`.
@RunWith(RobolectricTestRunner::class)
class DeviceAttributesTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun theEnvelopeCarriesSourceOsDeviceAppAndSdk() {
        val attributes = DeviceAttributes(app, "my-android-app", null, null).attributes()
        assertEquals("mobile-rum", attributes["source"])
        val os = attributes["os"] as Map<*, *>
        assertEquals("android", os["name"])
        assertFalse((os["version"] as String).isEmpty())
        val device = attributes["device"] as Map<*, *>
        assertFalse((device["model"] as String).isEmpty())
        assertFalse((device["brand"] as String).isEmpty())
        val screen = device["screen"] as Map<*, *>
        assertTrue((screen["width"] as Double) > 0)
        assertTrue((screen["scale"] as Double) > 0)
        assertTrue((screen["fontScale"] as Double) > 0)
        assertEquals("my-android-app", (attributes["app"] as Map<*, *>)["id"])
        val sdk = attributes["sdk"] as Map<*, *>
        assertEquals("groundcover-rum-android", sdk["name"])
        assertEquals(SDK_VERSION, sdk["version"])
    }

    @Test
    fun theConfiguredAppVersionAndBuildWinOverTheBundlesAndBlankOnesAreLeftOut() {
        val configured = DeviceAttributes(
            app,
            "a",
            "9.9",
            " ",
            installed = InstalledVersion("1.2", "34")
        )
        val appPart = configured.attributes()["app"] as Map<*, *>
        assertEquals("9.9", appPart["version"])
        assertEquals("34", appPart["build"])

        val bare = DeviceAttributes(app, "a", null, null, installed = InstalledVersion(null, null))
        val bareApp = bare.attributes()["app"] as Map<*, *>
        assertNull(bareApp["version"])
        assertNull(bareApp["build"])
    }
}
