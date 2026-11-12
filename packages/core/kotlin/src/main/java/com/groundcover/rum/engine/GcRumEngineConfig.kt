package com.groundcover.rum.engine

import org.json.JSONObject

/**
 * Everything the engine needs to run, decoded from the JSON the bridge hands it. Note what is
 * NOT here: the DSN and the API key. Native captures and persists, JS enriches and
 * transports, and the only session state native holds is the snapshot it needs on disk to
 * attribute a crash after the JS runtime is gone.
 *
 * Parsed with org.json, so the library adds no transitive dependency to host apps.
 *
 * `internal`, like the rest of the engine: every SDK compiles it into its own module, so no
 * app ever sees it as API.
 */
internal data class GcRumEngineConfig(
    val features: Features,
    val thresholds: Thresholds,
    val snapshotJson: String?,
    /**
     * Clear the stored envelope at the END of [GcRumEngine.start], after the crash harvest that
     * reads it. The unsampled path needs exactly that pair — harvest what a previous SAMPLED run
     * left, then leave nothing for a crash in THIS run to be attributed to.
     *
     * A flag rather than "an explicit JSON null in [snapshotJson]", because a serializer that omits
     * null-valued keys turns that signal into "leave the previous envelope alone" — silently, and
     * in the direction of misattribution. Ignored by an engine older than this field, which is why
     * JavaScript still clears asynchronously as a backstop.
     */
    val clearSnapshotAfterHarvest: Boolean,
) {
    data class Features(
        val crashes: Boolean,
        val hangs: Boolean,
        val appStart: Boolean,
        val vitals: Boolean,
        val gestures: Boolean,
    )

    data class Thresholds(
        val hangThresholdMs: Long,
        /**
         * Safety valve, not a cadence — a frame segment normally ends on a
         * navigation or on backgrounding.
         */
        val vitalsMaxSegmentMs: Long,
    )

    companion object {
        private fun positiveOr(value: Long, fallback: Long): Long =
            if (value > 0) value else fallback

        private const val DEFAULT_HANG_THRESHOLD_MS = 5_000L
        private const val DEFAULT_VITALS_MAX_SEGMENT_MS = 60_000L

        fun decode(json: String): GcRumEngineConfig {
            val root = JSONObject(json)
            val features = root.optJSONObject("features") ?: JSONObject()
            val thresholds = root.optJSONObject("thresholds") ?: JSONObject()

            return GcRumEngineConfig(
                features = Features(
                    crashes = features.optBoolean("crashes", false),
                    hangs = features.optBoolean("hangs", false),
                    appStart = features.optBoolean("appStart", false),
                    vitals = features.optBoolean("vitals", false),
                    gestures = features.optBoolean("gestures", false),
                ),
                thresholds = Thresholds(
                    // `optLong` coerces a numeric string, as GCRumEngineConfig does.
                    // What it does NOT reject is a value that is merely
                    // useless: 0 or a negative hang threshold makes every frame a hang, so
                    // it falls back to the default rather than arming on it.
                    hangThresholdMs = positiveOr(
                        thresholds.optLong("hangThresholdMs", DEFAULT_HANG_THRESHOLD_MS),
                        DEFAULT_HANG_THRESHOLD_MS,
                    ),
                    vitalsMaxSegmentMs = positiveOr(
                        thresholds.optLong("vitalsMaxSegmentMs", DEFAULT_VITALS_MAX_SEGMENT_MS),
                        DEFAULT_VITALS_MAX_SEGMENT_MS,
                    ),
                ),
                // A real String or nothing, as on iOS. `optString` would COERCE: a number
                // would become its own text, so `"snapshotJson": 42` would be accepted as
                // the envelope `"42"` — a snapshot that parses nowhere and attributes a
                // crash to nothing. For this one field strict is the better contract.
                // `opt` returns JSONObject.NULL for an explicit
                // null, which is not a String either, so the cast covers absent, null and
                // wrong-typed in one step.
                snapshotJson = root.opt("snapshotJson") as? String,
                clearSnapshotAfterHarvest = root.optBoolean("clearSnapshotAfterHarvest", false),
            )
        }
    }
}

/**
 * Which features actually armed. Reported back through `nativeInit` so the JS
 * side never suppresses its own capture in favour of a tracker that failed to
 * attach (an OS version gate, a hostile Window.Callback).
 */
internal data class GcRumEngineStatus(
    var crashes: Boolean = false,
    var hangs: Boolean = false,
    var appStart: Boolean = false,
    var vitals: Boolean = false,
    var gestures: Boolean = false,
    /**
     * Whether the gesture tracker is hooked to a window at the moment this status is reported —
     * not merely that it was created, which is what [gestures] says.
     *
     * Only ever true for a re-init: on a first `start` the attach is still queued on the main
     * looper, and the tracker's own `gestures_attached` signal reports it. That signal is
     * edge-triggered though, and a second `start` returns early without re-attaching, so the edge
     * cannot be replayed for a JavaScript context that arrived after it — which is every Metro
     * fast-refresh. Left unreported, JS would suppress nothing while this tracker kept measuring,
     * and each swipe would be reported twice with disagreeing kinematics.
     */
    var gesturesAttached: Boolean = false,
    /**
     * Whether that tracker reaches EVERY surface the app can present — see
     * [com.groundcover.rum.engine.gestures.GcRumGestureTracker.COVERS_ALL_SURFACES], which is
     * false here because attachment is per ACTIVITY and a Dialog is not one.
     *
     * Carried on the status for the same reason [gesturesAttached] is: a re-init never sees the
     * `gestures_attached` signal that also carries it, so this is the only way a fresh JavaScript
     * context learns what the running tracker can actually see.
     */
    var gesturesCoverAllSurfaces: Boolean = false,
    /**
     * Why crash reporting is not running when the host asked for it — usually another SDK
     * owning the uncaught-exception chain. `crashes = false` reads identically to "the host
     * never asked", which would leave an app reporting nothing with no explanation. The engine
     * holds no logger by design, so it reports the reason and JavaScript warns.
     */
    var crashesUnavailable: String? = null,
) {
    fun encodedJson(): String =
        JSONObject()
            .put("crashes", crashes)
            .put("hangs", hangs)
            .put("appStart", appStart)
            .put("vitals", vitals)
            .put("gestures", gestures)
            .put("gesturesAttached", gesturesAttached)
            .put("gesturesCoverAllSurfaces", gesturesCoverAllSurfaces)
            // Omitted, not null, when healthy: presence IS the signal on the JS
            // side, so a key that were always there would need null-checking at
            // every reader. Matches the Swift encoder, which omits a nil String?.
            .apply { crashesUnavailable?.let { put("crashesUnavailable", it) } }
            .toString()
}
