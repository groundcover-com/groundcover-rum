import { test, expect } from "@mobilewright/test";
import type { Screen } from "@mobilewright/core";
import { androidRendererIsSoftware, androidSwipe } from "../support/android-device";
import { clearEvents, expectEvents, getEvents, type RumEvent } from "../support/ingest-client";
import { app } from "../support/app";

const attrs = (event: RumEvent): Record<string, unknown> =>
  (event.attributes ?? {}) as Record<string, unknown>;

const kind = (event: RumEvent): string => String(attrs(event)["interaction_type"] ?? "");

const label = (event: RumEvent): string => String(attrs(event)["interaction_target.label"] ?? "");

const gesture = (event: RumEvent, key: string): unknown => attrs(event)[`interaction_gesture.${key}`];

const num = (event: RumEvent, key: string): number => Number(gesture(event, key) ?? NaN);

const isMovement = (e: RumEvent) => kind(e) === "scroll" || kind(e) === "swipe";

type Platform = "ios" | "android";

/**
 * `scroll` and `swipe` are one motion told apart by release velocity, against a
 * platform-specific threshold: iOS uses our `swipeVelocityDpS` (300), Android just
 * asks whether GestureDetector called `onFling` (~50 dp/s). So a profile is a
 * distance AND a speed.
 */
type DragProfile = {
  /** Travel handed to the driver: device pixels on Android, points on iOS. */
  distance: number;
  /**
   * How long the drag takes, in ms, handed to the driver — or omitted, which leaves
   * the speed to the driver's own default. Stated on iOS because the iOS agent
   * defaults to ~115ms (mobilecli 1.0.2 and later), which would turn the 50-point
   * scroll below into a swipe.
   */
  duration?: number;
  /**
   * Band the SDK should report back, two-sided on purpose: both trackers refuse to
   * emit under 32dp, so any floor at or below that cannot fail. The upper bound is
   * what catches reading device pixels as points (a ~2.6-3x shift).
   */
  distanceDpRange: [min: number, max: number];
};

const SCROLL_DRAG: Record<Platform, DragProfile> = {
  // At the emulator's 2.625 density, 100px = 38dp. Boxed in from both sides —
  // over the tracker's 32dp emit cutoff, under the ~50 dp/s fling minimum.
  android: { distance: 100, distanceDpRange: [33, 49] },
  // 50 points over 1s is ~50 dp/s, a sixth of the 300 dp/s swipe threshold. The
  // `[gesture]` line logged below carries the real numbers for re-narrowing.
  ios: { distance: 50, duration: 1000, distanceDpRange: [33, 90] },
};

const SWIPE_DRAG: Record<Platform, DragProfile> = {
  android: { distance: 400, distanceDpRange: [100, 220] },
  // 450 points over 150ms is ~3000 dp/s, ten times the threshold.
  ios: { distance: 450, duration: 150, distanceDpRange: [300, 650] },
};

// 400px / 2.625 = 152dp over 250ms is ~610 dp/s, clearing the 300 dp/s threshold
// with room. The duration is `adb input swipe`'s, which is why the Android swipe
// below goes straight to adb rather than through the harness (see the comment there).
const ANDROID_SWIPE_DURATION_MS = 250;

// Anchored on a ROW, not the list: iOS does not expose a scroll container as an
// accessibility element. `locator.swipe()` is no use either — it drops `distance`.
// The row must already be on screen (`boundingBox` will not scroll to find it), so
// a test may perform only ONE drag.
async function dragFromRow(screen: Screen, profile: DragProfile, row = "Row 3"): Promise<void> {
  const box = await screen.getByText(row).boundingBox();
  await screen.swipe("up", {
    startX: Math.round(box.x + box.width / 2),
    startY: Math.round(box.y + box.height / 2),
    distance: profile.distance,
    ...(profile.duration !== undefined && { duration: profile.duration }),
  });
}

/**
 * Everything true of any natively-measured movement, so the two specs below read as
 * what separates them — release velocity — rather than as near-copies.
 */
