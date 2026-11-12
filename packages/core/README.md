# packages/core — the implementations groundcover's RUM SDKs share

Everything more than one SDK uses lives here, one folder per language:

| Path | What | Used by |
| --- | --- | --- |
| [`ts/`](ts) | `@groundcover/rum-core`: the platform-free TypeScript core (sessions, config, event shaping, batching, the transport contract) | browser, React Native |
| [`swift/`](swift) | The iOS engine, in Swift: native crash capture, app hangs, app start, frame vitals and native gestures, with its SwiftPM test harness | React Native, Flutter, native iOS |
| [`kotlin/`](kotlin) | Its Android twin, in Kotlin: the same signals, with its JVM/Robolectric harness in `kotlin/jvm-test` | React Native, Flutter, native Android |
| [`wire/`](wire) | The wire contract as plain JSON: each file is one request exactly as the SDK sends it. Every SDK's golden test makes the call and deep-compares | browser, React Native, Flutter, native iOS and Android |
| [`NATIVE_TESTING.md`](NATIVE_TESTING.md) | How to run the engine suites, what they cover, and which Swift/Kotlin units are twins | |

Nothing here is published on its own. Each SDK pulls in what it uses when it builds or packs.

**Not here: the Dart core.** The Flutter SDK is its only implementation, so it lives in
`packages/flutter/lib/src/core`. Only what two or more SDKs run belongs in `packages/core`.

## `ts/`: the TypeScript core

A private workspace package, imported as `@groundcover/rum-core`. The browser and React Native SDKs
alias it to `../core/ts/src` in their `tsconfig.json` `paths` and vitest config, and tsup inlines it
into each SDK's bundle (`noExternal`), so a change here ships inside both.

It must run on any JS host, and three checks enforce that together:
- `tsconfig.json` compiles against plain ES2022 with no `@types`, so browser, Node and RN globals
  fail compilation.
- `eslint.config.mjs`'s `no-restricted-globals` also catches access through `globalThis`.
- `lint-fixtures/verify-gate.mjs` proves both checks still catch what they should.

Run everything with `pnpm --filter @groundcover/rum-core test`.

## `swift/` and `kotlin/`: the native engine

It has no React Native or Flutter dependency. Each SDK, the native iOS and Android ones included,
drives it through a thin bridge of its own.

| Path | What |
| --- | --- |
| `swift/Engine/` | The iOS engine: Swift, plus one Objective-C unit (`AppStart/GCRumProcessBoot.{h,m}`) |
| `swift/EngineTests/`, `swift/Package.swift`, `swift/run-engine-tests.sh` | SwiftPM harness for the pure-logic files |
| `kotlin/src/main/java/com/groundcover/rum/engine/` | The Android engine |
| `kotlin/src/test/java/`, `kotlin/jvm-test/` | Its tests and the JVM/Robolectric harness that runs them |

### Edit here, never in an SDK

Each SDK that ships the engine gets a copy written by
[`scripts/vendor-engine.mjs`](../../scripts/vendor-engine.mjs). The copy is git-ignored and never
committed:

| Source | Copy |
| --- | --- |
| `swift/Engine/` | `packages/react-native/ios/Engine/` |
| `kotlin/src/main/java/com/groundcover/rum/engine/` | `packages/react-native/android/src/main/java/com/groundcover/rum/engine/` |
| `swift/Engine/`, except `GCRumProcessBoot.{h,m}` | `packages/flutter/ios/groundcover_rum/Sources/groundcover_rum/Engine/` |
| `swift/Engine/AppStart/GCRumProcessBoot.{h,m}` | `packages/flutter/ios/groundcover_rum/Sources/GroundcoverRumBoot/` (the header under `include/`) |
| `kotlin/src/main/java/com/groundcover/rum/engine/` | `packages/flutter/android/src/main/kotlin/com/groundcover/rum/engine/` |
| `swift/Engine/`, except `GCRumProcessBoot.{h,m}` | `packages/ios/Sources/GroundcoverRum/Engine/` |
| `swift/Engine/AppStart/GCRumProcessBoot.{h,m}` | `packages/ios/Sources/GroundcoverRumBoot/` (the header under `include/`) |

The Flutter plugin splits the Objective-C unit out because its Swift package can't mix
Objective-C into the Swift target that reads it; it builds `GroundcoverRumBoot` as a target of its
own, which `GCRumAppStartTracker` imports where it exists. The native iOS SDK's Swift package
(`packages/ios`) does the same. CocoaPods compiles both languages into one module, so RN, and the
plugin's own podspec, need no import. `GCRumCrashReporter` likewise imports
KSCrash under either module name: `KSCrash` from CocoaPods, `KSCrashRecording` from SwiftPM.

The native Android library (`packages/android`) has no copy at all: Gradle can read outside the
module, so `rum-android` compiles `kotlin/src/main/java` from here.

The copy is written:
- on every `pnpm install`, by the root `prepare` script;
- first thing by the rn-playground scripts that build native code (`ios`, `android`, `prebuild`,
  `device:*`, `e2e:app:*`);
- by RN CI's React-free lint, by Flutter CI before each of its native builds, and by Native iOS
  CI's package build (`packages/ios/scripts/api-surface.sh`, which writes the copy itself);
- by `@groundcover/react-native`'s `prepack`, before any `npm pack` or `npm publish`, and by
  groundcover_rum's publish workflow (`dart pub publish` has no hook of its own). The Flutter
  copy is git-ignored but still ships: pub reads `packages/flutter/.pubignore` instead of
  `.gitignore`, and that file does not exclude it.

So an engine edit reaches each playground's next build through those. A bare `expo run:*` or
`flutter build`, or a build from Xcode or Android Studio, compiles whatever copy is on disk: run
`node scripts/vendor-engine.mjs` first. `--check` reports a stale copy. RN CI, Flutter CI and Native
iOS CI each fail if their SDK's copy is ever committed.

Xcode and Android Studio open the copy, since it is what they compile, but it is build output like
`dist/`: an edit made there is overwritten by the next run. Make engine edits here.

The copy is byte-identical to the source, so `@groundcover/react-native`'s tarball is
byte-reproducible from the engine sources.

Why a copy and not a reference:
- **Packing:** npm packs only files inside the package, and the RN podspec and Android library
  resolve their sources there too.
- **Kotlin visibility:** RN's Kotlin bridge calls an engine member marked `internal`, and each
  SDK's manifest names an `internal` class. Both stay visible only because the copy compiles into
  the SDK's own Gradle module.
- **CocoaPods:** a separately published engine pod is off the table, because CocoaPods trunk goes
  read-only on 2026-12-02.

### The engine builds without React

Both platforms check that every engine file compiles with no framework available, so a React or
Flutter import can't slip into the engine:

- **Android:** `kotlin/jvm-test` compiles every engine file against the Android SDK's classes and
  `androidx.annotation` alone. A `com.facebook.*` import fails `compileKotlin`.
- **iOS:** `pod lib lint GroundcoverRum.podspec --subspec=Engine` (run from
  `packages/react-native`) builds the whole engine, UIKit, KSCrash and Objective-C included, with
  no React pod. An `import React` fails with `Unable to resolve module dependency: 'React'`.

Both run in RN CI: the Kotlin suite in `Engine unit tests (Kotlin)`, the lint in the `ios-app` job.
Flutter CI runs the same unit suites in its own gate (the Kotlin job through the shared
`.github/actions/engine-tests-kotlin`, the Swift suite in its `ios-app` job), and compiles the whole
engine into the plugin twice: through its Swift package (`ios-app`) and through its podspec
(`ios-pods`).
