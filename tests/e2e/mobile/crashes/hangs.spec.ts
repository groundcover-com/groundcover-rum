import { test, expect } from "@mobilewright/test";
import {
  androidCanFreeze,
  androidFreezeProcess,
  androidPidOf,
  androidProcessState,
  androidUnfreezeProcess,
} from "../support/android-device";
import { expectEvents, getEvents, settleAndClear } from "../support/ingest-client";
import { BUNDLE_ID } from "../support/app";


// Terms are each platform's own: Android says ANR, Apple says AppHang.
const HANG_TYPES = ["ANR", "AppHang"];

function isHang(event: { type?: string; attributes?: unknown }): boolean {
  if (event.type !== "exception") return false;
  const type = String((event.attributes as Record<string, unknown>)?.["error_type"] ?? "");
  return HANG_TYPES.includes(type);
}

/**
 * Mirrors HANG_STALL_MS in apps/rn-playground/src/screens/NativeScreen.tsx and hangStallMs in
 * apps/flutter-playground/lib/screens/native_screen.dart.
 */
const STALL_MS = 3_000;

// `error_metadata` is an object, so the enricher DOT-FLATTENS it: the wire carries
// `error_metadata.hang_duration_ms` as one flat key, not a nested object to walk. Reading it as
// nested returns undefined, which a Number() fallback turns into a plausible-looking number — so
// this is the kind of mistake that makes an assertion fail against healthy code (or, with a
// friendlier fallback, pass against broken code).
function hangDurationMs(event: { attributes?: unknown }): number {
  const attributes = event.attributes as Record<string, unknown> | undefined;
  return Number(attributes?.["error_metadata.hang_duration_ms"] ?? -1);
}

