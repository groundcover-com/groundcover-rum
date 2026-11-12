# android-playground

The native Android app the shared Mobilewright e2e suite ([`tests/e2e/mobile`](../../tests/e2e/mobile))
drives with `APP=native`: a screen-for-screen mirror of [`apps/rn-playground`](../rn-playground) and
[`apps/flutter-playground`](../flutter-playground), wired to the native SDK in
[`packages/android`](../../packages/android) from source. Application ID
`com.groundcover.nativeplayground`, the same as the iOS playground's bundle ID.

| Tab | Route | Toolkit | What the specs drive there |
| --- | --- | --- | --- |
| Taps | Home → Detail | Compose; Detail is a Fragment | Labelled, bare and private buttons, an annotated button, a text field, a stack push |
| Network | Network | Compose | OkHttp requests under RN's "fetch" labels; abort, large, failing and sensitive requests; enqueue, execute and a derived client on paths of their own |
| Logs | Logs | Compose | Timber through `GroundcoverTree`, `Groundcover.logger`, handled errors, an uncaught exception (a crash), sensitive payloads |
| Custom | Custom | Compose | A custom event, a user identity, the session id |
| Native | Native, Cart | Compose; the modal is a Dialog, the checkout a layer with a NavHost of its own | Crash and main-thread hang triggers, a modal and a 60-row list for gestures, a checkout flow to close |
| Config | Config | Compose | The preset readback, `beforeSend` targets, the rest of the public API, session hooks |

One `FragmentActivity` holds a Compose `NavHost` whose routes are the screen names, watched by
`GroundcoverNavigationEffect`, so a tab switch is a navigation. Detail is a View-based Fragment shown
through `AndroidFragment`, so the SDK's Fragment hook has one to see; the modal is a Compose
`Dialog`, a window of its own rather than an Activity's. The checkout is a layer over the Native
screen with a second NavHost and `GroundcoverNavigationEffect`; closing it leaves the first NavHost
on Native, so the SDK has to make Native the screen again itself.

## Build and install for e2e

The SDK comes from source: `settings.gradle.kts` includes `packages/android` and substitutes its
four modules for the `com.groundcover` coordinates an app would use from Maven Central. The engine
compiles straight from `packages/core/kotlin`, so there is nothing to vendor first.

```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The build defaults to the e2e environment: the mock ingest on :9393, which the emulator reaches as
`10.0.2.2`, and the key `e2e-key`. The debug build's network security config allows cleartext to
`10.0.2.2` and `127.0.0.1` alone. Once the first frame is up the app logs
`native-playground: ready (preset: <name>)`, which CI's Android script waits for in logcat.

## Locator contract

`app/src/test/.../LocatorContractTest.kt` walks every tab under Robolectric and finds each label,
text and test tag the shared suite locates, on the merged semantics tree a device's accessibility
service reads. A rename fails it before a device run: `./gradlew testDebugUnitTest`.

## Presets

`ConfigPresets.kt` mirrors the other playgrounds' presets. A spec picks one by writing
`{"preset": "<name>"}` to `files/e2e-preset.json` in the app's data (`adb shell run-as`) and
relaunching, as for Flutter: Mobilewright can't pass launch arguments. The Config tab shows
`preset: <name>`, which the spec waits for. A preset compiled in with `-PgcPreset=<name>` wins over
the file.

## Device runs against a real cluster

`device` is the one preset not tuned for the mock ingest; follow
[`apps/DEVICE_TESTING.md`](../DEVICE_TESTING.md) for the key check and
reading the stores back. The values go in `device.properties` beside this README, which is
git-ignored, and the build reads it only when named, so the key stays out of the repo, the command
line and every other build:

```properties
gcDsn=<ingest host, e.g. your-cluster.groundcover.com>
gcApiKey=<ingest key>
gcPreset=device
gcReleaseId=<something that tells this build apart>
```

```bash
./gradlew assembleDebug -PgcEnvFile=device.properties
```

Add `gcDebug=1` for the SDK's debug log, which prints every batch unredacted.
