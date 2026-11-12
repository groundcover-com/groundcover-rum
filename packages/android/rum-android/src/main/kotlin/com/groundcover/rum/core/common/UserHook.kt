package com.groundcover.rum.core.common

/**
 * The app's own callbacks, run inside the SDK: beforeSend, enrichEvent and the redact hook. What
 * one sends through the SDK's API while it runs is a side effect of the SDK sending something, so
 * the API drops it: sent, it would go through the same hook again.
 */
internal object UserHook {
    private val depth = ThreadLocal<IntArray>()

    /** Whether one of the app's hooks is running on this thread. */
    val isRunning: Boolean get() = (depth.get()?.get(0) ?: 0) > 0

    fun <T> run(hook: () -> T): T {
        val counter = depth.get() ?: IntArray(1).also { depth.set(it) }
        counter[0]++
        try {
            return hook()
        } finally {
            counter[0]--
        }
    }
}
