package com.groundcover.rum.core.platform

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process

/**
 * Whether this is the app's main process: the one its components run in by default, named after
 * the package unless the manifest renames it. `Application.onCreate` runs in every process an app
 * declares (`:push`, `:media`…), and the SDK's session state and crash snapshot are one per app.
 * True when the current process can't be named, so an unknown never turns the SDK off.
 */
internal fun isMainProcess(context: Context): Boolean {
    val main = context.applicationInfo?.processName ?: context.packageName
    val current = currentProcessName(context) ?: return true
    return current == main
}

private fun currentProcessName(context: Context): String? = runCatching {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        Application.getProcessName()
    } else {
        val pid = Process.myPid()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)
            ?.runningAppProcesses
            ?.firstOrNull { it.pid == pid }
            ?.processName
    }
}.getOrNull()?.takeIf { it.isNotEmpty() }
