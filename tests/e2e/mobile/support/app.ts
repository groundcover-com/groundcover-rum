// Which app the suite drives, and everything about it a spec may not hard-code.
//
// One suite, three apps: apps/rn-playground, apps/flutter-playground and the native playgrounds
// (apps/ios-playground on iOS, apps/android-playground on Android) expose the same screens,
// labels and fixtures, so a spec drives any of them. What genuinely differs between them lives
// here and nowhere else. `APP=flutter` selects the Flutter app and `APP=native` the native ones;
// anything else, including unset, is RN, so every existing RN command keeps working.
//
// What a spec does NOT get from here is which tests apply. Tags do that: a profile's
// `skipTags` become its projects' grepInvert in the root mobilewright.config.ts.
//   @rn-only          a test of something only RN has (console.*, XHR, axios, a11y values)
//   @flutter-only     a test of something only Flutter has (debugPrint, dart:io, dio)
//   @hybrid-only      a test of something RN and Flutter have and a native app can't: a
//                     framework's handler for an uncaught error the app survives (in a native
//                     app an uncaught error is a crash, which native-crash covers)
//   @native-app-only  a test of the native SDKs alone (their own HTTP clients, UIKit and
//                     Fragment screens, an Android dialog)
//   @native           needs the native engine (crashes, hangs, app start, frame vitals). Every
//                     app has it; the tag marks the tests an app without the engine would skip.
// Any test an app's skipTags don't exclude runs against that app and has to pass, unless it
// carries a pending mark (see isFlutter).

import type { Locator, Screen } from "@mobilewright/core";

export type AppName = "rn" | "flutter" | "native";

type AppProfile = {
  bundleId: string;
  /** The session envelope's `app.id`: the appId the playground initialises with. */
  appId: string;
  /** How a spec picks the app's init-time config; see support/preset.ts. */
  presetChannel: "metro-source" | "data-file";
  /**
   * Where the data-file channel writes in the Android app's data directory: Flutter's
   * getApplicationDocumentsDirectory() is `app_flutter/`, a native app's filesDir is `files/`.
   */
  androidDataDir?: string;
  /**
   * The Logs-tab control that logs through the platform's own logging rather than the
   * SDK's API, and the message it logs. Specs that need "some log the SDK captured on its
   * own" use this.
   */
  platformLog: { button: string; message: string };
  /** `error_type` of the playground's own errors. */
  errorType: string;
  /**
   * `capture_source` of a gesture the framework side classified. A native app has no framework
   * side, so its SDK classifies every gesture natively.
   */
  frameworkCaptureSource: "js" | "dart" | "native";
  /**
   * `capture_source` of a scroll or swipe on the main screen. RN measures them in its
   * native tracker; Flutter classifies them in Dart (native trackers don't see Flutter's
   * surface), so for Flutter this is the framework source too.
   */
  movementCaptureSource: "native" | "dart";
  /**
   * `capture_source` of a drag inside a modal. RN's iOS tracker hooks windows and so covers the
   * modal; its Android one hooks activities, and a Dialog is not one, so JavaScript reports it.
   */
  modalMovementCaptureSource: (os: "ios" | "android") => "native" | "js" | "dart";
  /**
   * The Taps screen's text field. Flutter's and the native apps' by test ID: Android's tree
   * carries a field's label as its hint, which getByLabel doesn't read.
   */
  searchField: (screen: Screen) => Locator;
  /**
   * Picks the tap on the a11y-annotated button out of a masked session, by a structural field:
   * RN's numeric `value.now`; Flutter's Semantics has no numeric value, so `state.expanded`;
   * SwiftUI has no expanded state either, so the native apps use `state.selected` with a value:
   * the selected tab carries `state.selected` too, and only the annotated button has both.
   */
  isAnnotatedTap: (attributes: Record<string, unknown>) => boolean;
  /**
   * The label a tap on the Taps screen's well-tagged button carries. Its accessibility label
   * ("Increment counter") replaces its visible text ("Well-tagged button (tapped N)"). RN and
   * Flutter name a target by its text; the native SDKs by its accessible name, the label first,
   * as the browser does (aria-label before text) and as VoiceOver and TalkBack read it.
   */
  wellTaggedLabel: RegExp;
  /** The annotated button's numeric a11y value, which only RN reports. */
  annotatedValueNow?: number;
  /**
   * What a tap on the Taps screen's own Button, inside its Card, reports as its component and
   * component path. RN's fiber walk and Flutter's element walk name the app's own components.
   * SwiftUI and Compose keep no view or function names at runtime, so the native apps leave it
   * unset, and the specs check it only where it is set.
   */
  tapComponents?: { component: string; pathIncludes: string[] };
  /**
   * The least a debug build's cold start can plausibly take: a floor that catches a start
   * measured from the wrong anchor (reporting next to nothing). RN's Metro-served bundle is
   * never quick to arrive; a Flutter debug build has no Metro, so it can start well under RN's
   * floor.
   */
  coldStartFloorMs: number;
  /**
   * Where automatic TTI may equal the cold start. TTI is clamped to the first frame, so equality
   * usually means the interactive mark landed before it and is masked. Under RN and Flutter the
   * mark (the first screen, in JavaScript or Dart) comes well after the native first frame. In the
   * native iOS app the first screen's onAppear runs in the first layout, a few ms before the
   * first frame, so TTI equals the cold start there by construction. Android's native screens are
   * decided after their first frame, so its TTI comes after the cold start.
   */
  ttiMayEqualColdStartOn: ("ios" | "android")[];
  /** Tests this app's projects leave out, by tag; see the header. */
  skipTags: string[];
};

