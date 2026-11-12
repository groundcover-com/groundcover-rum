# Running the native engine tests

The Swift and Kotlin engines each have a unit suite that runs **without a
simulator or emulator** — seconds, on any machine. They are the fast feedback
loop for the native code; the mobilewright e2e suites are the slow one.

| Suite | Command | Runs in CI as |
| --- | --- | --- |
| Swift | `packages/core/swift/run-engine-tests.sh` | `Engine unit tests (Swift)`, a step of each lane's `ios-app` job (RN CI, Flutter CI) and of Native iOS CI's `swift` job |
| Kotlin | `cd packages/core/kotlin/jvm-test && ./gradlew test` | `Engine unit tests (Kotlin)`, a job in each lane, from `.github/actions/engine-tests-kotlin` |

Both run against the engine's sources in this package — the only copy anyone edits.
Each SDK compiles a git-ignored copy that `scripts/vendor-engine.mjs` writes from it
(see [README](README.md)).

## Swift

```bash
cd packages/core/swift
./run-engine-tests.sh
```

Use the script rather than `swift test`. Under full Xcode the two are identical,
but on a machine with only the **Command Line Tools** — a Mac without a 15GB
Xcode install — plain `swift test` fails with `no such module 'Testing'`. The
swift-testing runtime *is* installed, just under `Library/Developer/` where
neither the compiler nor dyld looks by default; the script points at it. (Note
`DYLD_FRAMEWORK_PATH` does not work here: the helper that loads the test bundle
is SIP-protected, so the environment variable is stripped before it runs.)

`swift test` compiles only the pure-logic files, so it cannot show that the whole
engine builds without React. That check is a CocoaPods lint of the React Native
podspec's `Engine` subspec, which builds every engine file — UIKit, KSCrash and the
Objective-C boot file included — for the iOS simulator with no React pod available:

```bash
cd packages/react-native
pod lib lint GroundcoverRum.podspec --subspec=Engine --allow-warnings --platforms=ios
```

It lints RN's copy of this engine, so write it first (`node ../../scripts/vendor-engine.mjs`;
`pnpm install` also does). This harness's SwiftPM target can't do that job:
`AppStart/GCRumProcessBoot.m` is Objective-C called from Swift, and a SwiftPM target cannot mix
the two languages. The Flutter plugin's Swift package gets around it by building the boot unit as a
target of its own (`GroundcoverRumBoot`), and Flutter CI compiles the whole engine both ways: the
playground through that Swift package (`ios-app`) and through the plugin's podspec (`ios-pods`).

## Kotlin

```bash
cd packages/core/kotlin/jvm-test
./gradlew test
```

A plain Kotlin-JVM project pointed at `kotlin/src/main` and `kotlin/src/test` in
this package. It exists because no SDK build ever executes these tests:
`expo run:android` only *assembles*, and on an APK cache hit it skips Gradle
entirely.

The wrapper pins Gradle 8.13; a JDK 17 on `PATH` is the only prerequisite. Use
`./gradlew`, not a bare `gradle` — the version a developer happens to have
installed is not the version this harness is tested against, and on a machine
with no Gradle at all the bare command simply fails.

It compiles **every** `.kt` under both trees, with no allow-list, against the
Android SDK's classes and `androidx.annotation` alone. So it is also the engine's
React-free compile gate: an engine file that imports `com.facebook.*`, or anything
else an SDK bridge owns, fails `compileKotlin` here. There is deliberately no
`include(...)` filter — Gradle drops an unlisted file silently and still exits 0,
which would let a new test never run or a new engine file escape the gate.

## What is and is not covered

Both suites cover the **pure logic** first, split out of its platform host so it
can be tested at all: crash-report mapping, the pending record store, frame
segments, gesture geometry, app-start anchoring, config decode.

The Kotlin suite also covers a narrow second category, and **the two tiers are not
symmetric about it.** `android.*` is available there under Robolectric, so a unit
whose defect *is* its interaction with the platform can be tested directly.
`gestures/GcRumGestureTracker.kt` is the example: its teardown hazards are
orderings between the bridge thread and the main looper, so they need a pausable
looper to be reproducible at all and no amount of device time would pin them. What
can never appear there is `com.facebook.*` or any other framework import: the
engine has to build without one, and this harness is where that is enforced.

Swift has no counterpart. `swift test` runs a plain SwiftPM target with no UIKit
and there is no Robolectric equivalent, so
`Gestures/GCRumGestureTracker.swift` and its siblings stay excluded from
[`swift/Package.swift`](swift/Package.swift) and are covered on device. **A fix applied
to both trackers therefore gets unit proof on one side only** — worth knowing when
reading a twin pair, and the reason to read the Swift half especially carefully.

Anything needing a real signal handler, a CADisplayLink or the RN bridge is outside
both and covered by the e2e suites on a real device.

That split is load-bearing rather than incidental: adding a `UIKit` import to a
file listed in [`swift/Package.swift`](swift/Package.swift) breaks `swift test`. When
that happens the first move is still to pull the judgement out into a pure type;
reaching for the platform tier is the second, and only for units where the platform
interaction is the thing under test rather than an obstacle to it.

## Which units are twins, and which only look like it

Both engines are hand-maintained mirrors, so the only reliable way to catch drift between them is
to read a pair side by side — and you cannot diff files you do not know are a pair. `Detector`
against `Rules`, or `ForegroundMonitor` against `NotificationObservers`, gives no hint either way.
Hence this table. It is the cheapest place to keep it: one file, and it grows with the layers
rather than needing a comment edit in every unit.

