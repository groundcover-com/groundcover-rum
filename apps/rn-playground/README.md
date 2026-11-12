# rn-playground

The Expo app the shared Mobilewright e2e suite ([`tests/e2e/mobile`](../../tests/e2e/mobile))
drives by default, wired to `@groundcover/react-native` from this repo. Bundle ID
`com.groundcover.rumplayground` on both platforms. Expo SDK 57, React Native 0.86, React 19.2,
New Architecture.

**Use a native build, never Expo Go.** Expo Go loads the app happily, which is the trap: the SDK's
Swift and Kotlin modules aren't in it, so crashes, hangs, app start, frame vitals, native gestures
and the real device model all silently do nothing while the JavaScript half works. Nothing errors.
`expo run:<platform>` (and every script below) prebuilds and installs a real native build.

| Tab | Route | What the specs drive there |
| --- | --- | --- |
| Taps | Home → Detail | Labelled, bare and private buttons, an annotated button, a text field, a stack push |
| Network | Network | `fetch`, XHR and axios requests; abort, large, failing and sensitive requests |
| Logs | Logs | `console.*`, `groundcover.logger.*`, handled, uncaught and rejected errors, sensitive payloads |
| Custom | Custom | A custom event, a user identity, the session id |
| Native | Native | Native crash and main-thread hang triggers, a modal and a 60-row list for gestures |
| Config | Config | The preset readback, `beforeSend` targets, the rest of the public API, session hooks |

## Run

```bash
# From the repo root. The app bundles the SDK's built dist/, not its src/.
pnpm --filter @groundcover/react-native build
pnpm --filter rn-playground ios          # or: android
```

Rebuild the SDK (or run its `build:watch`) after changing it: a device that shows stale behaviour
after an edit is almost always running the old `dist/`. The `ios`, `android` and `prebuild`
scripts write the native engine copy first (`scripts/vendor-engine.mjs`), so an engine edit
reaches the next build.

## Build and install for e2e

```bash
# From the repo root, with a simulator or emulator booted.
pnpm --filter @groundcover/react-native build
pnpm --filter rn-playground run e2e:app:ios        # DSN → localhost:9393
pnpm --filter rn-playground run e2e:app:android    # DSN → 10.0.2.2:9393
```

Each builds, installs and launches the app and starts Metro with the e2e environment (the mock
ingest's DSN, the key `e2e-key` and an empty preset). Leave Metro running and start the suite from
another terminal: [`tests/e2e/mobile/README.md`](../../tests/e2e/mobile/README.md#run-locally).

`apps/rn-playground/ios/` and `android/` are generated and git-ignored. Deleting them forces a
clean prebuild, the first thing to try when a native build goes strange.

## Presets

`src/config-presets.ts` holds the presets every playground mirrors. A spec picks one by rewriting
`src/e2e-preset.ts`, which Metro re-bundles, and relaunching the app. The Config tab shows
`preset: <name>`, which the spec waits for. `EXPO_PUBLIC_GC_PRESET` in `.env` wins over the file,
for manual runs; a name outside the list fails at launch.

## Device runs against a real cluster

Follow [`apps/DEVICE_TESTING.md`](../DEVICE_TESTING.md) for the key check, the order of the stages
and reading the stores back. The values go in `.env` (git-ignored); start from `.env.example`:

```bash
cp apps/rn-playground/.env.example apps/rn-playground/.env
```

```
EXPO_PUBLIC_GC_DSN=<ingest host>
EXPO_PUBLIC_GC_API_KEY=<ingest key>
EXPO_PUBLIC_GC_PRESET=device
EXPO_PUBLIC_GC_RELEASE_ID=<something that tells this build apart>
```

`.env` is the right home rather than shell exports: a release build runs the bundler as a Gradle
subprocess, which may not inherit a freshly exported variable. Only the static
`process.env.EXPO_PUBLIC_*` names are inlined, so the list is fixed.

### Android

```bash
pnpm --filter @groundcover/react-native build
pnpm --filter rn-playground device:android        # release build, installed over USB
pnpm --filter rn-playground device:android:apk    # or an APK to hand to someone
```

The APK lands at `android/app/build/outputs/apk/release/app-release.apk` and embeds its bundle, so
it needs no Metro and no cable. It is signed with the Expo template's debug keystore, so Play
Protect warns on install. Build release, not debug: R8 minification is where reflection-based
native code breaks, and only a release build exercises the SDK's consumer rules.

### iOS

`device:ios` needs a one-time setup, because it signs for your phone and `ios/` doesn't exist in a
fresh clone:

```bash
cd apps/rn-playground
npx expo prebuild --platform ios       # generates the git-ignored ios/
open ios/*.xcworkspace                 # set your team and a bundle ID unique to you
```

Then every build needs three values, and the script fails fast without them:

```bash
GC_IOS_DEVICE_ID=<udid from: xcrun xctrace list devices> \
GC_IOS_TEAM=<10-character Apple team id> \
GC_IOS_BUNDLE_ID=<the bundle ID you set> \
  pnpm --filter rn-playground device:ios
```

Re-running `expo prebuild` resets the bundle ID, so keep a clean prebuild for when you need one.

## pnpm and Metro

`metro.config.js` is set up for the pnpm workspace (`watchFolders`, `nodeModulesPaths`,
`disableHierarchicalLookup`). If Metro can't resolve a transitive dependency of the SDK, add it to
this app's `dependencies`.
