package com.groundcover.rum.core.common

/** A storage backend in memory, which can be told to fail as a real one does. */
internal class MapStorage : PlatformStorage {
    val values = mutableMapOf<String, String>()
    var throwing = false

    private fun check() {
        if (throwing) throw IllegalStateException("storage unavailable")
    }

    override fun getItem(key: String): String? {
        check()
        return values[key]
    }

    override fun setItem(key: String, value: String) {
        check()
        values[key] = value
    }

    override fun removeItem(key: String) {
        check()
        values.remove(key)
    }
}
