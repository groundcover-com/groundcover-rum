<p align="center">
  <img src="./assets/logo.png" alt="groundcover" width="240" />
</p>

<h1 align="center">groundcover RUM SDKs</h1>

groundcover's Real User Monitoring SDKs for the web, React Native, Flutter, iOS and Android, in one
monorepo. Every SDK sends the same `/json/rum` wire format, so sessions from every platform land in
the same RUM views. The product guide is the
[groundcover RUM documentation](https://docs.groundcover.com/investigate/real-user-monitoring-rum);
each package's README is that SDK's reference.

## Packages

| Package | Platform | Path | Registry | Version | Status |
| --- | --- | --- | --- | --- | --- |
| [`@groundcover/browser`](packages/browser) | Web | `packages/browser` | npm (`rc` tag: 2.3.0-rc.0) | 2.2.3 | Stable |
| [`@groundcover/react-native`](packages/react-native) | React Native (iOS, Android) | `packages/react-native` | npm, `rc` tag | 0.0.1-rc.10 | Release candidate |
| [`groundcover_rum`](packages/flutter) | Flutter (iOS, Android) | `packages/flutter` | pub.dev | 0.0.1-rc.4 | Release candidate |
| [`GroundcoverRum`](packages/ios) | iOS (Swift, Objective-C) | `packages/ios` | Swift Package Manager | 0.0.1-rc.3 | Release candidate |
| [`rum-android`](packages/android) (+ `-compose`, `-okhttp`, `-timber`) | Android (Kotlin, Java) | `packages/android` | Maven Central | 0.0.1-rc.3 | Release candidate |
| `@groundcover/rum-core` | Shared TypeScript core | `packages/core/ts` | Not published | — | Internal |

Each package has its own README, CHANGELOG and LICENSE.

## How the SDKs share code

What more than one SDK runs lives in [`packages/core`](packages/core), one folder per language:

| Shared piece | Path | Used by | How it gets there |
| --- | --- | --- | --- |
| TypeScript core: sessions, config, event shaping, batching, transport | `packages/core/ts` | browser, React Native | Inlined into each bundle by tsup |
| Native engine: crashes, hangs, app start, frame vitals, native gestures | `packages/core/swift`, `packages/core/kotlin` | React Native, Flutter, iOS, Android | A git-ignored copy written by [`scripts/vendor-engine.mjs`](scripts/vendor-engine.mjs); Android's library compiles the Kotlin in place |
| Wire fixtures: one JSON file per request, exactly as sent | `packages/core/wire` | every SDK | Each SDK's golden test deep-compares its own request with the file |

The Dart core has a single user, so it lives inside the Flutter package
(`packages/flutter/lib/src/core`). The Swift and Kotlin cores of the native SDKs live in
`packages/ios` and `packages/android` for the same reason.

**Edit the engine in `packages/core`, never in a copy:** the next `pnpm install` or build overwrites
the copy. [`packages/core/README.md`](packages/core/README.md) explains the copies and where each
one goes, and [`packages/core/NATIVE_TESTING.md`](packages/core/NATIVE_TESTING.md) how to run the
engine's suites.

**The browser SDK is the baseline.** When two SDKs disagree on behaviour, the browser's is the
default, and the shared wire fixtures are how the others prove they match it.

## Repository layout

```
packages/
  browser/          @groundcover/browser
  react-native/     @groundcover/react-native
  flutter/          groundcover_rum
  ios/              GroundcoverRum (Swift package)
  android/          rum-android and its three integration modules (Gradle)
  core/             what more than one SDK runs: ts/, swift/, kotlin/, wire/
apps/
  playground/       Vite + React page for the browser SDK (the web e2e target)
  nextjs/           Next.js App Router app for the browser SDK
  rn-playground/    Expo app for the React Native SDK
  flutter-playground/  Flutter app for groundcover_rum
  ios-playground/   UIKit + SwiftUI app for the native iOS SDK
  android-playground/  Compose + Fragments app for the native Android SDK
  scripts/          dump-rum.sh, which reads a device run back from a cluster
  DEVICE_TESTING.md running a mobile playground against a real cluster
tests/e2e/
  playground/       Playwright suite for the browser SDK
  mobile/           Mobilewright suite shared by all four mobile playgrounds
scripts/            vendor-engine.mjs
assets/             the groundcover logo
patches/            pnpm patches, each with the condition for deleting it
changelog_unreleased/  one entry per merged change, until it is released
```

## Getting started

### Toolchains

You need only the ones for the lane you work on:

| Lane | Needs |
| --- | --- |
| Every lane | Node 24 and pnpm 9.15 (`corepack enable` picks the version in `package.json`) |
| Browser e2e | Playwright's browsers: `npx playwright install` |
| React Native | Xcode and CocoaPods; JDK 17 and the Android SDK |
| Flutter | The Flutter version `.github/workflows/flutter.yml` pins; Xcode; JDK 17 and the Android SDK |
| Native iOS | Xcode; XcodeGen for the playground (`brew install xcodegen`) |
| Native Android | JDK 17 and the Android SDK |

### Install

```bash
pnpm install
```

Besides installing dependencies, this writes the native engine copy every mobile SDK compiles
(`scripts/vendor-engine.mjs`, run by the root `prepare` script).

### Build, test and check

Run each check the way CI runs it; the workflow named in the CI table is the reference.

| What | Command |
| --- | --- |
| Build the JavaScript packages | `pnpm build` |
| Browser SDK + web playground + Next.js app, in watch mode | `pnpm dev` |
| Browser unit tests, lint, bundle size | `pnpm --filter @groundcover/browser test` |
| React Native unit tests, test typecheck, lint | `pnpm --filter @groundcover/react-native test` |
| TypeScript core | `pnpm --filter @groundcover/rum-core test` |
| Flutter | `flutter analyze` and `flutter test` in `packages/flutter` and in `apps/flutter-playground`; `dart format --output=none --set-exit-if-changed packages/flutter apps/flutter-playground` |
| Native iOS | in `packages/ios`: `xcodebuild test -scheme GroundcoverRum-Package -destination 'platform=iOS Simulator,name=<a simulator>'`; the public API check is `packages/ios/scripts/api-surface.sh` |
| Native Android | in `packages/android`: `./gradlew ktlintCheck lint apiCheck testDebugUnitTest` |
| Native engine | `packages/core/swift/run-engine-tests.sh`; in `packages/core/kotlin/jvm-test`: `./gradlew test` |
| Browser e2e | `pnpm run e2e` |
| Mobile e2e | `pnpm run e2e:<rn\|flutter\|native>:<ios\|android>` after building and installing the app: [`tests/e2e/mobile/README.md`](tests/e2e/mobile/README.md#run-locally) |

## CI

Each SDK has a lane. The web and mobile lanes look at the paths a change touches, run only the jobs
they need, and always report one gate check named after the lane; `Core CI` is a single job that
runs in full on every pull request. `Core CI` and `Web CI` run only for pull requests into `main`,
so a PR stacked on another branch reports them once it is retargeted to `main`.

| Workflow | Gate check | Covers |
| --- | --- | --- |
| [`core.yml`](.github/workflows/core.yml) | `Core CI` | The TypeScript core |
| [`web.yml`](.github/workflows/web.yml) | `Web CI` | The browser SDK: unit, lint, size, Playwright e2e |
| [`react-native.yml`](.github/workflows/react-native.yml) | `RN CI` | The RN SDK, the engine's unit suites, the app builds and the mobile e2e on both platforms |
| [`flutter.yml`](.github/workflows/flutter.yml) | `Flutter CI` | The Flutter SDK, the engine through both iOS integrations, the mobile e2e |
| [`native-ios.yml`](.github/workflows/native-ios.yml) | `Native iOS CI` | The iOS SDK: format, unit tests, API surface, the playground's locator contract, the mobile e2e |
| [`native-android.yml`](.github/workflows/native-android.yml) | `Native Android CI` | The Android SDK: ktlint, lint, API check, unit tests, the mobile e2e |

`Core CI`, `RN CI` and `Web CI` are required to merge into `main`.

## Releases

| Package | How it is published |
| --- | --- |
| `@groundcover/browser` | [`publish-browser.yml`](.github/workflows/publish-browser.yml), by hand: a release from `main`, a release candidate from `main` or from a branch, to test an integration before it merges. It publishes the version in `packages/browser/package.json`; a prerelease version publishes under its channel as the dist-tag (`2.2.0-rc.0` under `rc`), a stable one under `latest`. |
| `@groundcover/react-native` | [`publish-react-native.yml`](.github/workflows/publish-react-native.yml), by hand, from `main` or (for a release candidate) a branch, with the same version and dist-tag rules. |
| `groundcover_rum` | [`release-flutter.yml`](.github/workflows/release-flutter.yml), by hand on `main`. It reads the version from the pubspec, checks the package agrees on it, tags the commit `groundcover_rum-v<version>` and starts [`publish-flutter.yml`](.github/workflows/publish-flutter.yml) on that tag, which checks the tag is on `main`, runs the unit tests and a dry run, then publishes. pub.dev accepts a publish only from a run on a tag that matches its tag pattern, `groundcover_rum-v{{version}}`, and shows only the version. The first version, `0.0.1-rc.0`, was published by hand, as pub.dev requires for a first version. |
| `GroundcoverRum` (iOS) | [`release-ios.yml`](.github/workflows/release-ios.yml), by hand from `main`. It writes the package as [`groundcover-rum-ios`](https://github.com/groundcover-com/groundcover-rum-ios) ships it (`packages/ios/scripts/build-mirror.sh`), builds it on its own and from an app's package, then commits it to that repository, tags it `<version>` and tags `ios-v<version>` here. A dry run stops before pushing. |
| `com.groundcover:rum-android` and its integrations | [`release-android.yml`](.github/workflows/release-android.yml), by hand from `main`. It checks the version and the modules, signs and uploads all four artifacts to Maven Central, where they wait until someone publishes them in the Central Portal, and tags `android-v<version>`. |

npm and pub.dev publish through the registries' trusted publishing (OIDC), not stored tokens.
A GitHub App writes the iOS mirror; Maven Central takes a signing key and a portal token. Both
sets of credentials are readable only from the `ios-mirror` and `maven-central` environments.
Each package's `CHANGELOG.md` gets its entries when a version is released;
[`CONTRIBUTING.md`](CONTRIBUTING.md#changelog-entries) says where they come from.

## Contributing, security, license

- [`CONTRIBUTING.md`](CONTRIBUTING.md): how changes land here.
- [`SECURITY.md`](SECURITY.md): report vulnerabilities privately, not in an issue.
- [`LICENSE`](LICENSE): MIT. Each package carries its own copy.
