# Mobile e2e — layout

On-device specs for `@groundcover/react-native`, `groundcover_rum` and the native iOS and
Android SDKs, driven by Mobilewright against a real simulator/emulator. One suite serves every
playground (`apps/rn-playground`, `apps/flutter-playground`, and the native
`apps/ios-playground` and `apps/android-playground`), which expose the same screens, labels and
fixtures. This file covers how to run the suite locally, how one spec serves several apps, and
where the files sit and why. Each app's README has its e2e build:
[RN](../../../apps/rn-playground/README.md#build-and-install-for-e2e),
[Flutter](../../../apps/flutter-playground/README.md#build-and-install-for-e2e),
[iOS](../../../apps/ios-playground/README.md#build-and-install-for-e2e),
[Android](../../../apps/android-playground/README.md#build-and-install-for-e2e). Running a
playground against a real cluster instead of the mock is
[`apps/DEVICE_TESTING.md`](../../../apps/DEVICE_TESTING.md).

## One suite, three apps

`APP=flutter` selects the Flutter app and `APP=native` the native ones (the iOS playground on
iOS, the Android one on Android); unset, the suite drives RN. The root `mobilewright.config.ts`
names each app's projects for it (`rn-ios`, `flutter-android`, `native-ios`, …), and only the
selected app's exist:

```bash
pnpm run e2e:rn:ios            # mobilewright test --project rn-ios
pnpm run e2e:flutter:android   # APP=flutter mobilewright test --project flutter-android
pnpm run e2e:native:ios        # APP=native mobilewright test --project native-ios
```

- **What differs between the apps** lives in `support/app.ts` and nowhere else: the
  bundle ID, how a preset is chosen, which Logs control logs through the platform,
  the error type, gesture capture sources. A spec reads it from there instead of
  hard-coding RN's value.
- **Which tests apply** is a tag: `@rn-only` (console.*, XHR, axios, accessibility
  values), `@flutter-only` (debugPrint, dart:io, dio, a Dart-thread stall),
  `@hybrid-only` (RN and Flutter alone: a framework's handler for an uncaught error the
  app survives, which in a native app is a crash), `@native-app-only` (the native SDKs
  alone: their HTTP clients, UIKit and Fragment screens, an Android dialog), and
  `@native` (needs the native engine, which every app has). Each profile in
  `support/app.ts` lists the tags it skips (`skipTags`), and the config turns that
  list into its projects' `grepInvert`: RN skips `@flutter-only` and
  `@native-app-only`, Flutter skips `@rn-only` and `@native-app-only`, the native apps
  skip `@rn-only`, `@flutter-only` and `@hybrid-only`. Every test an app doesn't skip
  runs against it and has to pass. A portable test that also checks a native signal
  gates that part on `hasNativeEngine` instead of being tagged.
- **Pending marks** exist only while an SDK feature is in progress: a test an SDK can't
  pass carries `test.fail(isFlutter, "pending: …")`, on one line, naming what it waits
  on, and the change that makes it pass deletes the mark. A marked test that starts
  passing fails the run, so the marks can't go stale. Flutter CI fails on any mark left
  in a PR that is out of draft. The native apps carry none: every test
  their tags select has to pass. A test that sits out its waits past its own timeout is
  not an expected failure, so it is a `test.fixme` with the reason instead.
- **Presets** differ by channel, which `support/preset.ts` picks once from the app
  profile: RN rewrites a source file for Metro to re-bundle
  (`support/preset-metro.ts`), Flutter and the native apps get `e2e-preset.json`
  written into their data (`support/preset-data-file.ts`). Both relaunch and wait for
  the app to read the preset back.

## Run locally

Every command runs from the **repo root**. The mock ingest starts by itself in the suite's global
setup, on **:9393** with its echo endpoint on **:9394**; you never start it. Each app is built with
its DSN pointing at the host as the platform reaches it: `localhost` from the iOS simulator,
`10.0.2.2` from the Android emulator.

### Prerequisites (one-time)

- `pnpm install` at the repo root. It also writes the native engine copy every SDK compiles (see
  [`packages/core/README.md`](../../../packages/core/README.md)).
- **iOS:** Xcode with an iOS simulator runtime. The suite picks a simulator whose name contains
  `iPhone`. RN also needs CocoaPods (`brew install cocoapods`), and the native app needs XcodeGen
  (`brew install xcodegen`).
- **Android:** JDK 17, the Android SDK (platform-tools, the emulator, an API 34 system image) and
  an AVD. Use an `arm64-v8a` image on Apple Silicon and `x86_64` on Intel or Linux; CI runs
  `x86_64`. Export `JAVA_HOME` and `ANDROID_HOME` for every command; with Homebrew that is:
  ```bash
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17
  export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
  ```
  Without `ANDROID_HOME` nothing errors: the driver lists only iOS simulators, and every Android
  test times out while setting up `device`. Check `npx mobilecli devices` lists the emulator.
- **Flutter:** the Flutter version `.github/workflows/flutter.yml` pins.

If `xcodebuild` says it "requires Xcode" although Xcode is installed, the active developer
directory still points at the Command Line Tools. Fix it once with
`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`, or per command with
`export DEVELOPER_DIR=<path to Xcode.app>/Contents/Developer`. A fresh Xcode has no simulator
runtimes: open it once, or run `xcodebuild -downloadPlatform iOS`.

### 1. Boot a device

```bash
# iOS. Wait for bootstatus: the driver starts WebDriverAgent on connect (slow when cold), and a
# half-booted simulator times out the first specs.
DEVICE=$(xcrun simctl list devices available | grep -m1 "iPhone" | grep -oE "[0-9A-F-]{36}")
xcrun simctl boot "$DEVICE" || true
xcrun simctl bootstatus "$DEVICE"

# Android. A software GPU and no snapshot match CI; drop -no-window to watch it.
emulator -avd <your AVD> -gpu swiftshader_indirect -no-boot-anim -noaudio -no-snapshot -no-window &
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
```

### 2. Build and install the app

Follow the app's "Build and install for e2e" section (links at the top). Then launch it once on
iOS, so its UI is up before the driver connects:
`xcrun simctl launch booted <bundle id>`. The bundle IDs are `com.groundcover.rumplayground`,
`com.groundcover.flutterplayground` and `com.groundcover.nativeplayground`.

### 3. Run the suite

| App | iOS | Android |
| --- | --- | --- |
| RN | `pnpm run e2e:rn:ios` | `pnpm run e2e:rn:android` |
| Flutter | `pnpm run e2e:flutter:ios` | `pnpm run e2e:flutter:android` |
| Native | `pnpm run e2e:native:ios` | `pnpm run e2e:native:android` |

One spec, or a grep, runs the same way:

```bash
APP=flutter npx mobilewright test --project=flutter-ios tests/e2e/mobile/api/
npx mobilewright test --project=rn-android -g "rotates the session"
```

Tests an app can't run are skipped or `fixme`d where they sit, each with its reason (a gesture the
driver can't synthesize, a check that needs `adb root`, and so on).

On Android, `tests/e2e/mobile/ci-android-e2e.sh` (RN), `ci-flutter-android-e2e.sh` and
`ci-native-android-e2e.sh` are the exact bodies CI runs, and they also run against a booted local
emulator. The Flutter and native scripts take the APK to install from `APK` (their headers show
the command). The RN script starts Metro from your environment, so export the e2e values first:

```bash
export EXPO_PUBLIC_GC_DSN=http://10.0.2.2:9393 EXPO_PUBLIC_GC_API_KEY=e2e-key EXPO_PUBLIC_GC_PRESET=
bash tests/e2e/mobile/ci-android-e2e.sh
```

**When the RN script exits, it kills every emulator (`qemu-system`) and every `expo start` on the
machine**, other checkouts' included: CI needs that to end the job, and it isn't gated on `CI`. It
reuses a prebuilt APK only when you opt in with `APK_CACHE_HIT=true`, since nothing locally ties
an old APK to the current native sources (the rule is `should_reuse_apk` in `apk-reuse.sh`).

### Gotchas

- **Terminate the other platform's app before you switch.** A playground left running on a
  simulator or emulator keeps posting to the mock ingest, and its batches interleave with the app
  under test. Positive assertions survive that; negative ones ("an untouched launch sends
  nothing", "one session id across the run") fail and point at the SDK.
  `00-bootstrap/02-foreign-reporter.spec.ts` catches it once, early, so clean up rather than rely
  on it:
  ```bash
  xcrun simctl shutdown all
  adb shell am force-stop <bundle id>
  ```
- **Native changes need the app rebuilt.** Restarting Metro or relaunching only reloads RN's
  JavaScript. An engine change (`packages/core/swift`, `packages/core/kotlin`) also needs
  `node scripts/vendor-engine.mjs` before the build. If a native change seems to do nothing,
  check the build actually ran.
- **RN: one Metro, one platform, one checkout.** `EXPO_PUBLIC_*` is inlined when Metro bundles, so
  switching platforms means restarting Metro with the other DSN. A Metro left running by another
  checkout owns :8081 and serves *its* bundle, so the suite tests code you didn't write; check
  `ps aux | grep 'expo start'`.
- **RN: never start Metro with `CI=true`.** Expo turns the file watcher off ("Metro is running in CI
  mode, reloads are disabled"), so the preset specs in `zz-perturbing/` never see their rewritten
  preset and fail their readback gate. GitHub Actions sets `CI=true`, which is why RN CI (the
  iOS job and `ci-android-e2e.sh`) starts Metro with `CI=false`.
- **RN: `EXPO_PUBLIC_GC_PRESET=` (empty) is deliberate** in the e2e scripts. An empty shell value
  beats a `device` preset in a developer's `.env`, which would otherwise boot against the mock.
- **RN Android: `adb reverse tcp:8081 tcp:8081`** lets the app reach Metro. `expo run:android` sets
  it; an app started any other way shows a blank screen until you do.
- **RN iOS: `expo run:ios` can fail after a successful install**, at the AppleScript step that
  brings the Simulator window forward. If the log shows the app installed, launch it with
  `xcrun simctl launch booted com.groundcover.rumplayground` and carry on.
- **Android: a cold emulator can be slow to draw the first screen**, and an emulator can degrade
  over repeated full runs, so that a different spec fails each time as "the app or the device was
  not there" and passes alone. Reboot the emulator between full runs.

### How CI differs

Each lane (`react-native.yml`, `flutter.yml`, `native-ios.yml`, `native-android.yml`) builds its
app once and runs the suite in three shards per platform (see Sharding below). iOS runs on a fresh
`iPhone 17 Pro` simulator on the iOS 26.5 runtime and warms WebDriverAgent in an unsharded step
first. Android boots an API 34 `x86_64` `pixel_6` emulator from a cached snapshot on a Linux
runner with KVM. RN caches the built `.app` and APK keyed on the native sources, so a JS- or
spec-only change reuses the binary.

The engine's UIKit-facing files are not unit-tested (see
[`packages/core/NATIVE_TESTING.md`](../../../packages/core/NATIVE_TESTING.md)); this suite is the
only coverage they have.

## Layout

```
00-bootstrap/    gates that must pass before anything else is worth running
api/             the public JS surface — logs, custom events, identity, config
crashes/         exceptions, hang watchdog, native crash reporting
envelope/        the wire shape every event shares
interactions/    taps, gestures, accessibility metadata, navigation
network/         request capture, and the SDK's own traffic
session/         session identity across launches, gaps and rotation
vitals/          app start, frame vitals, overhead
zz-perturbing/   specs that leave the app in a state nothing else may inherit
support/         mock ingest, preset control, UI + device helpers, global setup
```

## Two kinds of test live here

`*.spec.ts` are **device specs** — mobilewright drives a real simulator or
emulator. `support/*.test.ts` are **plain unit tests** over the harness's own
judgements: where to tap a control the tab bar overlaps, whether a batch came
from a foreign reporter, whether the ingest ever went quiet. Those are the parts
that can be wrong independently of any device.

```bash
pnpm --filter @groundcover/react-native exec vitest run \
  --config tests/e2e/mobile/support/vitest.config.ts
```

They run next to the e2e typecheck, in RN CI's `lint` job and again in Flutter CI's
`e2e-typecheck` job, since each lane's gate stands alone — seconds, no device. Both
borrow the react-native package's own toolchain rather than adding a root
dependency, because `pnpm-lock.yaml` is hashed into the prebuilt iOS/Android app
cache keys and a new entry there evicts both.

The split is enforced in `mobilewright.config.ts`, which pins `testMatch` to
`**/*.spec.ts`. Playwright's default also matches `*.test.ts`, which would hand
these unit tests to the device runner.

## The two directory names that are load-bearing

`00-bootstrap` and `zz-perturbing` are **not** stylistic. Renaming either — or
moving a spec across that boundary — changes the order the suite runs in, and the
failures that follow do not point back here.

Mobilewright runs on Playwright's runner with `workers: 1` and
`fullyParallel: false`. Playwright collects files by walking the test directory
depth-first, sorting each directory's entries — **files and subdirectories
together** — with `localeCompare`. So a directory name competes with its sibling
filenames for position, and everything under a directory lands as one contiguous
block. `00-bootstrap` sorts before every other entry; `zz-perturbing` sorts after
every other entry. That is the whole mechanism.

**`00-bootstrap/` must run first.** Its specs are ordered among themselves by
the `00-`/`01-`/`02-`/`03-` prefixes, and each one exists so that a single failure names
a cause instead of scattering:

- `00-warmup` absorbs WebDriverAgent's slow cold start, which would otherwise hit
  whichever spec happened to sort first as an unexplained `RpcError`.
- `01-native-preflight` proves the native module resolved. When it has not, every
  native signal degrades to silence — the correct behaviour in Expo Go, and
  indistinguishable from an app that simply has not reported yet.
- `02-foreign-reporter` fails the run when a device other than the one under test
  is posting to the mock ingest. A stray simulator falsifies every negative
  assertion in the suite, and does it plausibly.
- `03-flutter-tree` (Flutter only) checks the locator idioms the specs rely on
  against the tree mobilecli reads for this run, and attaches that tree.

**`zz-perturbing/` must run last.** These specs leave the app somewhere the next
spec must not start from: a rewritten config preset that only takes effect on
relaunch, a repeatedly reloaded JS bundle, a process sent to the background. They
each restore what they changed, but restoration lands on the *next* launch, so the
guarantee that matters is positional.

Everything in between is order-independent by construction — each spec clears the
ingest and establishes its own preconditions rather than inheriting a predecessor's.
Group new specs by subject; only reach for the two ordered directories when a spec
genuinely gates the suite or genuinely perturbs it.

## Sharding

CI runs `--shard=N/3` on both platforms. Playwright shards by *test count* over the
file order above, in contiguous slices of whole files, so each shard is a
sub-sequence of the global order — which is what makes "perturbing sorts last" hold
inside every shard as well as across the run. Two consequences worth knowing:

- The bootstrap specs only run in shard 1. iOS therefore warms WebDriverAgent in a
  separate unsharded step (`.github/workflows/react-native.yml`) so shards 2 and 3
  do not each pay the cold start.
- Shard boundaries move whenever files are added or renamed. Nothing depends on a
  particular file landing in a particular shard, and nothing should.

Verify the order after any reshuffle, without needing a device:

```bash
npx mobilewright test --project=rn-ios --list
APP=flutter npx mobilewright test --project=flutter-ios --list
APP=native npx mobilewright test --project=native-ios --list
```
