package com.groundcover.rum.core.nativeengine

import com.groundcover.rum.RumEventName
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.config.ResolvedOptions
import com.groundcover.rum.core.config.resolveHangThresholdMs
import com.groundcover.rum.core.config.resolveVitalsMaxSegmentMs

/**
 * The native engine, as the pipeline drives it: crashes, hangs, app start and frame vitals. Never
 * throws: a native failure degrades to nothing armed, never to an error in the app's launch.
 */
internal interface NativeEngine {
    /**
     * Where the engine's signals go, by kind (`hang`, `app_start`, `frame_segment`, `ping`), on any
     * thread. Set before [start]: the engine emits from inside it.
     */
    var onSignal: ((String, Map<String, Any?>) -> Unit)?

    /**
     * Starts the engine with [configJson] (see [engineConfigJson]), off the caller's thread.
     * [completion] gets what it armed, on any thread.
     */
    fun start(configJson: String, completion: (NativeEngineStatus) -> Unit)

    /**
     * Stops the watchdog and the trackers. The crash handler stays armed: a crash during teardown
     * is still worth reporting.
     */
    fun stop()

    /**
     * Closes the open frame segment, as a screen change does, and hands over its `frame_segment`
     * payload, or null when nothing is open; [completion] runs once, on any thread.
     */
    fun flushFrameSegment(completion: (Map<String, Any?>?) -> Unit)
}

/** What the engine armed. */
internal data class NativeEngineStatus(
    val crashes: Boolean = false,
    val hangs: Boolean = false,
    val appStart: Boolean = false,
    val vitals: Boolean = false,
    /**
     * Why crash capture isn't running when it was asked for: usually another reporter owning the
     * process's crash handling.
     */
    val crashesUnavailable: String? = null
)

/**
 * The engine's config, as JSON.
 *
 * [recording] is whether this session is sampled. Crash capture is armed either way, because it
 * governs delivery as well as capture: the engine harvests the previous run's exit reasons into
 * pending records in its crash block, so an unsampled launch must still run it, or a crash from an
 * earlier sampled session is never delivered. `clearSnapshotAfterHarvest` makes that safe: an
 * unsampled launch clears the previous run's envelope right after the harvest read it, so a crash
 * in this run has no session to be filed under.
 *
 * [snapshotJson] is this session's envelope, which the engine installs right after its harvest
 * has read the previous run's, in the same step. A push couldn't promise that order.
 *
 * Gestures stay off: the capture layer owns taps and gestures.
 */
internal fun engineConfigJson(
    options: ResolvedOptions,
    recording: Boolean,
    snapshotJson: String?
): String {
    val config = linkedMapOf<String, Any?>(
        "features" to linkedMapOf(
            "crashes" to options.isEnabled(RumEventName.CRASHES),
            "hangs" to (recording && options.isEnabled(RumEventName.HANGS)),
            "appStart" to (recording && options.isEnabled(RumEventName.APP_START)),
            "vitals" to (recording && options.isEnabled(RumEventName.VITALS)),
            "gestures" to false
        ),
        "thresholds" to linkedMapOf(
            "hangThresholdMs" to resolveHangThresholdMs(options.native?.hangThresholdMs),
            "vitalsMaxSegmentMs" to resolveVitalsMaxSegmentMs(options.native?.vitalsMaxSegmentMs)
        ),
        "clearSnapshotAfterHarvest" to !recording
    )
    if (snapshotJson != null) config["snapshotJson"] = snapshotJson
    return encodeJson(config)
}
