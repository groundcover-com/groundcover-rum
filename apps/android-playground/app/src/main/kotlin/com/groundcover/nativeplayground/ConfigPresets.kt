package com.groundcover.nativeplayground

// Every SDK config the e2e suite needs, keyed by preset name: the counterpart of
// apps/flutter-playground/lib/config_presets.dart and apps/rn-playground/src/config-presets.ts.
// One preset per behaviour that can only be chosen at start (sampling, privacy levels, the
// callbacks, enabledEvents). Each preset states the block it replaces outright, because a merge
// would hide a mistyped option behind the default.

import com.groundcover.rum.BeforeSend
import com.groundcover.rum.EnrichEvent
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.NativeOptions
import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.TracingOptions
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.TtiMode
import java.io.File
import org.json.JSONObject

/** The label an event must carry for the `callbacks` preset to drop it. */
const val DROP_MARKER = "DROPME"

/** The attribute the `callbacks` preset's enrichEvent stamps on every event. */
const val ENRICH_KEY = "e2e_enriched"
const val ENRICH_VALUE = "by-enrich-event"

/** What the `custom-redact` preset's hook puts in place of an `email` leaf. */
const val CUSTOM_REDACTION = "e2e-custom-redaction"

/**
 * The file the harness writes into the app's files directory to pick a preset:
 * `{"preset": "<name>"}`. A native app has no bundle to rewrite, and Mobilewright can't pass
 * launch arguments, so this is how a spec boots the app with a different start-time config.
 */
const val PRESET_FILE_NAME = "e2e-preset.json"

/** The preset name in [PRESET_FILE_NAME] under [filesDir], or null when there is none. */
fun readPresetFile(filesDir: File): String? {
    val file = File(filesDir, PRESET_FILE_NAME)
    if (!file.exists()) return null
    val preset = JSONObject(file.readText()).opt("preset")
    return preset as? String
}

private fun baseOptions(
    sessionSampleRate: Double? = null,
    enabledEvents: List<RumEventName>? = null,
    beforeSend: BeforeSend? = null,
    enrichEvent: EnrichEvent? = null,
    privacy: PrivacyOptions? = null,
    transport: TransportOptions? = null,
    native: NativeOptions? = null,
) = GroundcoverOptions(
    debug = true,
    sessionSampleRate = sessionSampleRate,
    enabledEvents = enabledEvents,
    beforeSend = beforeSend,
    enrichEvent = enrichEvent,
    privacy = privacy,
    // Flush fast so the specs don't wait out the 10 s default.
    transport = transport ?: TransportOptions(batchTimeoutMs = FLUSH_FAST_MS),
    // Trace headers on everything, so the echo replays them back.
    tracing = TracingOptions(propagationUrls = listOf("*")),
    native = native ?: baseNative(),
)

private const val FLUSH_FAST_MS = 500L

/**
 * The playground's native block, restated per preset like RN's and Flutter's, so a preset
 * replaces it outright rather than merging into it.
 */
private fun baseNative(
    // Well below Android's 5 s default, so the hang specs can drive one with their 3 s stall
    // without waiting out a real ANR (or the system killing the app first).
    hangThresholdMs: Long = HANG_THRESHOLD_MS,
    tti: TtiMode? = null,
) = NativeOptions(
    hangThresholdMs = hangThresholdMs,
    // The production default, restated so it can't drift out from under the vitals specs: a
    // segment must close only on a navigation or on backgrounding during a test. `vitals-fast`
    // is where a short cap is wanted.
    vitalsMaxSegmentMs = VITALS_MAX_SEGMENT_MS,
    tti = tti,
)

private const val HANG_THRESHOLD_MS = 1_000L
private const val VITALS_MAX_SEGMENT_MS = 60_000L

/**
 * The presets rn-playground and flutter-playground define. One table, so a name can't be
 * accepted and then boot the default config instead.
 */
