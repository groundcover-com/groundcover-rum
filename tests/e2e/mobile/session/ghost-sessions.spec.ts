import { test, expect } from "@mobilewright/test";
import { expectEvents, getEvents, getStats, settleAndClear, type RumEvent } from "../support/ingest-client";
import { expectTapped, tapScrolling } from "../support/ui";
import { app, BUNDLE_ID, hasNativeEngine } from "../support/app";


const metricName = (event: RumEvent): string =>
  String((event.attributes as Record<string, unknown>)["performance_metric_name"] ?? "");

// Latest session id the ingest has seen.
async function currentSessionId(): Promise<string> {
  const events = await getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const id = (events[i]!.__sessionAttributes as { session_id?: string } | undefined)?.session_id;
    if (id) return id;
  }
  return "";
}

// The gate that decides whether a session exists at all: nothing leaves the device until
// a real user has touched the app, since shipping an untouched launch inflates every
// session count. RN's presence sources are not the browser's — no raw-input signal, so it
// rests on AppState "active" plus the touch bridge.
//
// Other specs rely on it too: app-start.spec's arrange step assumes the fixture's own launch
// reports nothing.
test.describe("rn-playground — ghost sessions", () => {
  test("a launch nobody touches sends nothing, and the first tap releases the lead-up", async ({
    screen,
    device,
  }) => {
    test.setTimeout(180_000);

    // Arrange: a session that has NEVER been confirmed. Not obvious, and indispensable —
    // the gate is a property of the persisted session, so a plain relaunch reattaches to
    // whatever an earlier spec confirmed and ships immediately. That is correct (a
    // returning user is not a ghost) but would fail a test that skipped this step against
    // a healthy SDK. "forget session" drops the keys so the next launch is a first visit.
    //
    // The outgoing id is recorded first so the forget is verified by its EFFECT — a new
    // id — rather than an on-screen status line the driver cannot scroll back to.
    await settleAndClear();
    await screen.getByText(/Increment counter/).tap();
    await expectTapped(app.wellTaggedLabel);
    const forgottenSessionId = await currentSessionId();
    expect(forgottenSessionId).not.toBe("");

    await screen.getByLabel("Config tab").tap();
    await tapScrolling(screen, "forget session");
    await expectTapped("forget session");

    // Our OWN launch, into a quiet ingest. settleAndClear rather than
    // clearEvents: the previous spec's flush is on a timer, and a batch of ITS
    // events landing here would look exactly like a gate failure.
    await device.terminateApp(BUNDLE_ID);
    await settleAndClear();
    await device.launchApp(BUNDLE_ID);

    // Wait until the app is genuinely up and then some. By this point every
    // producer has run: listeners are armed, the native trackers have attached,
    // app start has been measured, and the frame-vitals tracker is counting. So
    // events EXIST — the only reason none of them ships is the gate.
    await expect(screen.getByText("Taps")).toBeVisible({ timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 6_000)); // 12x the 500ms batch timeout

    // Assert: not "no interaction events" — NO BATCH AT ALL. Counting requests
    // rather than events is what makes this airtight: an SDK that POSTs an empty
    // or session-only batch has still minted a session on the backend, and an
    // event-level assertion would call that a pass.
    const idle = await getStats();
    expect(idle.requests).toBe(0);
    expect(idle.batches).toBe(0);

    // Act: one real tap — the only thing that confirms a user.
    await screen.getByText(/Increment counter/).tap();

    // Assert: the lead-up is RELEASED, not discarded. `app_start_cold` was
    // measured long before this tap (its anchors predate JavaScript), so its
    // arrival now proves the buffered pre-confirmation events were held and then
    // flushed under the confirmed session — the browser suite's case C.
    //
    // Waiting on the interaction alone would be much weaker: it was produced
    // after the gate opened, so it cannot distinguish "buffered then released"
    // from "dropped everything before the tap and started fresh".
    //
    // Native signals only: an app without the engine has no pre-tap app start to release.
    if (hasNativeEngine) {
      const [cold] = await expectEvents("performance", {
        timeout: 45_000,
        where: (e) => metricName(e) === "app_start_cold",
        describe: "the pre-tap app-start metric, released by the first tap",
      });
      expect(cold).toBeTruthy();
    }

    await expectEvents("interaction", {
      where: (e) =>
        app.wellTaggedLabel.test(
          String((e.attributes as Record<string, unknown>)["interaction_target.label"] ?? "")
        ),
      describe: "the confirming tap itself",
    });

    // And the arrangement really did what it claimed: this is a NEW session, not
    // the confirmed one from the top of the test reattached. Without this the
    // whole test could pass on an SDK whose gate never opens — and it also proves
    // "forget session" cleared the persisted keys, which is the step every
    // assertion above depends on.
    const freshSessionId = await currentSessionId();
    expect(freshSessionId).not.toBe("");
    expect(freshSessionId).not.toBe(forgottenSessionId);
  });
});
