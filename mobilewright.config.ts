import { defineConfig } from "mobilewright";
import { APP, app, BUNDLE_ID } from "./tests/e2e/mobile/support/app";

// e2e for the mobile playgrounds, exercising @groundcover/react-native (APP=rn,
// the default), groundcover_rum (APP=flutter) or the native SDKs (APP=native) on a
// real simulator/emulator.
// The analogue of the browser Playwright e2e: it drives the actual app via
// accessibility locators and asserts on the batches the SDK POSTs to the mock
// ingest (started in global-setup; the app's DSN points at it).
//
// One suite serves every app (tests/e2e/mobile/support/app.ts). Each app's projects
// are named for it (rn-ios, flutter-android, native-ios, …) and leave out the tests carrying
// one of its profile's skipTags. Mobilewright launches the app by bundle ID; the
// app must be built with its DSN pointing at the host as that platform reaches it
// (localhost for iOS, 10.0.2.2 for Android).
const grepInvert = new RegExp(app.skipTags.join("|"));

export default defineConfig({
  testDir: "tests/e2e/mobile",
  // Device specs are `*.spec.ts` ONLY. Playwright's default `testMatch` also
  // takes `*.test.ts`, which would collect `support/*.test.ts` — the plain unit
  // tests over the harness's own helpers — and try to run them against a
  // simulator, where they would fail for want of a device fixture. Those run
  // under vitest (see support/vitest.config.ts); this keeps the two apart.
  testMatch: "**/*.spec.ts",
  globalSetup: "tests/e2e/mobile/support/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // The iOS driver (mobilecli) has an internal ~30s deadline for WebDriverAgent
  // to become ready, and WDA's one-time cold start on a fresh sim can take longer
  // than a single attempt. The 00-warmup spec is the sacrificial first run that
  // absorbs it, but the RpcError fires at AGENT START (before the spec body), so
  // only the retry count — not the spec's internal loop — buys more WDA-ready
  // time. 2 retries = 3 attempts, enough headroom for the cold start; retries
  // only cost time on an actual failure, so passing runs stay fast.
  retries: process.env.CI ? 2 : 0,
  // list → console; html → persists the on-failure screenshot + view-tree
  // attachments to disk under test-results/report/ (the "list" reporter alone
  // keeps body attachments in memory, which leaves CI's test-results/ upload empty).
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/report" }]],
  // Explicit so attachment files + the report both land under the uploaded dir.
  outputDir: "test-results/output",
  // Capture the full accessibility tree on any failure (screenshot is automatic).
  viewTree: "on-failure",
  // Per-test budget: it has to sit above the sum of the waits one test can make,
  // and with a 20s action ceiling (below) two waits still fit comfortably.
  timeout: 120_000,
  // A CEILING, not a budget — only ever spent on a test that was going to fail. Same on CI and
  // off, so a developer reproducing a CI failure gets CI's verdict.
  //
  // Raising it does not help when `no matching element found` means the app has exited. A
  // react-native-screens release before 4.28.0 can crash the app on Android
  // (software-mansion/react-native-screens#4413), so the playground stays on 4.28.0 or later.
  expect: { timeout: 20_000 },
  use: {
    bundleId: BUNDLE_ID,
    actionTimeout: 20_000,
  },
  // Only the selected app's projects exist, so `--project flutter-ios` without
  // APP=flutter fails loudly instead of driving the wrong app.
  projects: [
    { name: `${APP}-ios`, grepInvert, use: { platform: "ios", deviceName: /iPhone/ } },
    { name: `${APP}-android`, grepInvert, use: { platform: "android" } },
  ],
});
