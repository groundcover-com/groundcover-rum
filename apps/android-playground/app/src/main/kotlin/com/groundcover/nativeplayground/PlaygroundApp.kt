package com.groundcover.nativeplayground

import android.app.Application
import com.groundcover.rum.Groundcover
import com.groundcover.rum.okhttp.GroundcoverEventListener
import com.groundcover.rum.okhttp.GroundcoverOkHttpInterceptor
import com.groundcover.rum.timber.GroundcoverTree
import okhttp3.OkHttpClient
import timber.log.Timber

/**
 * Starts the SDK the way the native SDK asks an app to: in `Application.onCreate`, before any
 * screen exists. The preset has to be known first, since it is start-time config.
 */
class PlaygroundApp : Application() {
    override fun onCreate() {
        super.onCreate()
        preset = resolvePreset(readPresetFile(filesDir))
        Groundcover.start(this, configFor(preset))
        // The Logs tab's "platform log" goes through Timber, which the SDK captures through its
        // tree; the debug tree prints it to logcat too, as debugPrint does in Flutter.
        Timber.plant(GroundcoverTree(), Timber.DebugTree())
    }

    companion object {
        /** The preset this process booted with, for the Config screen's readback. */
        var preset: String = "default"
            private set

        /**
         * The app's one HTTP client, instrumented the way the SDK asks an app to. Every Network
         * tab request goes through it, or through a client derived from it.
         */
        val http: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .addInterceptor(GroundcoverOkHttpInterceptor())
                .eventListenerFactory(GroundcoverEventListener.Factory())
                .build()
        }
    }
}

/** The app's own error type: what the e2e suite expects as `error_type`. */
class PlaygroundError(message: String) : Exception(message)
