# flutter-playground

The Flutter app the shared Mobilewright e2e suite ([`tests/e2e/mobile`](../../tests/e2e/mobile))
drives: a screen-for-screen mirror of [`apps/rn-playground`](../rn-playground), wired to
`groundcover_rum`. Bundle ID `com.groundcover.flutterplayground` on both platforms.

| Tab | Route | What the specs drive there |
| --- | --- | --- |
| Taps | Home → Detail | Labelled, bare and private buttons, an annotated button, a text field, a stack push |
| Network | Network | package:http ("fetch"), dart:io and dio requests; abort, large, failing and sensitive requests |
| Logs | Logs | `debugPrint`, `GroundcoverRum.logger`, handled and uncaught errors, sensitive payloads |
| Custom | Custom | A custom event, a user identity, the session id |
| Native | Native | Native crash and main-thread hang triggers, a Dart-thread stall, a modal and a 60-row list for gestures |
| Config | Config | The preset readback, `beforeSend` targets, the rest of the public API, session hooks |

## Build and install for e2e

The DSN and API key are compiled in from `e2e/<platform>.json`. The mock ingest listens on :9393 on
the host, which the iOS simulator reaches as `localhost` and the Android emulator as `10.0.2.2`.

The SDK compiles a git-ignored copy of the native engine from `packages/core`. `pnpm install` at the
repo root writes it; after an engine edit, or in a clone that never ran it, write it first with
`node ../../scripts/vendor-engine.mjs` (from this directory).

```bash
flutter build ios --simulator --debug --dart-define-from-file=e2e/ios.json
xcrun simctl install booted build/ios/iphonesimulator/Runner.app

flutter build apk --debug --target-platform android-arm64 --dart-define-from-file=e2e/android.json
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

Use `--target-platform android-x64` for x86_64 emulators (CI). The iOS simulator only runs debug
builds. After init the app prints `flutter-playground: ready (preset: <name>)`, which CI's Android
script waits for in logcat.

## Presets

`lib/config_presets.dart` mirrors rn-playground's presets. A spec picks one by
writing `{"preset": "<name>"}` to `e2e-preset.json` in the app's documents directory and
relaunching: Flutter has no hot bundle to rewrite, and Mobilewright can't pass launch arguments.
The Config tab shows `preset: <name>`, which the spec waits for. A compiled-in
`--dart-define=GC_PRESET=<name>` wins over the file, for manual runs.

## Device runs against a real cluster

`device` is the one preset not tuned for the mock ingest; follow
[`apps/DEVICE_TESTING.md`](../DEVICE_TESTING.md) for the key check, the
order of the stages and reading the stores back. The values go in a JSON file kept out of the
repo, since the key is compiled into the app:

```json
{
  "GC_DSN": "<ingest host, e.g. your-cluster.groundcover.com>",
  "GC_API_KEY": "<ingest key>",
  "GC_PRESET": "device",
  "GC_RELEASE_ID": "<something that tells this build apart>"
}
```

Build with `--dart-define-from-file=<that file>` in place of `e2e/<platform>.json`. Sessions land
under cluster `playground`, environment `device-test`. `GC_DEBUG=1` prints every batch,
unredacted, to the device log.

A physical iPhone needs signing, and the project ships without a team: pick yours under
*Signing & Capabilities* in `ios/Runner.xcworkspace`, with a bundle ID unique to you.

## Rules for growing the app

The e2e specs find controls through the accessibility tree, so labels are an API:

- Mirror rn-playground's locator strings exactly, with the same label-versus-text split
  (`getByLabel` targets vs `getByText` targets). A label that replaces the visible text is
  `Text(semanticsLabel:)`, RN's `accessibilityLabel`.
- Tabs: an explicit `Semantics(label: "<Name> tab", excludeSemantics: true)`, never Material
  `NavigationBar` (it appends "Tab N of M").
- IDs: `Semantics(identifier: ...)` around the control. Never `MergeSemantics`: the merged node is
  missing from the tree mobilecli reads.
- Text fields: locate by test ID. Android's native tree carries a field's label as its hint, which
  `getByLabel` doesn't read.
- Route names must match RN's: Home, Detail, Network, Logs, Custom, Native, Config. Tabs are routes,
  so a tab switch is a navigation the SDK's observer sees.
- The widget names `HomeScreen`, `Card` and `Button` are asserted in component paths.
- Add every new locator to `test/locator_contract_test.dart`, so a rename fails `flutter test`
  instead of a device run.

```bash
flutter analyze
flutter test
```
