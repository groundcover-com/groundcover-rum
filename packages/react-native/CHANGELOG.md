# Changelog

All notable changes to `@groundcover/react-native` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.0.1-rc.6] — 2026-11-15

Seventh release candidate. No breaking changes from `0.0.1-rc.5`, and no changes to the SDK's
behaviour.

### Changed

- **The README says which crash reporters run alongside this SDK.** One with handlers of its own
  does. One built on KSCrash, which is one per process, doesn't: only one of the two captures
  native crashes on iOS, and if this SDK installs first, the other may delete its unsent crash
  reports. Start such a reporter before this SDK, or leave its crash reporting out.

## [0.0.1-rc.5] — 2026-11-05

Sixth release candidate. No breaking changes from `0.0.1-rc.4`. Run `pod install` after upgrading.

### Changed

- **A value that isn't an `Error` is described by its shape, as on the web.** An object passed to
  `captureException`, thrown or rejected with was reported as its JSON, so its issue split whenever
  a field such as a request id changed. It is now described by its keys, class name or item count
  (`Object captured as exception with keys: code, requestId`), the message `@groundcover/browser`
  gives it, and the value is sent in `error_metadata.captured_value`, redacted field by field and
  cut at 10,000 characters. An object with a string `message` keeps its own name, message and stack.
  `null` and `undefined` are reported as `null` and `undefined` instead of `Unknown error`. Issues
  for such values start new groups once.
- **`error_message` is capped at 10,000 characters**, as log messages are. The fingerprint, made
  from the first 400 characters, is unchanged.
- **Fewer idle wakeups on iOS.** The hang watchdog's monitor thread looks at the main thread's
  heartbeat a fifth of the threshold apart (0.4 s at the default 2 s) instead of every 0.1 s while
  it waits for a stall. The heartbeat, and the wait for a stall to end, stay at 0.1 s, so hang
  starts and durations are as precise as before; a stall that ends within one monitor interval of
  the threshold can go unnoticed.
- **Android consumer rules no longer keep Kotlin metadata for the whole app.** The rule served
  nothing in the SDK and kept every minified app's own Kotlin metadata.
- **One groundcover SDK per app.** The READMEs now say that an app can't run the React Native or
  Flutter SDK alongside groundcover's native iOS or Android SDK.
- **The README matches the SDK.** Leaving `"exceptions"` out of `enabledEvents` turns off
  uncaught-error capture and `captureException` too, not only rejection tracking.
  `sessionSampleRate`, `native` and part of `debug` are read once at `init`, so `updateConfig` can't
  change them. `beforeSend` and `enrichEvent` see seven event kinds, `performance` included. A new
  App start section covers cold, warm, hot and time-to-interactive starts, and bare React Native
  apps get their `pod install` step. Nothing is sent until the user confirms the session, and on iOS
  a hang is caught reliably only past the threshold plus a fifth of it (2.4 s at the default).
- **`maskErrors` is documented as it works.** It redacts error messages and metadata; stack frames
  are sent as they are.
- **The package `homepage` is the current documentation URL.**

### Fixed

- **App start on iOS: no cold start lost, no launch reported as a hot start.** The engine reported a
  launch's cold start only when it was already drawn as the SDK started; an app that initializes the
  SDK during `didFinishLaunching` lost its `app_start_cold` and time to interactive. It now waits
  for the first frame. A scene-based app (SwiftUI, or UIKit with a scene manifest) no longer reports
  an `app_start_hot` for its own launch, and a launch the system made in the background (a push, a
  background refresh), or one sent to the background before its first frame, reports no cold start.
- **Android frame vitals and app start follow the app, not each Activity.** Frame segments close as
  `background` only when the app leaves the foreground, and restart only when it returns: a
  permission or biometric prompt no longer discards the screen's frames, and opening another
  Activity no longer files a `background` segment while the app stays visible. A new Activity in a
  running app, or one recreated by a rotation, dark-mode or locale change, is no longer reported as
  an `app_start_warm` or `app_start_hot`.