// The hang watchdog's LIFECYCLE, not its detection maths.
//
// The watchdogs are pure platform plumbing — a Handler round trip on Android, a
// run-loop timer plus a sleeping thread on iOS. Only the Android one's pause is
// reachable from a unit suite, under Robolectric (see packages/core/NATIVE_TESTING.md),
// so this spec is the only place the rest of their start/pause/stop behaviour, and all
// of iOS's, can be asserted.
test.describe("rn-playground — hang watchdog lifecycle", { tag: "@native" }, () => {
  // POSITIVE CONTROL, and it earns its keep: without it the background test
  // below would pass just as happily if hang reporting were broken outright, or
  // if the playground's threshold preset never reached native. It has to fail
  // for the negative assertion below to mean anything.
  test("reports a main-thread stall the app recovered from", async ({ screen }) => {
    test.setTimeout(180_000);

    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    // Blocks for 3s against the playground's 1s hangThresholdMs.
    await screen.getByLabel("Block main thread").tap();

    const [hang] = await expectEvents("exception", {
      timeout: 60_000,
      where: isHang,
      describe: "the recovered main-thread stall",
    });

    // The reported duration has to be the STALL's, not the watchdog's bookkeeping. A watchdog that
    // times a stall from when it posted its probe — necessarily somewhere inside the stall, since
    // detection requires exactly that — comes out short by up to `D - H`.
    //
    // A guard on the semantics, not a reproduction: at this preset's 1s threshold the probe lands
    // early enough often enough that a probe-timed watchdog would usually stay inside the window
    // too. It pins the semantics so a change cannot quietly time from the probe;
    // `zz-perturbing/hang-sampling.spec.ts` reproduces that defect, at the threshold that makes
    // both halves of it visible.
    //
    // The window is one-sided on purpose. Short is the defect: it drops a hang into a lower duration
    // bucket, or under a consumer's alerting floor. Long is inherent and bounded — a stall is timed
    // from the last instant the main thread was known responsive, up to one poll interval before it
    // truly began — so the upper bound absorbs that plus device scheduling while still failing a
    // wildly inflated duration.
    expect(hangDurationMs(hang!)).toBeGreaterThanOrEqual(STALL_MS);
    expect(hangDurationMs(hang!)).toBeLessThan(STALL_MS * 2);
  });

  // The watchdogs park while the app is away and must come back: this stall comes after a trip to
  // the background. Without it, a resume that never re-armed the heartbeat would pass every other
  // test here, the stall going unreported rather than misreported.
  test("reports a stall after a return from the background", async ({ screen, device }) => {
    test.setTimeout(180_000);

    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    await screen.pressButton("HOME");
    await new Promise((r) => setTimeout(r, 3_000));
    await device.launchApp(BUNDLE_ID);

    // Back on the Native tab, where the app was left.
    await screen.getByLabel("Block main thread").tap({ timeout: 60_000 });

    const [hang] = await expectEvents("exception", {
      timeout: 60_000,
      where: isHang,
      describe: "the stall after the return",
    });
    expect(hangDurationMs(hang!)).toBeGreaterThanOrEqual(STALL_MS);
    expect(hangDurationMs(hang!)).toBeLessThan(STALL_MS * 2);
  });

  // Flutter only: a stall in Dart code rather than a native sleep. From Flutter 3.29 Dart runs on
  // the platform thread on iOS and Android, so the native watchdog sees a Dart busy loop as it sees
  // any main-thread block. A Flutter version, or an app setting, that moved Dart off that thread
  // would lose hang coverage with nothing else failing; this is where it would show.
  test(
    "reports a stall in Dart code, which runs on the main thread",
    { tag: "@flutter-only" },
    async ({ screen }) => {
      test.setTimeout(180_000);

      await screen.getByLabel("Native tab").tap();
      await settleAndClear();

      // Busy-waits 3s in Dart, from the frame after the tap, against the 1s hangThresholdMs.
      await screen.getByLabel("Block Dart thread").tap();

      const [hang] = await expectEvents("exception", {
        timeout: 60_000,
        where: isHang,
        describe: "the recovered Dart stall",
      });
      expect(hangDurationMs(hang!)).toBeGreaterThanOrEqual(STALL_MS);
      expect(hangDurationMs(hang!)).toBeLessThan(STALL_MS * 2);
    }
  );

  // A backgrounded app is idle, not hung. The engine pauses the Android watchdog on the background
  // transition, and a process the system freezes while away must not read as a stall on resume
  // either. The suspension has to be forced, because the freezer skips DEBUGGABLE processes and
  // the playground is debuggable; SIGSTOP is the same mechanism.
  //
  // A guard, not a reproduction: a never-paused watchdog would pass this too. The watchdog posts a
  // token every ~1.5s and an idle looper answers in milliseconds, so a suspension is invisible
  // unless it lands in that window; the cost of not pausing is a wakeup every ~1.5s plus a racy
  // false positive, not the "false ANR on every resume" `setPaused` alone suggests. It still
  // catches a change that dates a stall from before a suspension. The `State: T` assertion is
  // load-bearing, so this fails loudly rather than going vacuously green.
  test("a frozen background process does not report the absence as a hang", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    if (platform !== "android") {
      test.skip(true, "Android-specific: iOS suspends backgrounded apps itself");
    }
    if (!(await androidCanFreeze())) {
      test.skip(true, "needs `adb root` to SIGSTOP an app process");
    }

    // Confirm the session first, so a hang event COULD ship if one were produced
    // — otherwise the presence gate would hold it back and this would pass for
    // the wrong reason.
    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    // A pid of 0 means the app is not running, and everything below would then
    // measure nothing.
    const pid = await androidPidOf(BUNDLE_ID);
    expect(pid).toBeGreaterThan(0);

    // Leave the app, let the background transition land, then freeze it exactly
    // as the OS would for a cached release build.
    await screen.pressButton("HOME");
    await new Promise((r) => setTimeout(r, 2_000));
    await androidFreezeProcess(pid);

    try {
      // "T" (stopped) is the assertion that the suspension actually happened.
      // Without it this test proves nothing — see the note above.
      expect(await androidProcessState(pid)).toBe("T");
      // Far past the playground's 1s hangThresholdMs.
      await new Promise((r) => setTimeout(r, 12_000));
    } finally {
      // Always resume, even on assertion failure, or the emulator is left with a
      // wedged process that breaks every later spec.
      await androidUnfreezeProcess(pid);
    }

    // Back to the foreground. An unpaused watchdog reports here, on resume.
    await device.launchApp(BUNDLE_ID);
    await new Promise((r) => setTimeout(r, 10_000));

    // Report the messages, not just a count: a failure should say how long the
    // phantom stall claimed to be.
    const hangs = (await getEvents()).filter(isHang);
    expect(
      hangs.map((h) => (h.attributes as Record<string, unknown>)["error_message"])
    ).toEqual([]);
  });
});
