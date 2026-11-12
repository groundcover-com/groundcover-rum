import Foundation
import Testing
@testable import GroundcoverRumEngine

/// The bridge contract, in both directions: the JSON JavaScript sends in, and
/// the status JavaScript reads back. The status is not cosmetic — gesture
/// suppression keys on it, so a wrong shape here makes JavaScript stand down in
/// favour of a tracker that never armed, and every scroll is lost.
@Suite("Engine config and status")
struct GCRumEngineConfigTests {
    private func json(
        crashes: Bool = true,
        hangs: Bool = true,
        appStart: Bool = true,
        vitals: Bool = true,
        gestures: Bool = true,
        hangThresholdMs: Double = 2_000,
        vitalsMaxSegmentMs: Double = 5_000,
        snapshot: String = "null"
    ) -> String {
        """
        {"features":{"crashes":\(crashes),"hangs":\(hangs),"appStart":\(appStart),
        "vitals":\(vitals),"gestures":\(gestures)},
        "thresholds":{"hangThresholdMs":\(hangThresholdMs),
        "vitalsMaxSegmentMs":\(vitalsMaxSegmentMs)},
        "snapshotJson":\(snapshot)}
        """
    }

    // MARK: - Decoding

    @Test("decodes the shape the bridge sends")
    func decodesFullConfig() throws {
        let config = try GCRumEngineConfig.decode(from: json())

        #expect(config.features.crashes)
        #expect(config.features.hangs)
        #expect(config.features.appStart)
        #expect(config.features.vitals)
        #expect(config.features.gestures)
        #expect(config.thresholds.hangThresholdMs == 2_000)
        #expect(config.thresholds.vitalsMaxSegmentMs == 5_000)
        #expect(config.snapshotJson == nil)
    }

    /// Each feature is an independent gate; a host that enables one must not
    /// silently get the others.
    @Test("carries each feature flag independently")
    func featuresAreIndependent() throws {
        let config = try GCRumEngineConfig.decode(
            from: json(crashes: true, hangs: false, appStart: false, vitals: false, gestures: false)
        )

        #expect(config.features.crashes)
        #expect(!config.features.hangs)
        #expect(!config.features.appStart)
        #expect(!config.features.vitals)
        #expect(!config.features.gestures)
    }

    /// The snapshot is a JSON string INSIDE the config JSON — it is handed to
    /// disk verbatim and must not be re-encoded or unescaped on the way.
    @Test("carries the embedded snapshot string through untouched")
    func snapshotPassesThroughVerbatim() throws {
        let embedded = #"{\"session_id\":\"s-1\",\"app\":{\"name\":\"demo\"}}"#
        let config = try GCRumEngineConfig.decode(from: json(snapshot: "\"\(embedded)\""))

        #expect(config.snapshotJson == #"{"session_id":"s-1","app":{"name":"demo"}}"#)
    }

    @Test("an unsampled session sends no snapshot")
    func missingSnapshotIsNil() throws {
        #expect(try GCRumEngineConfig.decode(from: json(snapshot: "null")).snapshotJson == nil)
    }

    @Test("tuned thresholds survive the crossing")
    func thresholdsAreCarried() throws {
        let config = try GCRumEngineConfig.decode(
            from: json(hangThresholdMs: 1_000, vitalsMaxSegmentMs: 2_000)
        )

        #expect(config.thresholds.hangThresholdMs == 1_000)
        #expect(config.thresholds.vitalsMaxSegmentMs == 2_000)
    }

    /// Forward compatibility: an OTA JavaScript bundle can be newer than the
    /// installed binary and send a key this build has never heard of. Refusing
    /// to decode would disarm every native feature over one unknown field.
    @Test("ignores keys a newer JavaScript bundle adds")
    func unknownKeysAreIgnored() throws {
        let extended = """
        {"features":{"crashes":true,"hangs":true,"appStart":true,"vitals":true,
        "gestures":true,"somethingNewer":true},
        "thresholds":{"hangThresholdMs":2000,"vitalsMaxSegmentMs":5000,"alsoNew":1},
        "snapshotJson":null,"topLevelNew":"x"}
        """

        #expect(try GCRumEngineConfig.decode(from: extended).features.crashes)
    }

    // MARK: - Malformed input