- **iOS crash stacks from release builds can be symbolicated.** A native crash's frames carried only
  the slid address, and the app's load address was read from a key KSCrash never writes, so a
  stripped build's frames could never be mapped to its dSYM. Frames are now the symbol and the
  offset into it, else the image and the offset into it (`MyApp + 0x2334`), and the load address is
  recorded from the app's binary image.
- **iOS NSException and C++ crashes start where they were thrown.** KSCrash 2.6 keeps the throw site
  apart from the crashed thread, whose stack opens with the runtime's terminate handling (and, for
  an exception thrown in a dispatched block, can lose the throw site entirely). The crash's frames
  now come from the throw site when KSCrash recorded one.
- **iOS leaves the app's C++ exceptions alone.** The crash reporter no longer rebinds `__cxa_throw`
  in every loaded image, which could break apps and libraries that throw and catch their own C++
  exceptions. With KSCrash 2.6, the version resolved at release, a C++ crash still records where it
  was thrown.
- **Android reports only the main process's deaths.** An ANR or native crash in one of the app's
  other processes (`:push`, `:media`) is no longer reported as a fatal in the user's session.
- **A value's nested secrets are redacted.** A non-`Error` value's JSON was scrubbed as free text,
  which missed the fields nested under a sensitive key such as `token` or `credit_card` after the
  first one.
- **A promise rejected with a value the SDK can't read no longer crashes the app.** A Proxy whose
  property reads throw, one revoked before the rejection was reported, or a function whose
  `toString` throws made the SDK throw inside the engine's rejection tracker, which React Native
  treats as fatal; passed to `captureException` or thrown, such a value was dropped. It is now
  reported, as `Object captured as promise rejection` or `Function captured as promise rejection`.

## [0.0.1-rc.4] — 2026-10-19

Fifth release candidate. No breaking changes from `0.0.1-rc.3`. Run `pod install` after upgrading.

### Added