private val presets: Map<String, () -> GroundcoverOptions> =
    mapOf(
        "default" to { baseOptions() },
        // The only preset for a real device against a real cluster. Every other preset is tuned
        // for the mock ingest in ways that are wrong there: a flush every 500 ms, a `traceparent`
        // on third-party hosts, 1 s stalls reported as hangs, and a debug line per event. It
        // states no native block on purpose, so the run exercises the SDK's shipping defaults.
        "device" to {
            GroundcoverOptions(
                debug = ConfigEnv.debugRequested,
                tracing = TracingOptions(propagationUrls = ConfigEnv.devicePropagationUrls),
            )
        },
        // An explicit 0, not null: null means "sample everything".
        "unsampled" to { baseOptions(sessionSampleRate = 0.0) },
        "mask-all" to { baseOptions(privacy = PrivacyOptions(level = PrivacyLevel.MASK_ALL)) },
        "allow" to { baseOptions(privacy = PrivacyOptions(level = PrivacyLevel.ALLOW)) },
        "no-body-mask" to { baseOptions(privacy = PrivacyOptions(maskNetworkBodies = false)) },
        "custom-redact" to {
            baseOptions(
                privacy =
                    PrivacyOptions(
                        // Benign to the built-in rules; naming it proves the extra keys are
                        // consulted at all.
                        sensitiveKeys = listOf("order_id"),
                        // Overrides one leaf and defers everywhere else by returning null, the
                        // contract that stops a hook from disabling masking wholesale.
                        redact = { field -> if (field.key == "email") CUSTOM_REDACTION else null },
                    ),
            )
        },
        "callbacks" to {
            baseOptions(
                // Attributes arrive dot-flattened, so the label is one flat key.
                beforeSend = { event ->
                    !"${event.attributes["interaction_target.label"] ?: ""}".contains(DROP_MARKER)
                },
                enrichEvent = { event -> event.apply { attributes[ENRICH_KEY] = ENRICH_VALUE } },
            )
        },
        // A host callback that throws must not take the event stream down.
        "callbacks-throw" to {
            baseOptions(
                beforeSend = { throw IllegalStateException("e2e beforeSend throws on purpose") },
            )
        },
        "crashes-only" to { baseOptions(enabledEvents = listOf(RumEventName.CRASHES)) },
        // At the 500 ms default everything flushes on its own before a spec can press HOME, so
        // only a long timer proves the background flush.
        "slow-flush" to { baseOptions(transport = TransportOptions(batchTimeoutMs = 60_000)) },
        "tti-manual" to { baseOptions(native = baseNative(tti = TtiMode.MANUAL)) },
        // A 2 s threshold against the specs' 3 s stall: the margin that makes a watchdog which
        // samples for stalls, rather than measuring them, miss some of five identical ones.
        // rn-playground's reasoning, in its config-presets. Don't raise it without recomputing
        // that margin.
        "hang-sampling" to { baseOptions(native = baseNative(hangThresholdMs = 2_000)) },
        // The only preset with a short segment cap: at the 60 s default a spec would have to
        // dwell on one screen for a minute to see a `safety` close.
        "vitals-fast" to {
            baseOptions(
                native =
                    NativeOptions(
                        hangThresholdMs = HANG_THRESHOLD_MS,
                        vitalsMaxSegmentMs = 2_000,
                    ),
            )
        },
    )

/**
 * The preset to boot with: a compiled-in `gcPreset` wins, as RN's `EXPO_PUBLIC_GC_PRESET` does,
 * then the one the harness wrote into the app's files ([fromFile]), then `default`. An unknown
 * name fails the launch loudly, because booting the default instead would let a preset spec pass
 * on the wrong config.
 */
fun resolvePreset(fromFile: String?): String {
    val requested = ConfigEnv.compiledPreset.ifEmpty { fromFile?.trim().orEmpty() }
    if (requested.isEmpty()) return "default"
    require(requested in presets) {
        "not a known preset: \"$requested\"; known presets: ${presets.keys.joinToString(", ")}"
    }
    return requested
}

fun configFor(preset: String): GroundcoverConfig =
    GroundcoverConfig(
        apiKey = ConfigEnv.apiKey,
        dsn = ConfigEnv.dsn,
        cluster = "playground",
        // Fixed per preset rather than compiled in, so a device session lands under a known
        // identity.
        environment = if (preset == "device") "device-test" else "dev",
        appId = "native-playground",
        releaseId = ConfigEnv.releaseId,
        options = presets.getValue(preset)(),
    )
