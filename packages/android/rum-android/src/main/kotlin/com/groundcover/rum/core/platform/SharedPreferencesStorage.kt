package com.groundcover.rum.core.platform

import android.content.Context
import com.groundcover.rum.SessionStorage
import com.groundcover.rum.core.common.PlatformStorage

/**
 * Session state in the preferences file, and as the strings, the Flutter SDK and the testing hooks
 * use. Written with commit(): the core calls it off the main thread, and a crash right after a
 * rotation must not lose the new session.
 */
internal class SharedPreferencesStorage(context: Context) : PlatformStorage {
    private val prefs = SessionStorage.prefs(context)

    override fun getItem(key: String): String? = prefs.getString(key, null)

    override fun setItem(key: String, value: String) {
        prefs.edit().putString(key, value).commit()
    }

    override fun removeItem(key: String) {
        prefs.edit().remove(key).commit()
    }
}
