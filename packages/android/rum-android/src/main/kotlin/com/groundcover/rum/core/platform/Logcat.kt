package com.groundcover.rum.core.platform

import android.util.Log

/** Where the SDK's diagnostics go on a device. */
internal fun logcat(line: String) {
    Log.i("groundcover", line)
}
