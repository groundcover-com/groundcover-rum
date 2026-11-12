package com.groundcover.rum

import android.content.Context
import com.groundcover.rum.core.pipeline.FakePlatform

/**
 * Runs the real `Groundcover` object on a fake platform whose core work is inline, for Java tests,
 * which can't reach the runtime's internals: a throw on the core thread then shows as an event that
 * never landed.
 */
internal object JavaApiHarness {
    /** Starts the SDK, sends a presence, runs [calls], and returns the events sent meanwhile. */
    @JvmStatic
    fun sentWhileRunning(context: Context, calls: Runnable): List<Map<String, Any?>> {
        val platform = FakePlatform()
        val previous = Groundcover.runtime.replacePlatform { platform.services }
        try {
            Groundcover.start(
                context,
                GroundcoverConfig(
                    "key",
                    "localhost:9393",
                    "c",
                    "dev",
                    "app",
                    options = GroundcoverOptions(
                        transport = TransportOptions(batchSize = 0, compression = false)
                    )
                )
            )
            Groundcover.runtime.dispatch("presence") { it.presence() }
            calls.run()
            return platform.requests.flatMap { it.events }
        } finally {
            GroundcoverRumTesting.reset()
            Groundcover.runtime.replacePlatform(previous)
        }
    }
}