const PROFILES: Record<AppName, AppProfile> = {
  rn: {
    bundleId: "com.groundcover.rumplayground",
    appId: "rn-playground",
    presetChannel: "metro-source",
    platformLog: { button: "console.log", message: "playground console.log" },
    errorType: "Error",
    frameworkCaptureSource: "js",
    movementCaptureSource: "native",
    modalMovementCaptureSource: (os) => (os === "ios" ? "native" : "js"),
    searchField: (screen) => screen.getByLabel("Search field"),
    isAnnotatedTap: (attributes) => attributes["interaction_target.value.now"] === 42,
    wellTaggedLabel: /^Well-tagged button/,
    annotatedValueNow: 42,
    tapComponents: { component: "Button", pathIncludes: ["Card > Button", "HomeScreen"] },
    coldStartFloorMs: 300,
    ttiMayEqualColdStartOn: [],
    skipTags: ["@flutter-only", "@native-app-only"],
  },
  flutter: {
    bundleId: "com.groundcover.flutterplayground",
    appId: "flutter-playground",
    presetChannel: "data-file",
    platformLog: { button: "debugPrint", message: "playground debugPrint" },
    errorType: "StateError",
    frameworkCaptureSource: "dart",
    movementCaptureSource: "dart",
    modalMovementCaptureSource: () => "dart",
    searchField: (screen) => screen.getByTestId("home-text-input"),
    isAnnotatedTap: (attributes) => attributes["interaction_target.state.expanded"] === true,
    wellTaggedLabel: /^Well-tagged button/,
    tapComponents: { component: "Button", pathIncludes: ["Card > Button", "HomeScreen"] },
    coldStartFloorMs: 100,
    ttiMayEqualColdStartOn: [],
    skipTags: ["@rn-only", "@native-app-only"],
  },
  native: {
    bundleId: "com.groundcover.nativeplayground",
    appId: "native-playground",
    presetChannel: "data-file",
    androidDataDir: "files",
    // swift-log through GroundcoverLogHandler on iOS, Timber through GroundcoverTree on Android.
    platformLog: { button: "platform log", message: "playground platform log" },
    errorType: "PlaygroundError",
    frameworkCaptureSource: "native",
    movementCaptureSource: "native",
    // A presented view controller on iOS, a Dialog's own window on Android: the native SDKs
    // are the only side there is, so whichever covers the surface reports natively.
    modalMovementCaptureSource: () => "native",
    searchField: (screen) => screen.getByTestId("home-text-input"),
    isAnnotatedTap: (attributes) =>
      attributes["interaction_target.state.selected"] === true &&
      attributes["interaction_target.value.text"] !== undefined,
    wellTaggedLabel: /^Increment counter$/,
    // No bundle to load, like a Flutter debug build: Flutter's floor.
    coldStartFloorMs: 100,
    ttiMayEqualColdStartOn: ["ios"],
    skipTags: ["@rn-only", "@flutter-only", "@hybrid-only"],
  },
};

export const APP: AppName =
  process.env.APP === "flutter" ? "flutter" : process.env.APP === "native" ? "native" : "rn";
export const app: AppProfile = PROFILES[APP];
export const BUNDLE_ID = app.bundleId;

/**
 * Whether the suite drives the Flutter app. Only for pending marks while an SDK feature is built:
 * `test.fail(isFlutter, "pending: …")`, Playwright's expected failure, naming what the test waits
 * on. The change that makes the test pass deletes the mark, and CI fails a marked test that passes
 * as surely as an unmarked one that fails. Never for branching what a test asserts: that is what
 * `app` and the tags are for. Flutter CI fails on any mark left in a PR that is out of draft.
 */
export const isFlutter = APP === "flutter";

/**
 * Whether the app has the native engine's signals (crashes, hangs, app start, frame vitals):
 * exactly when its projects run @native tests. For a spec that mixes them into an otherwise
 * portable test; whole tests that need them are tagged @native instead.
 */
export const hasNativeEngine = !app.skipTags.includes("@native");
