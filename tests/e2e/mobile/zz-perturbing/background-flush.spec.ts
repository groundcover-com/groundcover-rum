import { test, expect } from "@mobilewright/test";
import { expectEvents, getStats, settleAndClear } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset } from "../support/preset";
import { app } from "../support/app";

// The data-loss path: whatever is still queued when the user leaves the app.
// `RNSessionManager.handleAppStateChange` flushes on "background", and iOS suspends the
// process shortly after — so if that flush stops, every event from the last batch window
// is lost on every app exit, invisibly from inside a session that is still running.
//
// Only possible under the `slow-flush` preset: at the normal 500ms batch timeout the events
// would ship on their own before HOME could be pressed, so this would pass with the
// AppState handler deleted outright.
test.describe("rn-playground — background flush", () => {
  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("backgrounding flushes what the batch timer is still holding", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "slow-flush");

    // Confirm the session and queue an event with a label only this test uses.
    // (The Config-tab tap from activatePreset is queued too and will flush
    // alongside it — harmless, since the assertion keys on this label.)
    await screen.getByLabel("Taps tab").tap();
    await settleAndClear();
    await screen.getByText(/Increment counter/).tap();

    // Assert the timer really is holding it. Without this the test cannot tell a
    // background flush from an ordinary one, which is the entire point.
    await new Promise((r) => setTimeout(r, 8_000));
    // With a 60s batch timeout nothing can have shipped yet.
    const held = await getStats();
    expect(held.requests).toBe(0);

    // Act: leave the app.
    await screen.pressButton("HOME");

    // Assert: it shipped anyway.
    await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) =>
        app.wellTaggedLabel.test(
          String((e.attributes as Record<string, unknown>)["interaction_target.label"] ?? "")
        ),
      describe: "the queued tap, flushed by backgrounding",
    });
  });

  // The other half of the claim — "inactive" persists the activity clock but does NOT flush —
  // has no test here for harness reasons. The inactive-without-background transitions (Control
  // Centre, a permission prompt, an incoming call) are all unreachable: `pressButton` offers
  // HOME, APP_SWITCH and LOCK, and all three carry the app to "background" on both platforms,
  // so a spec built on APP_SWITCH would assert the opposite and pass for the wrong reason.
  //
  // Covered off-device by `packages/react-native/src/e2e/integration.test.ts` — "persists
  // activity on AppState 'inactive' but does NOT flush — only 'background' flushes".
  test.fixme("an inactive transition persists activity without flushing", async () => {
    // Intentionally empty: see above.
  });
});