| Role | Kotlin | Swift | Same shape? |
|---|---|---|---|
| Crash-report mapping | `crash/GcRumCrashRecordMapper.kt` | `Crash/GCRumCrashReportMapper.swift` | yes — and the names already disagree: `Record` against `Report` |
| Pending-record + snapshot store | `crash/GcRumSnapshotStore.kt` | `Crash/GCRumSessionSnapshotStore.swift` | yes, and the Swift file names the Kotlin seam it mirrors |
| Screen snapshot | `crash/GcRumScreenSnapshot.kt` | *(none — the envelope crosses as JSON)* | — |
| Hang judgement | `hang/GcRumHangDetector.kt` | `Hang/GCRumHangRules.swift` | **no — see below** |
| Crash capture | `crash/GcRumCrashHandler.kt` (chains the JVM handler) | `Crash/GCRumCrashReporter.swift` (owns the KSCrash singleton) | same role, different mechanism — the iOS half also HARVESTS, which is why `features.crashes` gates delivery there and not only capture |
| Hang plumbing | `hang/GcRumAnrWatchdog.kt` | `Hang/GCRumHangWatchdog.swift` | yes — names disagree again: `Anr` against `Hang`. Asymmetric unit coverage too: the Kotlin half's pause (parked, not polling) is tested under Robolectric, the Swift half's only on device, by the hang spec's stall after a return from the background |
| Post-mortem exits | `crash/GcRumExitInfoHarvester.kt` | *(none — KSCrash reports its own store)* | — |
| Frame judgement | `vitals/GcRumFrameAggregator.kt` | `Vitals/GCRumFrameAggregator.swift` | same role, **deliberately different content** — see below |
| Frame plumbing | `vitals/GcRumFrameTracker.kt` (FrameMetrics, per-Window) | `Vitals/GCRumFrameTracker.swift` (CADisplayLink, main run loop) | same role, and the different SOURCE explains most of the vitals differences — see below |
| Gesture judgement | `gestures/GcRumGestureClassifier.kt` | `Gestures/GCRumGestureClassifier.swift` | yes — and the shared thresholds (32dp, 300dp/s) must stay identical; the Kotlin constants name the other two |
| Gesture plumbing | `gestures/GcRumGestureTracker.kt` (per-Activity, wraps `Window.Callback`) | `Gestures/GCRumGestureTracker.swift` (per-`UIWindow`, adds recognizers) | same role, different unit of coverage — which is why `COVERS_ALL_SURFACES` is false on Android and true on iOS. Also the one pair with **asymmetric unit coverage**: the Kotlin half is tested under Robolectric, the Swift half only on device |
| App-start judgement | `appstart/GcRumAppStartState.kt` | `AppStart/GCRumAppStartRules.swift` | yes — names differ for the hang pair's reason: Kotlin's holds the launch's state, Swift's is a stateless `enum`. The 60s sanity cap must stay identical |
| App-start plumbing | `appstart/GcRumStartupProvider.kt` (a ContentProvider, to run before `Application.onCreate`) | `AppStart/GCRumAppStartTracker.swift` + `AppStart/GCRumProcessBoot.{h,m}` (a load-time constructor) | same role, different mechanism |

**The hang judgement pair is deliberately asymmetric, which is why the names differ.** Kotlin's
holds STATE: what it judges lives in the *sequence* of observations, so the sequence is what has
to be testable. Swift's is a stateless `enum` returning one verdict, matching that platform's
convention for judgement units (`GCRumAppStartRules`, `GCRumFrameAggregator`,
`GCRumGestureClassifier`). Renaming either to match the other would hide a difference that matters
more than the symmetry would buy. Read them together anyway — the *thresholds and the recovery
rule* are what drift.

**`lifecycle/GcRumForegroundMonitor.kt` and `Lifecycle/GCRumNotificationObservers.swift` are NOT a
pair**, despite sitting in identically-named directories and both being pure enough to unit-test.
The Kotlin one derives foreground state by counting started activities, because Android has no
app-level callback. The Swift one is a bag of `NotificationCenter` tokens that exists because
block-based observers can only be removed through the token they return; iOS gets foreground state
directly from two notifications and needs no state machine. Nothing to diff, and treating them as
counterparts would imply an iOS unit that does not exist.

**The frame aggregators are a real pair whose CONTENT deliberately differs**, and the difference is
not incidental — without it the two platforms would produce incomparable numbers. iOS feeds the
aggregator a `CADisplayLink` inter-tick INTERVAL, which arrives whether or not the app drew
anything, so it must estimate the rate the display is actually running at (ProMotion rests at
60Hz on a 120Hz panel) and must exclude process-suspension gaps. Android feeds
`FrameMetrics.TOTAL_DURATION` — real work time, emitted only on a real draw — so it needs neither,
and porting the cadence estimate there would absorb genuine jank into a rolling baseline. What MUST
stay identical is the slow bar, the 700ms frozen bar, and the frame budget `delayMs` is measured
against. Read those three together; everything else is allowed to diverge.

**The app-start judgement pair follows the hang pair's split.** Android's `GcRumAppStartState.kt`
holds the cold/warm/hot decision, the 10s `COLD_START_WINDOW_MS` and the 60s `SANITY_CAP_MS`, with
no clock and no `android.*`, so `GcRumAppStartStateTest.kt` drives it on the JVM;
`GcRumStartupProvider.kt` only feeds it lifecycle callbacks. iOS keeps the same judgement — which
anchor applies, is the duration believable — in the stateless `GCRumAppStartRules.swift`, tested
by `GCRumAppStartRulesTests.swift`.

Add a row here for every new engine unit; mark any row that is *not* a pair.