- **An Apple privacy manifest.** The iOS pod now bundles a `PrivacyInfo.xcprivacy`, so App Store
  Connect no longer flags the SDK for an undeclared required-reason API (ITMS-91053). It declares file
  timestamps (`C617.1`, read only for the SDK's own crash records inside the app container) and the
  data the SDK collects, which Xcode's privacy report uses for your App Store privacy labels. The
  collected types are crash data, performance data, other diagnostic data and product interaction,
  plus user ID, email address and name if you pass them to `identifyUser`. All are linked to the
  user, and none are used for tracking. See
  [Apple privacy manifest](./README.md#apple-privacy-manifest).

### Changed

- **The package ships minified and without sourcemaps**, like `@groundcover/browser`. Earlier
  release candidates published unminified code plus `.map` files that embed the TypeScript source.
  A stack frame inside the SDK now points into the minified file; frames in your own code are
  unaffected, and the Swift and Kotlin modules still ship as source.
- **The "removed option" warnings no longer link to a GitHub repository.** They name the README
  section to read and point at the package's npm page, where that README is shown.

### Fixed

- **The hang watchdog no longer wakes the CPU while the app is in the background.** It paused
  detection when the app went to the background but kept polling. On iOS that was a 10 Hz
  main-thread heartbeat plus a 10 Hz monitor thread, and on Android a 2 Hz loop, for as long as an
  app that keeps running in the background (audio, navigation, a foreground service) stayed alive.
  Both now sleep until the app returns, and the iOS heartbeat allows timer coalescing in the
  foreground. Detection and thresholds are unchanged.
- **Android reads an ANR trace only for an exit it reports, and stops at its 256K-character cap.**
  The launch-time crash harvest used to decompress every ANR trace still in the system's exit
  history, in full, on every launch.

## [0.0.1-rc.3] — 2026-10-12

Fourth release candidate. No breaking changes from `0.0.1-rc.2`.

### Fixed

- **iOS taps are no longer cancelled when another library reacts to a gesture recognizer
  activating.** To timestamp touch-down for scroll and swipe capture, the SDK attached a
  zero-duration long-press recognizer to every window, and it *recognized* on every touch. Code that
  responds to any recognizer activating took that as the tap being claimed. react-native-gesture-handler
  before 2.13 cancels every JavaScript responder when that happens, so on iOS 18 a tap reached
  JavaScript as `touchStart` followed at once by `touchCancel`, and `onPress` never fired. The
  touch-down clock now records the touch and fails at once, so it never activates. Scroll and swipe
  events are unchanged. A drag can still be cancelled under react-native-gesture-handler before 2.13
  once it crosses the movement threshold.

## [0.0.1-rc.2] — 2026-09-29

Third release candidate. **Contains a breaking change from `0.0.1-rc.1`** (`tracing.propagationUrls`)
— see [Migrating from 0.0.1-rc.0](./README.md#migrating-from-001-rc0).

Network and exception shaping now run on the same shared core as `@groundcover/browser`, so the two
SDKs emit identical events for identical traffic. Where the platforms disagreed, React Native adopts
the browser's behaviour.

### Changed (breaking)

- **`tracing.propagationUrls` patterns match the full request URL only.** A path-only pattern such
  as `"/api/*"` used to match that path on *any* host, sending trace headers (and your
  `tracing.origin` tag) to third parties; it now matches nothing and the SDK warns once at startup.
  Use a full-URL pattern such as `"https://api.myapp.com/*"`.

### Changed

- **A response body with no `content-type` is recorded as `[binary data]` instead of being
  decoded**, as on web. A known-empty response (HEAD, 204/205/304, `content-length: 0`) still records
  `""`.
- **A `fetch` whose first argument is a `Request` has its body gated on the content-type**: a binary
  or multipart body is labelled instead of decoded, and a body that can't be read is
  `[request body unavailable]` instead of `""`.
- **More specific binary labels**: `[font data]`, `[archive data]`, `[wasm data]` and
  `[protobuf data]` (gRPC included), matching the browser.
- **No more warnings about the browser-only 1.x options** `enableMasking` and `maskFields`, which
  React Native never had. `eventSampleRate` still warns and is stripped.

### Fixed

- **Batches are no longer silently dropped on hosts without `TextEncoder`.** The send path encoded
  uncompressed batches (and the gzip-failure fallback) with a global `TextEncoder`; where it was
  missing the batch was lost unless `debug` was on. Batches are now always sent: through the global
  `TextEncoder` where there is one (RN 0.74+ on Hermes), otherwise through the compression library's
  own encoder, which is exact for most text but mis-encodes emoji — see the
  [encoding note](./README.md#coverage--limitations).
- **A user `screen` attribute can no longer spoof or pollute the SDK's screen stamp.** Log
  attributes named `screen` are now reserved (a `screen: {…}` object previously shipped as extra
  `screen.*` keys next to the SDK's own block), and a user `location` attribute — which RN never
  stamps — is no longer dropped.
- **React fibers passed as attributes or metadata are not walked.** A fiber reached through
  `sendCustomEvent`, `logger.*` or `captureException` data is now a `[FiberNode]` placeholder (or
  `[REDACTED]` where masking applies) instead of being flattened until the depth limit.
- **Custom `tracing.propagationHeaders` no longer drop the event's trace ids.** The traceparent was
  injected under the custom header names but read back only from `traceparent`, so those requests
  were traced while their network events carried no `traceId`/`spanId`. Header names are also
  matched case-insensitively now.
- **A `text/event-stream` fetch response is reported immediately** as `[unreadable response body]`.
  On runtimes with response streams (Expo) the body read waited on a stream that never closes, and
  the event was never sent.
- **The request/response size cap counts UTF-8 bytes exactly**, including unpaired surrogates.

## [0.0.1-rc.1] — 2026-09-28

Second release candidate. **Contains breaking changes from `0.0.1-rc.0`** — see
[Migrating from 0.0.1-rc.0](./README.md#migrating-from-001-rc0).

### Changed (breaking)

- **Event-level sampling is removed.** `options.eventSampleRate` now warns and is ignored, on
  `init` and on `updateConfig`; use `options.sessionSampleRate` to select whole sessions. Rates are
  not converted, so event volume can increase if you sampled below `1`.
- **Application identity is fixed per SDK instance.** `appId` must be a non-blank string, the SDK
  initializes once (later `init` calls are ignored; a failed init may be retried), and
  `updateConfig` rejects any update that contains `appId`.

### Fixed

- **Returning to the foreground is counted once.** Duplicate `active` AppState signals no longer
  re-trigger session reconciliation; only a genuine return from `background`/`inactive` does.

## [0.0.1-rc.0] — 2026-08-30

First release candidate — the initial public build of the React Native RUM SDK. It emits the same
`/json/rum` wire format as [`@groundcover/browser`](https://www.npmjs.com/package/@groundcover/browser),
so mobile sessions land in the same backend and dashboards as web RUM.

### Added

**JavaScript layer** — runs in Expo Go with no native setup.

- **Sessions.** AppState- and touch-driven presence, 30-minute inactivity gap plus a duration cap
  for rotation, and AsyncStorage-backed continuity across app restarts (pass your AsyncStorage via
  `init({ storage })`, or the SDK auto-detects the installed peer). Session attributes carry
  `source: "mobile-rum"` plus OS, device and app metadata, so the backend can tell mobile RUM from
  web and iOS from Android.
- **Network and distributed tracing.** Both `XMLHttpRequest` and the global `fetch` are wrapped —
  covering classic RN, Expo's native-backed `fetch` and `axios` alike, gated per call so nothing is
  captured twice — propagating `traceparent`. Importing the binding directly from `expo/fetch`
  bypasses the global and is a documented gap.
- **Screen tracking.** Automatic through React Navigation via `startNavigationTracking(ref)`, or
  manual via `startNavigation` / `endNavigation`.
- **Interactions.** Taps, typing, long presses, swipes, scrolls and pinches, captured as
  `interaction` events with a fiber-walk component path and a label taken from
  `accessibilityLabel` (falling back to descendant text). The typed value is never recorded.
- **Logs, custom events and errors.** `logger.*` for structured logs, `sendCustomEvent` for
  business events, uncaught JS errors through RN's global `ErrorUtils` handler, and handled ones
  through `captureException`. The SDK always chains the handler it replaced, so your existing
  crash reporting and redbox behaviour are untouched.
- **User identification** through `identifyUser`.
- **Privacy masking on by default** (`level: "mask-sensitive"`), with per-element `dataPrivate`
  and a `redact` hook for custom scrubbing.

**Native layer** — needs a dev build (`expo run:ios` / `expo run:android`, or a bare RN app). In
Expo Go these never arm and every JavaScript feature is unaffected.

- **Native crashes.** KSCrash on iOS, a chained JVM `UncaughtExceptionHandler` on Android.
  Reported on the next launch, under the session they happened in, at-least-once with a stable
  `crash_report_id` for backend dedupe.
- **ANR and app-hangs.** Main-thread watchdogs report stalls the app recovered from; Android's
  `ApplicationExitInfo` covers the ones it did not.
- **App start and time-to-interactive.** Cold, warm and hot starts. TTI anchors on the first
  screen landing by default, or on `markAppInteractive()` under `native.tti: "manual"`.
- **Frame vitals.** Slow and frozen frame counts scoped per screen, judged against the display's
  real refresh rate.

Crashes and hangs reuse the existing `exception` wire type; app start, TTI and frame vitals reuse
`performance`. No new wire types, so they land in the same views as their web counterparts. Each
native signal has its own `enabledEvents` name (`"crashes"`, `"hangs"`, `"appStart"`, `"vitals"`),
with tuning under `options.native`.

> **Scope of this release candidate.** Session replay is not included, and `expo/fetch` is not
> instrumented. CI compiles and exercises RN 0.86 (Expo 57) on a simulator and an emulator every
> build, while the declared support floor is RN 0.74, iOS 13.4 and Android API 23 — the span between
> the two is unproven rather than known-broken. See
> [Coverage & limitations](README.md#coverage--limitations).