function expectNativeMovement(
  movement: RumEvent,
  distanceDpRange: [number, number],
  opts: { velocityMeasurable: boolean } = { velocityMeasurable: true }
): void {
  // Printed on every run: gesture duration is not controllable and differs per
  // platform, so recalibrating the constants above for a new device profile needs
  // to see what that profile actually produced.
  // eslint-disable-next-line no-console
  console.log(
    `[gesture] kind=${kind(movement)} distance_dp=${num(movement, "distance_dp")} ` +
      `velocity_dp_s=${num(movement, "velocity_dp_s")} duration_ms=${num(movement, "duration_ms")} ` +
      `label=${JSON.stringify(label(movement))}`
  );

  expect(["up", "down", "left", "right"]).toContain(gesture(movement, "direction"));
  expect(num(movement, "duration_ms")).toBeGreaterThanOrEqual(0);
  expect(num(movement, "pointer_count")).toBeGreaterThanOrEqual(1);

  // THE assertion. A dev build must attach natively, and once it reports attached
  // the JS classifier stands down for these two kinds — so "js" means the native
  // tracker failed to hook a real window and lied about it in nativeInit. Accepting
  // either value would pass with native capture completely dead.
  expect(gesture(movement, "capture_source")).toBe(app.movementCaptureSource);

  // Native watches the gesture to its end, so it never reports a truncated one.
  expect(gesture(movement, "partial")).toBeUndefined();

  // The other half of the hybrid: correlation failing is a supported path (the event
  // ships unlabelled), so nothing above would notice an uncorrelated gesture. The
  // label is the fiber COMPONENT name, asserted non-empty rather than by name. Not
  // covered: a press-then-drag that pauses, which breaks the touch-DOWN convention.
  expect(label(movement)).not.toBe("");
  expect(String(attrs(movement)["interaction_component_path"] ?? "")).toContain(">");

  // Bounded on both sides — see DragProfile.distanceDpRange for why a floor alone
  // cannot fail.
  const [minDp, maxDp] = distanceDpRange;
  expect(num(movement, "distance_dp")).toBeGreaterThan(minDp);
  expect(num(movement, "distance_dp")).toBeLessThan(maxDp);

  // velocity_dp_s must agree with the distance and duration the SAME event reports —
  // catching a wrong denominator, a s/ms slip or a dp/px confusion. Comparing it to
  // the 300 dp/s threshold instead restates the branch that chose the kind.
  // Skipped on a software renderer, where VelocityTracker correctly reports zero.
  if (!opts.velocityMeasurable) return;
  const durationSec = num(movement, "duration_ms") / 1000;
  const impliedDpS = num(movement, "distance_dp") / durationSec;
  expect(num(movement, "velocity_dp_s")).toBeGreaterThan(impliedDpS / 3);
  expect(num(movement, "velocity_dp_s")).toBeLessThan(impliedDpS * 3);
}

