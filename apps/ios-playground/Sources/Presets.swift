import Foundation
import GroundcoverRum

// Every SDK config the e2e suite needs, keyed by preset name: the counterpart of
// apps/flutter-playground/lib/config_presets.dart. One preset per behaviour that can only be
// chosen at start (sampling, privacy levels, the callbacks, enabledEvents). Each preset states the
// block it replaces outright, because a deep merge would hide a mistyped key behind the default.

/// The label an event must carry for the `callbacks` preset to drop it.
let dropMarker = "DROPME"

/// The attribute the `callbacks` preset's enrichEvent stamps on every event.
let enrichKey = "e2e_enriched"
let enrichValue = "by-enrich-event"

/// What the `custom-redact` preset's hook puts in place of an `email` leaf.
let customRedaction = "e2e-custom-redaction"

/// The file the harness writes into the app's Documents directory to pick a preset:
/// `{"preset": "<name>"}`. Mobilewright can't pass launch arguments, so this is how a spec boots
/// the app with a different start-time config.
let presetFileName = "e2e-preset.json"

/// The preset name in the preset file, or nil when there is none.
func readPresetFile() -> String? {
    guard
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
            .first,
        let data = try? Data(contentsOf: documents.appendingPathComponent(presetFileName)),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return json["preset"] as? String
}

/// Thrown by the `callbacks-throw` preset's beforeSend.
struct BeforeSendRefusal: Error {}

/// Flush fast so the specs don't wait out the 10 s default.
private let flushFast = TransportOptions(batchTimeout: 0.5)

/// The native block every preset restates, so a preset replaces it outright rather than merging
/// into it. A 1 s hang threshold, well below the defaults, so the hang specs can drive one with
/// their 3 s stall; the production segment cap, restated so it can't drift out from under the
/// vitals specs.
private func baseNative(
    hangThreshold: TimeInterval = 1,
    vitalsMaxSegment: TimeInterval = 60,
    tti: TtiMode? = nil
) -> NativeOptions {
    NativeOptions(hangThreshold: hangThreshold, vitalsMaxSegment: vitalsMaxSegment, tti: tti)
}

private func baseOptions(
    sessionSampleRate: Double? = nil,
    enabledEvents: [RumEventName]? = nil,
    beforeSend: BeforeSend? = nil,
    enrichEvent: EnrichEvent? = nil,
    privacy: PrivacyOptions? = nil,
    transport: TransportOptions = flushFast,
    native: NativeOptions = baseNative()
) -> GroundcoverOptions {
    GroundcoverOptions(
        enabledEvents: enabledEvents,
        sessionSampleRate: sessionSampleRate,
        debug: true,
        beforeSend: beforeSend,
        enrichEvent: enrichEvent,
        privacy: privacy,
        // Trace headers on everything, so the echo replays them back.
        tracing: TracingOptions(propagationUrls: ["*"]),
        transport: transport,
        native: native)
}

/// The presets rn-playground defines. One table, so a name can't be accepted and then boot the
/// default config instead.
private let presets: [String: () -> GroundcoverOptions] = [
    "default": { baseOptions() },
    // The only preset for a real device against a real cluster
    // (apps/DEVICE_TESTING.md). It states no native block on purpose, so the run
    // exercises the SDK's shipping defaults.
    "device": {
        GroundcoverOptions(
            debug: Env.debugRequested,
            tracing: TracingOptions(propagationUrls: Env.devicePropagationUrls))
    },
    // An explicit 0, not nil: nil means "sample everything".
    "unsampled": { baseOptions(sessionSampleRate: 0) },
    "mask-all": { baseOptions(privacy: PrivacyOptions(level: .maskAll)) },
    "allow": { baseOptions(privacy: PrivacyOptions(level: .allow)) },
    "no-body-mask": { baseOptions(privacy: PrivacyOptions(maskNetworkBodies: false)) },
    "custom-redact": {
        baseOptions(
            privacy: PrivacyOptions(
                // Benign to the built-in rules; naming it proves the extra keys are consulted.
                sensitiveKeys: ["order_id"],
                // Overrides one leaf and defers everywhere else by returning nil.
                redact: { field in field.key == "email" ? customRedaction : nil }))
    },
    "callbacks": {
        baseOptions(
            beforeSend: { event in
                // Attributes arrive dot-flattened, so the label is one flat key.
                let label = event.attributes["interaction_target.label"] as? String ?? ""
                return !label.contains(dropMarker)
            },
            enrichEvent: { event in
                event.attributes[enrichKey] = enrichValue
                return event
            })
    },
    // A host callback that throws must not take the event stream down.
    "callbacks-throw": { baseOptions(beforeSend: { _ in throw BeforeSendRefusal() }) },
    "crashes-only": { baseOptions(enabledEvents: [.crashes]) },
    // At the 0.5 s flush everything goes out on its own before a spec can press HOME, so only a
    // long timer proves the background flush.
    "slow-flush": { baseOptions(transport: TransportOptions(batchTimeout: 60)) },
    "tti-manual": { baseOptions(native: baseNative(tti: .manual)) },
    // A 2 s threshold against the specs' 3 s stall: the margin rn-playground's config-presets
    // explains. Don't raise it without recomputing that margin.
    "hang-sampling": { baseOptions(native: baseNative(hangThreshold: 2)) },
    // The only preset with a short segment cap: at the 60 s default a spec would have to dwell on
    // one screen for a minute to see a `safety` close.
    "vitals-fast": { baseOptions(native: baseNative(vitalsMaxSegment: 2)) },
]

/// The preset to boot with: a compiled-in `GC_PRESET` wins, then the one the harness wrote into
/// the app's data, then `default`. An unknown name fails the launch loudly, because booting the
/// default instead would let a preset spec pass on the wrong config.
func resolvePreset(_ fromFile: String?) -> String {
    let compiled = Env.compiledPreset
    let requested =
        compiled.isEmpty
        ? (fromFile ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : compiled
    if requested.isEmpty { return "default" }
    guard presets[requested] != nil else {
        let known = presets.keys.sorted().joined(separator: ", ")
        fatalError("'\(requested)' is not a known preset; known presets: \(known)")
    }
    return requested
}

func config(for preset: String) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: Env.apiKey,
        dsn: Env.dsn,
        cluster: "playground",
        // Fixed per preset rather than compiled in, so a device session lands under a known
        // identity.
        environment: preset == "device" ? "device-test" : "dev",
        appId: "native-playground",
        releaseId: Env.releaseId,
        options: presets[preset]!())
}
