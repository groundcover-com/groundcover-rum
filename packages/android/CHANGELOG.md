# Changelog

All notable changes to `com.groundcover:rum-android` and its integration modules
(`rum-android-compose`, `rum-android-okhttp` and `rum-android-timber`, released together under one
version) are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.0.1-rc.0] — 2026-11-08

The first release candidate. It sends the same `/json/rum` format as groundcover's browser, React
Native and Flutter SDKs, so Android sessions land in the same RUM views.

### Setup

- `Groundcover.start(context, config)` in `Application.onCreate`, in the app's main process. It
  throws `GroundcoverInitException` for a blank `appId`; calls made before it are dropped. Every
  configuration class has a builder for Java.
- Four artifacts on Maven Central: `rum-android`, plus `rum-android-okhttp`, `rum-android-compose`
  and `rum-android-timber` for the integrations an app uses. `minSdk` 23, `compileSdk` 36.
- The SDK's manifest declares the `INTERNET` permission and a startup provider that times app start,
  and it ships its own consumer R8 rules, so a minified app adds none.
- `GroundcoverRumTesting` for an app's tests: `reset()` and the session hooks, plus
  `triggerTestCrash` and `blockMainThread`, which work in debuggable builds only.

### Captured

- Sessions persisted across launches, with sampling, a presence gate (a touch or a return to the
  foreground) and rotation after 30 minutes without the user or past `sessionMaxDurationMs`.
- Screens from Activities, Fragments and, with `GroundcoverNavigationEffect`, Navigation Compose
  destinations, plus manual `startNavigation` / `endNavigation`.
- Taps, long presses, swipes, scrolls and pinches in every Activity and Dialog window, in Views and
  Compose alike, named as TalkBack names them; one `input` event per finished text edit, never the
  text.
- OkHttp requests through `GroundcoverOkHttpInterceptor` and `GroundcoverEventListener`, with W3C
  `traceparent` propagation to `tracing.propagationUrls`, and text bodies up to 5 KB, read without
  consuming the app's.
- Logs from `Groundcover.logger` and, through `GroundcoverTree`, Timber; custom events; user
  identity.
- Handled exceptions through `captureException`, with the cause chain.
- Crashes, reported on the next launch under the session they happened in, even when that launch
  isn't sampled: JVM crashes through a chained uncaught-exception handler and, from API 30, ANRs and
  native crashes from the system's exit records. Delivered at least once, with a stable
  `crash_report_id`.
- App hangs: main-thread stalls past `hangThresholdMs` (5 s by default) that the app recovered from,
  as `exception` events with `error_type: "ANR"`.
- App start: `app_start_cold`, `app_start_warm` and `app_start_hot`, and time to interactive
  (`app_start_tti`): the first screen landing, or `Groundcover.markAppInteractive()` with
  `NativeOptions(tti = TtiMode.MANUAL)`.
- Frame vitals, from API 24: one `frames_delay_total` per screen visit, with slow and frozen frame
  counts, from `FrameMetrics`.
- Masking on by default: privacy levels, per-surface masking, `sensitiveKeys`, a `redact` hook, and
  `View.groundcoverPrivate` / `Modifier.groundcoverPrivate()` for tap labels.

### Not included

- Session replay.
- HTTP clients other than OkHttp (`HttpURLConnection` included), and logcat.
- A mapping-file upload: stack traces from an R8-minified build arrive obfuscated.
- Running alongside groundcover's React Native or Flutter SDK in one app.
- ANRs and native crashes below API 30, and frame vitals below API 24.
