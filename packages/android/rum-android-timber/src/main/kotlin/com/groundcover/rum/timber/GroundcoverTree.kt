package com.groundcover.rum.timber

import android.util.Log
import com.groundcover.rum.Groundcover
import timber.log.Timber

/**
 * A Timber tree that sends each message as a log event, with its tag and throwable among the
 * event's attributes:
 *
 * ```kotlin
 * Timber.plant(GroundcoverTree())
 * ```
 *
 * Messages below [minPriority] (`Log.INFO` by default) are not sent, and neither is one that
 * contains `groundcoverIgnore`.
 */
class GroundcoverTree
@JvmOverloads
constructor(val minPriority: Int = Log.INFO) :
    Timber.Tree() {
    override fun isLoggable(tag: String?, priority: Int): Boolean = priority >= minPriority

    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        // The app's own opt-out, as the other SDKs honour it.
        if (message.contains("groundcoverIgnore")) return
        val attributes = buildMap<String, Any?> {
            if (tag != null) put("tag", tag)
            if (t != null) put("throwable", t.toString())
        }
        val logger = Groundcover.logger
        when (priority) {
            Log.VERBOSE -> logger.trace(message, attributes)
            Log.DEBUG -> logger.debug(message, attributes)
            Log.INFO -> logger.info(message, attributes)
            Log.WARN -> logger.warn(message, attributes)
            else -> logger.error(message, attributes)
        }
    }
}
