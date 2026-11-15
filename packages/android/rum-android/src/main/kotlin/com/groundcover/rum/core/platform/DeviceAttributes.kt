package com.groundcover.rum.core.platform

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

internal const val SDK_NAME = "groundcover-rum-android"

/** The SDK's version, as sessions report it. The release sets it. */
internal const val SDK_VERSION = "0.0.1-rc.2"

/** The app's version and build, as its package declares them. */
internal class InstalledVersion(val version: String?, val build: String?)

/** What the app's package declares, or nothing when the package manager won't say. */
internal fun readInstalledVersion(context: Context): InstalledVersion = try {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val build = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode.toString()
    } else {
        @Suppress("DEPRECATION")
        info.versionCode.toString()
    }
    InstalledVersion(info.versionName, build)
} catch (error: PackageManager.NameNotFoundException) {
    InstalledVersion(null, null)
}

/**
 * The session envelope's device part, in the React Native and Flutter SDKs' Android shape
 * (`source`, `os`, `device` with `codename`, `app`), plus `sdk`, which tells native sessions from
 * RN and Flutter ones under the shared `source`. Read per batch on the core thread; the screen is
 * read each time, since rotation changes it.
 */
internal class DeviceAttributes(
    context: Context,
    private val appId: String,
    appVersion: String?,
    appBuild: String?,
    installed: InstalledVersion = readInstalledVersion(context)
) {
    private val resources = context.applicationContext?.resources ?: context.resources

    // A blank app version or build is left out, as RN omits it.
    private val version = nonBlank(appVersion) ?: nonBlank(installed.version)
    private val build = nonBlank(appBuild) ?: nonBlank(installed.build)

    fun attributes(): Map<String, Any?> {
        val metrics = resources.displayMetrics
        val density = metrics.density.toDouble().takeIf { it > 0 } ?: 1.0
        val device = linkedMapOf<String, Any?>(
            "model" to (Build.MODEL ?: "unknown"),
            "brand" to (Build.BRAND ?: "unknown"),
            // In dp, as the other SDKs report the logical screen.
            "screen" to mapOf(
                "width" to metrics.widthPixels / density,
                "height" to metrics.heightPixels / density,
                "scale" to density,
                "fontScale" to resources.configuration.fontScale.toDouble()
            )
        )
        Build.DEVICE?.takeIf { it.isNotBlank() }?.let { device["codename"] = it }
        val app = linkedMapOf<String, Any?>()
        version?.let { app["version"] = it }
        build?.let { app["build"] = it }
        if (appId.isNotEmpty()) app["id"] = appId
        return linkedMapOf(
            "source" to "mobile-rum",
            // The API level, as the RN and Flutter SDKs report on Android.
            "os" to mapOf("name" to "android", "version" to Build.VERSION.SDK_INT.toString()),
            "device" to device,
            "app" to app,
            "sdk" to mapOf("name" to SDK_NAME, "version" to SDK_VERSION)
        )
    }
}

private fun nonBlank(value: String?): String? = value?.takeIf { it.isNotBlank() }
