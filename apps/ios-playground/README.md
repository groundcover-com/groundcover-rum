# ios-playground

The native iOS app the shared Mobilewright e2e suite ([`tests/e2e/mobile`](../../tests/e2e/mobile))
drives with `APP=native`: a screen-for-screen mirror of [`apps/rn-playground`](../rn-playground) and
[`apps/flutter-playground`](../flutter-playground), wired to the native SDK in
[`packages/ios`](../../packages/ios) from source. Bundle ID `com.groundcover.nativeplayground`, the
same as the Android playground's.

| Tab | Screen | Toolkit | What the specs drive there |
| --- | --- | --- | --- |
| Taps | Home → Detail | SwiftUI; Detail is a pushed UIKit view controller | Labelled, bare and private buttons, an annotated button, a text field, a stack push |
| Network | Network | SwiftUI | requests through the explicit API under RN's "fetch" labels, with large and sensitive ones; plain URLSession, recorded by the hook, for the abort, the failing request, and completion, delegate and async/await calls on paths of their own |
| Logs | Logs | SwiftUI | swift-log through `GroundcoverLogHandler`, `Groundcover.logger`, handled errors, an uncaught exception (a crash), sensitive payloads |
| Custom | Custom | SwiftUI | A custom event, a user identity, the session id |
| Native | Native | SwiftUI; the modal is a presented UIKit view controller | Crash and main-thread hang triggers, a modal and a 60-row list for gestures |
| Config | Config | SwiftUI | The preset readback, `beforeSend` targets, the rest of the public API, session hooks |

The shell is UIKit: the tab bar is the app's own, each tab one accessibility element labelled
`<Name> tab`, and a tab switch replaces the screen. The SwiftUI screens are named with
`groundcoverScreen`.

## Build and install for e2e

The project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`); `NativePlayground.xcodeproj` is build output and git-ignored. The SDK
compiles a git-ignored copy of the native engine from `packages/core`, which `pnpm install` at the
repo root writes; after an engine edit, or in a clone that never ran it, write it first.

```bash
node ../../scripts/vendor-engine.mjs
./generate.sh
xcodebuild build -project NativePlayground.xcodeproj -scheme NativePlayground \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/NativePlayground.app
```

The build settings in `project.yml` default to the e2e environment: the mock ingest on :9393, which
the simulator reaches as `localhost`, and the key `e2e-key`. After start the app prints
`native-playground: ready (preset: <name>)`.

`generate.sh` copies `Package.resolved` into the project, so the app builds against the KSCrash and
swift-log versions pinned there. To move them, resolve in Xcode and copy the project's
`project.xcworkspace/xcshareddata/swiftpm/Package.resolved` back over it.

## Locator contract

`UITests/LocatorContractTests.swift` walks every tab and finds each label and test ID the shared
suite locates, the way Mobilewright matches them on iOS. A rename fails it before a device run:

```bash
xcodebuild test -project NativePlayground.xcodeproj -scheme NativePlayground \
  -destination 'platform=iOS Simulator,name=<a simulator>'
```

## Presets

`Sources/Presets.swift` mirrors the other playgrounds' presets. A spec picks one by writing
`{"preset": "<name>"}` to `e2e-preset.json` in the app's Documents directory and relaunching, as for
Flutter: Mobilewright can't pass launch arguments. The Config tab shows `preset: <name>`, which the
spec waits for. A preset compiled in with the `GC_PRESET` build setting wins over the file.

## Device runs against a real cluster

`device` is the one preset not tuned for the mock ingest; follow
[`apps/DEVICE_TESTING.md`](../DEVICE_TESTING.md) for the key check and
reading the stores back. The values go in `device.xcconfig` beside this README, which is
git-ignored, and the build reads it only when named with `-xcconfig`, so the key stays out of the
repo, the command line and every other build. An xcconfig reads `//` as a comment, so the DSN is
the bare host; the SDK adds `https://`:

```
GC_DSN = <ingest host, e.g. your-cluster.groundcover.com>
GC_API_KEY = <ingest key>
GC_PRESET = device
GC_RELEASE_ID = <something that tells this build apart>
```

```bash
xcodebuild build -project NativePlayground.xcodeproj -scheme NativePlayground \
  -destination 'generic/platform=iOS' DEVELOPMENT_TEAM=<your team> -xcconfig device.xcconfig
```

Add `GC_DEBUG = 1` for the SDK's debug log, which prints every batch unredacted.
