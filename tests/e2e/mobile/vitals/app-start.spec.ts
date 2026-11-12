import { test, expect } from "@mobilewright/test";
import { clearEvents, getEvents, waitForEvents, type RumEvent } from "../support/ingest-client";
import { BUNDLE_ID, app } from "../support/app";


const metricName = (event: RumEvent): string =>
  String((event.attributes as Record<string, unknown>)["performance_metric_name"] ?? "");

const metricValue = (event: RumEvent): number =>
  Number((event.attributes as Record<string, unknown>)["performance_metric_value"] ?? -1);

// App start is measured from anchors stamped before JavaScript exists — the kernel's
// process-start time on iOS, a manifest ContentProvider on Android — through to the first
// frame the user sees. None of that is reachable from a unit test.
//
// A return from the background is a HOT start on both platforms: iOS anchors on
// willEnterForeground and Android on the started-Activity count going 0 -> 1, and
// HOME-then-reopen produces both. A warm start (the UI rebuilt) is not something the
// driver can force. The anchor arithmetic itself is pinned in app-start-listener.test.ts.
test.describe("rn-playground — app start", { tag: "@native" }, () => {
  test("a launch reports a cold start with a plausible duration", async ({ screen, device }) => {
    test.setTimeout(120_000);

    // Launch the app ourselves so the elapsed wall-clock is known. The fixture
    // already launched it before this body ran, and without a launch we own
    // there is no upper bound to compare the reported duration against.
    //
    // The fixture's own launch reports nothing: start metrics sit behind the
    // ghost-session gate until a tap confirms a real user, and that process is
    // terminated here before any tap happens.
    await device.terminateApp(BUNDLE_ID);
    await clearEvents();
    const launchedAtMs = Date.now();
    await device.launchApp(BUNDLE_ID);

    await screen.getByText(/Increment counter/).tap();

    // Wait for the cold-start metric specifically: frame vitals share the
    // `performance` type, and a segment closes on every navigation — including
    // the tab taps this spec makes — so "any performance event" would return one
    // of those and then look for a start metric that has not been sent yet.
    const [coldStart] = await waitForEvents("performance", {
      timeout: 45_000,
      where: (e) => metricName(e) === "app_start_cold",
    });
    expect(coldStart).toBeTruthy();

    // Bounded by what actually happened, not by the producer's own guard rails.
    // `0 < value < 60_000` would be a tautology: both native trackers already
    // reject anything outside that window before it can reach the wire, so no
    // value that arrives here could ever fail it.
    //
    // A debug build is never instant (how quick it can be is the app's: see
    // coldStartFloorMs), and the launch this test performed is bounded above by
    // the wall-clock the test itself observed.
    expect(metricValue(coldStart!)).toBeGreaterThan(app.coldStartFloorMs);
    expect(metricValue(coldStart!)).toBeLessThan(Date.now() - launchedAtMs);

    // Exactly one per launch. A re-drain bug reports the same start twice, which
    // silently doubles the launch count every dashboard divides by.
    const colds = (await getEvents()).filter(
      (e) => e.type === "performance" && metricName(e) === "app_start_cold"
    );
    expect(colds).toHaveLength(1);

    const attrs = coldStart!.attributes as Record<string, unknown>;
    expect(["cold", "cold_prewarmed"]).toContain(attrs["performance_metric_navigation_type"]);
    // Attributed to the screen the user landed on, not an empty one. The screen
    // stamp is NESTED (the enricher merges it after flattening), so read the
    // object — stringifying it would pass on "[object Object]" even when empty.
    const landedOn = attrs["screen"] as { name?: string } | undefined;
    expect(landedOn?.name).toBeTruthy();
  });

  // TTI is the half of app start that JavaScript contributes — the native first
  // frame says the app drew something, this says the user could actually use
  // it. Emitted once per cold start, so it only ever appears alongside the
  // metric above.
  test("a cold launch also reports time-to-interactive, never below the first frame", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(120_000);

    // Perform our OWN cold launch. Relying on the PREVIOUS test's start metrics
    // to straggle in after this test's clearEvents() would be a race — the batch
    // flush is on a timer — and losing it would fail here on `coldStart`, not on
    // the TTI comparison this test is actually about.
    await device.terminateApp(BUNDLE_ID);
    await clearEvents();
    await device.launchApp(BUNDLE_ID);

    // The tap is what confirms a real user: start metrics sit behind the
    // ghost-session gate until then.
    await screen.getByText(/Increment counter/).tap();

    const [coldStart] = await waitForEvents("performance", {
      timeout: 45_000,
      where: (e) => metricName(e) === "app_start_cold",
    });
    const [tti] = await waitForEvents("performance", {
      timeout: 45_000,
      where: (e) => metricName(e) === "app_start_tti",
    });
    expect(coldStart).toBeTruthy();
    expect(tti).toBeTruthy();

    // STRICTLY after the first frame, not merely clamped to it. The clamp lives
    // in JS and is unit-tested; asserting `>=` here re-tests the `Math.max` and
    // would pass even if the underlying mark were garbage, since the clamp
    // rewrites a bad value into a passing one.
    //
    // On a real launch JavaScript becomes interactive some time after the native
    // first frame, so the two being exactly equal means the clamp fired — i.e.
    // the interactive mark landed at or before the frame that preceded it, and
    // is being masked rather than measured.
    //
    // Except where the app's first screen lands with the first frame (see the profile's
    // ttiMayEqualColdStartOn): there equality is the measurement, and only below is wrong.
    if (app.ttiMayEqualColdStartOn.some((os) => os === platform)) {
      expect(metricValue(tti!)).toBeGreaterThanOrEqual(metricValue(coldStart!));
      // Bounded too, so this branch can still fail: the first screen lands with the first frame,
      // and a mark that drifted (seconds later, or a garbage anchor) would read as far above it.
      expect(metricValue(tti!) - metricValue(coldStart!)).toBeLessThan(1_000);
    } else {
      expect(metricValue(tti!)).toBeGreaterThan(metricValue(coldStart!));
    }
    expect(metricValue(tti!)).toBeLessThan(60_000);
    // TTI is part of the cold launch, so it is stamped with the same anchor.
    expect(["cold", "cold_prewarmed"]).toContain(
      (tti!.attributes as Record<string, unknown>)["performance_metric_navigation_type"]
    );
  });

  /**
   * A HOT start — backgrounded, then reopened with the UI still intact — on BOTH platforms.
   *
   * Both platforms count the same population under this name: iOS reports what
   * `willEnterForegroundNotification` observes, and Android reports the 0 -> 1 started-Activity
   * edge, which is the same event. Were Android to anchor a foreground return on a new Activity
   * instead, it would report almost nothing where iOS reports one per return, and a dashboard
   * splitting by `os.name` would read a definitional difference as a performance gap — which is
   * why this runs on Android too.
   *
   * `warm` is reserved for the case where the UI is genuinely rebuilt — which HOME-then-reopen does
   * not do, and which the driver cannot force, so it is uncovered here and pinned in the unit
   * tiers instead.
   */
  test("a return from the background reports a HOT start, on both platforms", async ({
    screen,
    device,
  }) => {
    test.setTimeout(150_000);

    // A cold launch we own, confirmed by a tap so the gate is open before the interesting part.
    await device.terminateApp(BUNDLE_ID);
    await clearEvents();
    await device.launchApp(BUNDLE_ID);
    await screen.getByText(/Increment counter/).tap({ timeout: 60_000 });
    await waitForEvents("interaction", { timeout: 45_000 });

    // Drop the cold metrics so the assertion below cannot be satisfied by them.
    await new Promise((r) => setTimeout(r, 3_000));
    await clearEvents();

    // Background, then return. iOS anchors on willEnterForeground; Android on the started-Activity
    // count going 0 -> 1. Neither recreates the Activity, which is what makes this HOT and not warm.
    await screen.pressButton("HOME");
    await new Promise((r) => setTimeout(r, 3_000));
    await device.launchApp(BUNDLE_ID);
    await screen.getByText(/Increment counter/).tap({ timeout: 60_000 });

    const [hot] = await waitForEvents("performance", {
      timeout: 45_000,
      where: (e) => metricName(e) === "app_start_hot",
    });
    expect(hot).toBeTruthy();

    // A plausible resume duration: positive, and far below a launch. Explicitly what this does NOT
    // prove — the process is seconds old, so it cannot tell a hot start measured from the
    // foreground transition from one wrongly measured from process start. That arithmetic is
    // pinned in app-start-listener.test.ts, which anchors one two hours in.
    expect(metricValue(hot!)).toBeGreaterThan(0);
    expect(metricValue(hot!)).toBeLessThan(10_000);
    expect((hot!.attributes as Record<string, unknown>)["performance_metric_navigation_type"]).toBe(
      "hot"
    );

    // ...and NOT under the warm name: reporting a foreground return as `warm` would make the two
    // platforms disagree.
    const events = await getEvents();
    expect(
      events.filter((e) => e.type === "performance" && metricName(e) === "app_start_warm")
    ).toHaveLength(0);
  });
});
