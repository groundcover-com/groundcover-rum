// A JVM-only harness for the engine — not how it ships.
//
// The engine ships inside each SDK's own Android library (a vendored copy, see
// scripts/vendor-engine.mjs), and those libraries depend on their framework —
// react-android comes from the host app's React Native Gradle plugin — so none of
// them builds standalone. This project compiles every engine file and its tests
// against the Android SDK's classes alone, so `./gradlew test` runs in seconds on
// any machine, with no Android SDK install, no emulator and no framework.
rootProject.name = "groundcover-rum-engine-tests"
