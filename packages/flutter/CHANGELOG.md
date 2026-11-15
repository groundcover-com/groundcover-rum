# Changelog

## 0.0.1-rc.3

The fourth release candidate. No breaking changes from `0.0.1-rc.2`, and no changes to the SDK's
behaviour.

### Changed

- **The package links to its source.** `repository` and `issue_tracker` point at
  [groundcover-com/groundcover-rum](https://github.com/groundcover-com/groundcover-rum).

## 0.0.1-rc.2

The third release candidate. No breaking changes from `0.0.1-rc.1`, and no changes to the SDK's
behaviour: source comments and documentation only.

## 0.0.1-rc.1

The second release candidate. No breaking changes from `0.0.1-rc.0`.

### Changed

- **Fewer idle wakeups on iOS.** The hang watchdog's monitor thread looks at the main thread's
  heartbeat a fifth of the threshold apart (0.4 s at the default 2 s) instead of every 0.1 s while
  it waits for a stall. The heartbeat, and the wait for a stall to end, stay at 0.1 s, so hang
  starts and durations are as precise as before; a stall that ends within one monitor interval of
  the threshold can go unnoticed.
- **Android consumer rules no longer keep Kotlin metadata for the whole app.** The rule served
  nothing in the SDK and kept every minified app's own Kotlin metadata.
- **The iOS privacy manifest gives the same answers as React Native's.** Crash, performance, other
  diagnostic and product interaction data are declared as linked to the user, and user ID, email
  address and name are declared, since every event carries the identity once the app identifies
  users.
- **One groundcover SDK per app.** The README now says that an app can't run this SDK alongside
  groundcover's native iOS or Android SDK.
- **The README matches the SDK.** A route built in `onGenerateRoute` is tracked only when it gets
  the `settings` passed in. Errors sent from a zone's handler through `captureException` arrive
  with `error_handled: true`. The test hooks are documented with the builds they work in.
  `maskAll` redacts network, logs and errors as `maskSensitive` does, and the iOS hang check
  interval is a fifth of the threshold.
- **The README says which crash reporters run alongside this SDK.** One with handlers of its own
  does. One built on KSCrash, which is one per process, doesn't: only one of the two captures
  native crashes on iOS, and if this SDK installs first, the other may delete its unsent crash
  reports. Start such a reporter before this SDK, or leave its crash reporting out.

### Fixed

- **App start on iOS: no cold start lost, no launch reported as a hot start.** The engine reported
  a launch's cold start only when it was already drawn as the SDK started, so an app that awaits
  `GroundcoverRum.init` before `runApp` lost its `app_start_cold` and time to interactive. It now
  waits for the first frame. A scene-based app (SwiftUI, or UIKit with a scene manifest) no longer
  reports an `app_start_hot` for its own launch, and a launch the system made in the background (a
  push, a background refresh), or one sent to the background before its first frame, reports no
  cold start.
- **Android frame vitals and app start follow the app, not each Activity.** Frame segments close
  as `background` only when the app leaves the foreground, and restart only when it returns: a
  permission or biometric prompt no longer discards the screen's frames, and opening another
  Activity no longer files a `background` segment while the app stays visible. A new Activity in a
  running app, or one recreated by a rotation, dark-mode or locale change, is no longer reported
  as an `app_start_warm` or `app_start_hot`.
- **iOS crash stacks from release builds can be symbolicated.** A native crash's frames carried
  only the slid address, and the app's load address was read from a key KSCrash never writes, so
  a stripped build's frames could never be mapped to its dSYM. Frames are now the symbol and the
  offset into it, else the image and the offset into it (`MyApp + 0x2334`), and the load address
  is recorded from the app's binary image.
- **iOS NSException and C++ crashes start where they were thrown.** KSCrash 2.6 keeps the throw
  site apart from the crashed thread, whose stack opens with the runtime's terminate handling
  (and, for an exception thrown in a dispatched block, can lose the throw site entirely). The
  crash's frames now come from the throw site when KSCrash recorded one.
- **iOS leaves the app's C++ exceptions alone.** The crash reporter no longer rebinds
  `__cxa_throw` in every loaded image, which could break apps and libraries that throw and catch
  their own C++ exceptions. With KSCrash 2.6, the version resolved at release, a C++ crash still
  records where it was thrown.
- **Android reports only the main process's deaths.** An ANR or native crash in one of the app's
  other processes (`:push`, `:media`) is no longer reported as a fatal in the user's session.

## 0.0.1-rc.0

The first release candidate. It sends the same `/json/rum` format as groundcover's browser and
React Native SDKs, so Flutter sessions land in the same RUM views.

### Setup

- `await GroundcoverRum.init(config)` before `runApp`. It throws `GroundcoverInitException` when the
  SDK can't start; calls made before it completes are dropped with a warning.
- `GroundcoverWidget` around the app, and `GroundcoverNavigatorObserver` on the navigator or
  router.
- iOS builds through Swift Package Manager or CocoaPods, both with KSCrash, and ships an Apple
  privacy manifest. Android declares the `INTERNET` permission itself.

### Captured

- Sessions persisted across launches, with sampling, a presence gate (a touch or a return to the
  foreground) and rotation after 30 minutes idle or past `sessionMaxDuration`.
- Network capture for every `dart:io` `HttpClient` created after init (`package:http`, dio's
  default adapter), with W3C `traceparent` propagation to `tracing.propagationUrls`, redaction, and
  text bodies up to 5 KB.
- Navigation between named routes from `GroundcoverNavigatorObserver`, plus manual
  `startNavigation` / `endNavigation`.
- Taps, long presses, swipes, scrolls and pinches from `GroundcoverWidget`, named from the widget
  tree; one `input` event per finished text edit, never the text.
- Uncaught errors from `FlutterError.onError` and `PlatformDispatcher.onError`, chained to the
  app's handlers, and `captureException`.
- Logs from `debugPrint` and `GroundcoverRum.logger`; custom events; user identity.
- Native crashes, reported on the next launch under the session they happened in, even when that
  launch isn't sampled: iOS through KSCrash; Android through a chained uncaught-exception handler
  and, from API 30, the system's exit records. Delivered at least once, with a stable
  `crash_report_id`.
- App hangs: main-thread stalls the app recovered from, as `exception` events (`ANR` on Android,
  `AppHang` on iOS). Dart runs on the main thread, so a long Dart stall is reported too.
- App start: `app_start_cold`, `app_start_warm` and `app_start_hot`, from the process start to the
  first frame, and time to interactive (`app_start_tti`): the first screen landing, or
  `GroundcoverRum.markAppInteractive()` with `NativeOptions(tti: TtiMode.manual)`.
- Frame vitals: one `frames_delay_total` per screen, with slow and frozen frame counts, from
  Flutter's own frame timings.

### Privacy

- Masking on by default: privacy levels, per-surface masking, `sensitiveKeys`, a `redact` hook and
  `GroundcoverPrivate`. Typed text is never captured, including text an app mirrors into
  `Semantics(value:)`.

### Performance

- A batch's JSON, UTF-8 encoding and gzip run on a short-lived background isolate, off the UI
  thread. The batch sent as the app goes to the background is still built inline, so it is queued
  before the process can be suspended.

### Testing

- `package:groundcover_rum/testing.dart`: `GroundcoverRumTesting.reset()` stops the SDK and
  undoes what it installed, for an app's tests. `triggerTestCrash` and `blockMainThread` work in
  development builds only.