    /// Decoding is LENIENT about missing keys, which is the same contract
    /// `GcRumEngineConfig.kt` has. Lenient because the fallbacks are the
    /// SDK's own documented defaults rather than a guess, and the strict alternative
    /// resolves to an all-off status indistinguishable from "the host asked for
    /// nothing". See the type's own doc comment for the full argument.
    @Test("falls back to the documented defaults rather than refusing a partial config")
    func missingSectionsTakeDefaults() throws {
        let config = try GCRumEngineConfig.decode(from: #"{"features":{"crashes":true}}"#)

        #expect(config.features.crashes)
        #expect(!config.features.hangs)
        #expect(!config.features.appStart)
        #expect(!config.features.vitals)
        #expect(!config.features.gestures)
        // 2_000, not Kotlin's 5_000: Android's hang default is higher on purpose, so
        // copying the Kotlin fallback here would move iOS from 2s to 5s. JavaScript names
        // the pair in `packages/react-native/src/config/constants.ts`.
        #expect(config.thresholds.hangThresholdMs == 2_000)
        #expect(config.thresholds.vitalsMaxSegmentMs == 60_000)
        #expect(config.snapshotJson == nil)
    }

    @Test("an entirely empty object still yields a usable, all-off config")
    func emptyObjectTakesDefaults() throws {
        let config = try GCRumEngineConfig.decode(from: "{}")

        #expect(!config.features.crashes)
        #expect(!config.features.hangs)
        #expect(config.thresholds.hangThresholdMs == 2_000)
        #expect(config.thresholds.vitalsMaxSegmentMs == 60_000)
    }

    /// One config, one answer, on both platforms. Each case below has a twin in
    /// `GcRumEngineConfigTest.kt` asserting the SAME input gives the SAME result; the
    /// divergence they exist to stop is subtler than a missing key, because it needs a
    /// host sending a type the schema does not promise and then only shows up on one OS.
    @Test("coerces the string forms org.json coerces, so one config reads the same on both platforms")
    func coercesLikeTheKotlinTwin() throws {
        // `optBoolean` coerces "true"/"false"; a bare `try? decode(Bool.self)` would not,
        // so this would arm hangs on Android only.
        let flags = try GCRumEngineConfig.decode(
            from: #"{"features":{"hangs":"true","vitals":"TRUE","gestures":"nonsense"}}"#
        )
        #expect(flags.features.hangs)
        #expect(flags.features.vitals)
        #expect(!flags.features.gestures)

        // `optLong` coerces a numeric string.
        let numeric = try GCRumEngineConfig.decode(
            from: #"{"thresholds":{"hangThresholdMs":"3000","vitalsMaxSegmentMs":"12000"}}"#
        )
        #expect(numeric.thresholds.hangThresholdMs == 3_000)
        #expect(numeric.thresholds.vitalsMaxSegmentMs == 12_000)
    }

    @Test("a threshold that is not a usable duration falls back rather than arming on it")
    func uselessThresholdsFallBack() throws {
        // 0 and negatives make every frame a hang; 1e400 decodes to .infinity here.
        for value in ["0", "-1", "1e400"] {
            let config = try GCRumEngineConfig.decode(
                from: #"{"thresholds":{"hangThresholdMs":\#(value)}}"#
            )
            #expect(config.thresholds.hangThresholdMs == 2_000, "\(value) was armed")
        }
    }

    /// `optLong` truncates, so iOS truncates too, and both platforms read a fractional threshold
    /// the same way. Twinned in `GcRumEngineConfigTest.kt`.
    @Test("truncates a fractional threshold, as optLong does")
    func fractionalThresholdsTruncate() throws {
        let config = try GCRumEngineConfig.decode(
            from: #"{"thresholds":{"hangThresholdMs":2500.7,"vitalsMaxSegmentMs":12000.9}}"#
        )
        #expect(config.thresholds.hangThresholdMs == 2_500)
        #expect(config.thresholds.vitalsMaxSegmentMs == 12_000)

        // Truncating to zero is not a threshold, so it falls back rather than arming on 0.
        let sub = try GCRumEngineConfig.decode(from: #"{"thresholds":{"hangThresholdMs":0.5}}"#)
        #expect(sub.thresholds.hangThresholdMs == 2_000)
    }

    @Test("a non-string snapshot is no snapshot, not a coerced one")
    func nonStringSnapshotIsNil() throws {
        #expect(try GCRumEngineConfig.decode(from: #"{"snapshotJson":42}"#).snapshotJson == nil)
        #expect(try GCRumEngineConfig.decode(from: #"{"snapshotJson":true}"#).snapshotJson == nil)
    }

    /// The version-skew case the leniency exists for: a binary that requires a key an
    /// older bundle never learned to send must still arm what the bundle DID ask for.
    /// Strict decoding would take the whole engine down here, silently.
    @Test("a key arriving with the wrong type falls back instead of disarming everything")
    func wrongTypeFallsBack() throws {
        let config = try GCRumEngineConfig.decode(
            from: #"{"features":{"crashes":true,"hangs":"yes"},"thresholds":{"hangThresholdMs":"soon"}}"#
        )

        #expect(config.features.crashes)
        #expect(!config.features.hangs)
        #expect(config.thresholds.hangThresholdMs == 2_000)
    }

    @Test("refuses input that is not JSON at all")
    func garbageThrows() {
        #expect(throws: (any Error).self) {
            try GCRumEngineConfig.decode(from: "not json")
        }
    }

    @Test("refuses an empty string")
    func emptyStringThrows() {
        #expect(throws: (any Error).self) {
            try GCRumEngineConfig.decode(from: "")
        }
    }

