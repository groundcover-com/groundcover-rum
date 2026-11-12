import { test, expect } from "@mobilewright/test";
import { getEvents, getStats, settleAndClear } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset } from "../support/preset";
import { expectAppAlive, tapScrolling } from "../support/ui";
import { app } from "../support/app";

// `enabledEvents` is documented as a per-signal switch — the type comment says
// "a host can keep crash reporting while opting out of, say, frame vitals" — so
// this verifies that enabling crashes alone really silences every other signal.
//
// This has to be an init-time preset rather than an updateConfig call, and
// deliberately so: SDKConfigUpdate drops the key because listeners are installed
// once, and accepting it would type-check a call that changes nothing ("the caller
// believes a signal is off and it keeps reporting").
test.describe("rn-playground — enabledEvents", () => {
  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("enabledEvents: ['crashes'] silences every other signal", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "crashes-only");
    await settleAndClear();

    // Exercise all four JS signals that are NOT enabled; the tab switches also
    // close frame-vitals segments, which a wrongly armed native tracker would
    // publish.
    await screen.getByLabel("Taps tab").tap(); // navigation
    await screen.getByText(/Increment counter/).tap(); // interaction
    await screen.getByLabel("Logs tab").tap();
    await tapScrolling(screen, app.platformLog.button); // log
    await screen.getByLabel("Network tab").tap();
    await tapScrolling(screen, "fetch GET"); // network
    await new Promise((r) => setTimeout(r, 6_000));

    // The negative control first: the app is demonstrably alive and receiving the
    // taps, so silence below is a decision rather than a dead app or a missed
    // locator.
    await expectAppAlive(screen);

    const events = await getEvents();
    const byType = (type: string) => events.filter((e) => e.type === type);

    // Each of these is a separate gate in the instrumentation manager, so they are
    // asserted separately — one combined "no events" check would not say which
    // gate leaked.
    expect(byType("interaction")).toHaveLength(0);
    expect(byType("log")).toHaveLength(0);
    expect(byType("network")).toHaveLength(0);
    expect(byType("navigation")).toHaveLength(0);
    // Native, and the reason this preset is `crashes` rather than `interaction`:
    // armNative maps each feature to its own `enabledEvents` name, so vitals and
    // app-start must stay dark while crashes stay armed.
    expect(byType("performance")).toHaveLength(0);

    // Nothing shipped at all, in fact — with no signal enabled that this run can
    // produce, the SDK should not be opening connections either.
    const stats = await getStats();
    expect(stats.requests).toBe(0);
  });
});
