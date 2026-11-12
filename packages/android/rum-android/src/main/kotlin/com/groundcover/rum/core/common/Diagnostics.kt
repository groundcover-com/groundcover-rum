package com.groundcover.rum.core.common

import com.groundcover.rum.core.platform.logcat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The SDK's own log, under a `[groundcover]` prefix: [log] only when `debug` is on, [warn] whatever
 * the setting, for misconfiguration the developer has to see. Never throws.
 */
internal class RumDiagnostics(private val sink: (String) -> Unit) {
    @Volatile
    var isDebug = false
        private set

    private val emitting = ThreadLocal<Boolean>()

    fun configure(debug: Boolean? = null) {
        if (debug != null) isDebug = debug
    }

    fun log(message: String, detail: Any? = null) {
        if (!isDebug) return
        val suffix = if (detail == null) "" else " $detail"
        emit("[${timestamp()}] [groundcover] $message$suffix")
    }

    fun warn(message: String) {
        emit(message)
    }

    // A line can only arrive from inside the sink through an app that routes what the SDK writes
    // back into the SDK's logger; written, each line would write another, without end.
    private fun emit(line: String) {
        if (emitting.get() == true) return
        emitting.set(true)
        try {
            sink(line)
        } catch (error: Exception) {
            // A failing sink must never reach the host app.
        } finally {
            emitting.remove()
        }
    }

    private fun timestamp(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date())

    companion object {
        /** The one the SDK writes through: diagnostics have no owner to inject them through. */
        val shared = RumDiagnostics(sink = ::logcat)
    }
}

/**
 * Swallows [error] after logging it in debug. Every SDK boundary that must not throw into the host
 * ends here.
 */
internal fun handleError(error: Throwable?) {
    RumDiagnostics.shared.log("[error-handler.handleError] called", error)
}

/** A warning the developer sees even with debug off. */
internal fun safeWarn(message: String) {
    RumDiagnostics.shared.warn(message)
}