    // MARK: - Status

    /// The key names are read by JavaScript. Renaming one silently turns that
    /// feature's health into `false` on the JS side.
    @Test("encodes the status keys JavaScript reads")
    func statusEncodesAllKeys() throws {
        var status = GCRumEngineStatus()
        status.crashes = true
        status.gestures = true

        let decoded = try JSONSerialization.jsonObject(
            with: Data(status.encodedJson().utf8)
        ) as? [String: Any]

        #expect(decoded?["crashes"] as? Bool == true)
        #expect(decoded?["gestures"] as? Bool == true)
        #expect(decoded?["hangs"] as? Bool == false)
        #expect(decoded?["appStart"] as? Bool == false)
        #expect(decoded?["vitals"] as? Bool == false)
    }

    /// `gestures` and `gesturesAttached` are two different claims — created, versus hooked to a
    /// window right now — and they must not collapse into one key. JavaScript stands its own
    /// classifier down on the second only: standing down on the first drops every gesture until
    /// the attach lands, and forever if it never does.
    ///
    /// The key has to be present and false rather than omitted, because that is how a re-init says
    /// "the tracker is gone" as opposed to saying nothing at all.
    @Test("encodes gesturesAttached separately from gestures")
    func statusEncodesGesturesAttachedSeparately() throws {
        var armedOnly = GCRumEngineStatus()
        armedOnly.gestures = true

        let armedDecoded = try JSONSerialization.jsonObject(
            with: Data(armedOnly.encodedJson().utf8)
        ) as? [String: Any]

        #expect(armedDecoded?["gestures"] as? Bool == true)
        #expect(armedDecoded?["gesturesAttached"] as? Bool == false)

        var hooked = GCRumEngineStatus()
        hooked.gestures = true
        hooked.gesturesAttached = true

        let hookedDecoded = try JSONSerialization.jsonObject(
            with: Data(hooked.encodedJson().utf8)
        ) as? [String: Any]

        #expect(hookedDecoded?["gesturesAttached"] as? Bool == true)
    }

    @Test("a fresh status reports nothing armed")
    func freshStatusIsAllFalse() {
        let status = GCRumEngineStatus()

        #expect(!status.crashes)
        #expect(!status.hangs)
        #expect(!status.appStart)
        #expect(!status.vitals)
        #expect(!status.gestures)
        #expect(!status.gesturesAttached)
    }

    /// `crashes: false` has two meanings JS could not tell apart: the host never asked, or it
    /// asked and another KSCrash user already owns the singleton. Refusing is correct, since
    /// harvesting their store would delete their reports, but on its own it would leave apps
    /// silently reporting no native crashes. The engine holds no logger by design, so it reports
    /// the reason and JS warns.
    @Test("carries the reason crash reporting is unavailable")
    func statusEncodesCrashesUnavailable() throws {
        var status = GCRumEngineStatus()
        status.crashesUnavailable = "KSCrash is already installed"

        let decoded = try JSONSerialization.jsonObject(
            with: Data(status.encodedJson().utf8)
        ) as? [String: Any]

        #expect(decoded?["crashesUnavailable"] as? String == "KSCrash is already installed")
    }

    /// Omitted rather than null when there is nothing wrong: the JS side treats
    /// presence as the signal, and a key that is always there would have to be
    /// null-checked at every reader instead.
    @Test("omits the reason entirely when crash reporting is healthy")
    func statusOmitsCrashesUnavailableWhenHealthy() throws {
        var status = GCRumEngineStatus()
        status.crashes = true

        let decoded = try JSONSerialization.jsonObject(
            with: Data(status.encodedJson().utf8)
        ) as? [String: Any]

        #expect(decoded?["crashesUnavailable"] == nil)
        #expect(decoded?.keys.contains("crashesUnavailable") == false)
    }
}
