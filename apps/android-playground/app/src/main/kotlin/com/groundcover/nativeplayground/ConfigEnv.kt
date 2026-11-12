package com.groundcover.nativeplayground

// Build-time environment, the counterpart of apps/flutter-playground/lib/config_env.dart. Values
// come from Gradle properties (-PgcDsn=…, see app/build.gradle.kts) through BuildConfig; the
// defaults are the e2e run's.
object ConfigEnv {
    val dsn: String = BuildConfig.GC_DSN.trim()
    val apiKey: String = BuildConfig.GC_API_KEY.trim()
    val releaseId: String = BuildConfig.GC_RELEASE_ID.trim()

    /** The preset compiled in with `-PgcPreset=<name>`, or empty. */
    val compiledPreset: String = BuildConfig.GC_PRESET.trim()

    /**
     * `-PgcDebug=1`: turns the `device` preset's SDK debug logging on, which prints every batch
     * unredacted. The other presets always log.
     */
    val debugRequested: Boolean = BuildConfig.GC_DEBUG.trim() == "1"

    /**
     * The hosts the Network tab calls on a real DSN, as whole-URL globs: the `device` preset's
     * trace targets. Anchored past the host with a `/`, so a suffix lookalike
     * (`httpbin.org.evil.example`) doesn't match.
     */
    val devicePropagationUrls = listOf("https://httpbin.org/*")

    private val mockPort = Regex(":9393(?=$|/)")

    /** Whether the DSN is the local mock ingest on :9393, which serves the echo on :9394. */
    val echoIsLocalMock: Boolean = mockPort.containsMatchIn(dsn)

    /**
     * The echo target for the Network screen. The SDK skips requests to its own ingest, so the
     * echo lives on the mock's sibling port; a manual run against a real DSN falls back to httpbin.
     */
    val echoUrl: String =
        if (!echoIsLocalMock) {
            "https://httpbin.org/anything"
        } else {
            dsn.trimEnd('/').replace(mockPort, ":9394") + "/__echo"
        }
}