// One spec per gesture kind, because they do not share a code path: movements are
// measured natively and suppressed in JS, long presses and pinches are classified
// in JS and must survive that suppression, and taps are what a broader classifier
// could most easily break.
test.describe("rn-playground — gestures", () => {
  test.beforeEach(async ({ screen }) => {
    await screen.getByLabel("Native tab").tap();
    await clearEvents();
  });

  // The two specs below vary ONLY travel distance. A single test accepting either
  // kind would pass with the classifier collapsed to one.

  test("a slow drag that comes to rest is reported as a scroll", async ({ screen, platform }) => {
    test.setTimeout(90_000);

    const os: Platform = platform === "android" ? "android" : "ios";
    const profile = SCROLL_DRAG[os];
    // A software renderer starves VelocityTracker, so Android reports zero. The
    // KIND is still right (zero is under the threshold); the band is not assertable.
    const velocityMeasurable = os !== "android" || !(await androidRendererIsSoftware());
    await dragFromRow(screen, profile);

    // Wait for the MOVEMENT, not "any interaction": the beforeEach tab tap can land
    // after clearEvents (the flush is on a timer) and would satisfy a bare wait long
    // before the native tracker has reported anything.
    const [movement] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) => kind(e) === "scroll",
      describe: "a scroll",
    });

    expectNativeMovement(movement!, profile.distanceDpRange, { velocityMeasurable });
    expect(kind(movement!)).toBe("scroll");

    // Exactly one event per gesture, counting either kind. Both sides watch the same
    // touches, so a suppression bug shows up as a duplicate rather than an error.
    const movements = (await getEvents()).filter((e) => e.type === "interaction" && isMovement(e));
    expect(movements).toHaveLength(1);
  });

  test("a fast flick released with momentum is reported as a swipe", async ({ screen, platform }) => {
    test.setTimeout(90_000);

    // `onFling` needs two VelocityTracker samples inside a ~100ms horizon, and a
    // software rasterizer paints this screen at 150-300ms per frame — so the estimate
    // is always zero and the gate never opens: the same input reports a `scroll` under
    // swiftshader and a `swipe` under `-gpu host`.
    //
    // Skipped, not asserted-around: accepting either kind would let a fling reported
    // as a scroll pass. The Android fling path is therefore not covered on CI's
    // software-rendered emulators; it needs a GPU-backed emulator or a device.
    if (platform === "android" && (await androidRendererIsSoftware())) {
      test.skip(
        true,
        "software renderer (SwiftShader): frame cadence exceeds VelocityTracker's ~100ms horizon, so the OS cannot report a fling — see the comment above"
      );
    }

    const os: Platform = platform === "android" ? "android" : "ios";
    const profile = SWIPE_DRAG[os];
    if (os === "android") {
      // Straight to adb, which replays the drag over exactly ANDROID_SWIPE_DURATION_MS.
      // The harness takes a `duration` too (mobilecli 1.0.2 and later), but drives it
      // through its on-device agent, whose pacing the thresholds above do not assume.
      const box = await screen.getByText("Row 3").boundingBox();
      const startX = Math.round(box.x + box.width / 2);
      const startY = Math.round(box.y + box.height / 2);
      await androidSwipe(
        { x: startX, y: startY },
        { x: startX, y: startY - profile.distance },
        ANDROID_SWIPE_DURATION_MS
      );
    } else {
      await dragFromRow(screen, profile);
    }

    const [movement] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) => kind(e) === "swipe",
      describe: "a swipe",
    });

    expectNativeMovement(movement!, profile.distanceDpRange);
    expect(kind(movement!)).toBe("swipe");

    const movements = (await getEvents()).filter((e) => e.type === "interaction" && isMovement(e));
    expect(movements).toHaveLength(1);
  });

  /**
   * A drag inside a React Native `Modal`, which is a SEPARATE native surface: its own `UIWindow`
   * on iOS, a `Dialog` — and so a second `Window` — on Android.
   *
   * The two trackers hook different things, and that difference is invisible to JavaScript:
   *
   *  - iOS attaches per `UIWindow`, so it covers the modal and measures the drag natively.
   *  - Android attaches per ACTIVITY (`ActivityLifecycleCallbacks`), and a Dialog is not an
   *    Activity, so no lifecycle callback ever fires for it and native never sees the drag.
   *
   * JavaScript cannot tell those two cases apart, because `gestures_attached` is one app-wide
   * boolean. It reports "attached" from the main activity and JS then stands down EVERYWHERE —
   * including on a surface native is not watching. The drag is measured by nobody and no
   * `interaction` is reported at all.
   *
   * So `capture_source` is asserted PER PLATFORM rather than accepting either value: which side
   * measures a modal gesture is a real, permanent platform difference, and a test that shrugged at
   * it would pass with the surface uncovered on both.
   */
  test("a drag inside a modal is reported, whichever side can see that surface", async ({
    screen,
    platform,
  }) => {
    test.setTimeout(90_000);

    const os: Platform = platform === "android" ? "android" : "ios";
    const profile = SCROLL_DRAG[os];

    await screen.getByLabel("Open modal").tap();
    // The modal renders into its own surface; wait for its content rather than a timer, so a slow
    // present cannot be mistaken for a lost gesture below.
    await expect(screen.getByText("Modal row 1")).toBeVisible();
    // Drop the tap that opened it — otherwise the movement wait below is satisfied by that tap.
    await clearEvents();

    await dragFromRow(screen, profile, "Modal row 3");

    const [movement] = await expectEvents("interaction", {
      timeout: 30_000,
      where: isMovement,
      describe: "a scroll or swipe inside the modal",
    });

    // The label proves the drag was measured INSIDE the modal, not on the list behind it.
    expect(label(movement!)).toContain("Modal row");

    // Which side can see the modal's surface; see the profile.
    expect(gesture(movement!, "capture_source")).toBe(app.modalMovementCaptureSource(os));
  });

  test("a long press is reported by JavaScript, which native never suppresses", async ({
    screen,
  }) => {
    test.setTimeout(60_000);

    // An inert list row: holding it cannot fire an onPress, and a stray drag would
    // show up as a scroll instead. Every button here either crashes the app or
    // blocks the main thread on release.
    await screen.getByText("Row 3").longPress({ duration: 1_200 });

    const [pressed] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) => kind(e) === "long_press",
      describe: "a long press",
    });

    // Native reports no such kind, so suppression must not reach it — widening the
    // condition by one kind would make long presses vanish silently.
    expect(gesture(pressed!, "capture_source")).toBe(app.frameworkCaptureSource);
    expect(num(pressed!, "duration_ms")).toBeGreaterThan(500); // TAP_MAX_DURATION_MS
    expect(num(pressed!, "distance_dp")).toBeLessThanOrEqual(10); // TAP_SLOP_DP
    expect(num(pressed!, "pointer_count")).toBe(1);
    expect(label(pressed!)).toMatch(/^Row \d+$/);
  });

  // Undrivable: the device agent rejects a multi-pointer gesture on both platforms
  // ("cannot unmarshal array into Go value of type wda.TapAction"). An upstream
  // limitation, since @mobilewright/protocol declares `GestureSequence { pointers: [][] }`
  // the agent cannot accept — not fixable from this suite.
  //
  // The JS path is covered off-device by gesture-classification.test.ts,
  // GroundcoverProvider.test.ts and gesture-suppression.test.ts; only "the OS hands
  // us both touches" is untested, and that is React Native's contract.
  test.fixme("a two-finger gesture is reported as a pinch", async () => {
    // Intentionally empty: see above.
  });

  test("a tap is still a tap, not a zero-distance swipe", async ({ screen }) => {
    // What a broader classifier could plausibly get wrong. Keyed on the button's own
    // label so a stray tab-tap interaction cannot satisfy it.
    await screen.getByLabel("Block main thread").tap();

    const [pressed] = await expectEvents("interaction", {
      where: (e) => label(e) === "Block main thread",
      describe: 'a tap on "Block main thread"',
    });
    expect(kind(pressed!)).toBe("tap");
    expect(gesture(pressed!, "direction")).toBeUndefined();
  });
});
