package com.groundcover.rum.core.common

/**
 * The storage a host provides. Synchronous: session state is read while the pipeline is built and
 * on hot paths.
 */
internal interface PlatformStorage {
    fun getItem(key: String): String?

    fun setItem(key: String, value: String)

    fun removeItem(key: String)
}

/**
 * A [PlatformStorage] that never throws. Storage fails in normal operation (a full disk, a broken
 * backend): reads degrade to null or a fallback, and writes are dropped, never surfaced to the
 * host app.
 */
internal class SafeStorage(private val storage: PlatformStorage?) {
    fun getItem(key: String): String? = try {
        storage?.getItem(key)
    } catch (error: Exception) {
        handleError(error)
        null
    }

    fun setItem(key: String, value: String) {
        try {
            storage?.setItem(key, value)
        } catch (error: Exception) {
            handleError(error)
        }
    }

    fun removeItem(key: String) {
        try {
            storage?.removeItem(key)
        } catch (error: Exception) {
            handleError(error)
        }
    }

    /**
     * The stored value as a whole number, exact for nanoseconds, or [fallback] when it is missing
     * or not a finite number. A fraction is dropped.
     */
    fun getIntegerItem(key: String, fallback: Long = 0): Long {
        val raw = getItem(key)?.trim() ?: return fallback
        raw.toLongOrNull()?.let { return it }
        val number = raw.toDoubleOrNull() ?: return fallback
        if (!number.isFinite() || number >= Long.MAX_VALUE.toDouble() ||
            number < Long.MIN_VALUE.toDouble()
        ) {
            return fallback
        }
        return number.toLong()
    }
}
