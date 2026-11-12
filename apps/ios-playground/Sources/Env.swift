import Foundation

// Build-time environment, the counterpart of apps/flutter-playground/lib/config_env.dart. The
// values are build settings (project.yml) that Info.plist carries into the app.

enum Env {
    private static func value(_ key: String) -> String {
        let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static var dsn: String { value("GCDsn") }
    static var apiKey: String { value("GCApiKey") }
    static var releaseId: String { value("GCReleaseId").isEmpty ? "1.0.0" : value("GCReleaseId") }

    /// The preset compiled in with `GC_PRESET=<name>`, or empty.
    static var compiledPreset: String { value("GCPreset") }

    /// `GC_DEBUG=1`: turns the `device` preset's SDK debug logging on, which prints every batch
    /// unredacted. The other presets always log.
    static var debugRequested: Bool { value("GCDebug") == "1" }

    /// The hosts the Network tab calls on a real DSN, as whole-URL globs: the `device` preset's
    /// trace targets. Anchored past the host with a `/`, so a suffix lookalike doesn't match.
    static let devicePropagationUrls = ["https://httpbin.org/*"]

    /// Whether the DSN is the local mock ingest on :9393, which serves the echo endpoints on its
    /// sibling port :9394.
    static var echoIsLocalMock: Bool {
        dsn.range(of: #":9393(?=$|/)"#, options: .regularExpression) != nil
    }

    /// The echo target for the Network screen. The SDK skips requests to its own ingest, so the
    /// echo lives on the mock's sibling port; a manual run against a real DSN falls back to
    /// httpbin.
    static var echoUrl: String {
        guard echoIsLocalMock else { return "https://httpbin.org/anything" }
        let base = dsn.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #":9393(?=$|/)"#, with: ":9394", options: .regularExpression)
        return "\(base)/__echo"
    }
}
