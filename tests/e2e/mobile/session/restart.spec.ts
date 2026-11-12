import { test, expect } from "@mobilewright/test";
import { clearEvents, getEvents, waitForEvents } from "../support/ingest-client";
import { BUNDLE_ID } from "../support/app";


// Read the session id off the most recent recorded batch (carried on every
// event as __sessionAttributes.session_id).
async function currentSessionId(): Promise<string> {
  const events = await getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const id = (events[i]!.__sessionAttributes as { session_id?: string } | undefined)?.session_id;
    if (id) return id;
  }
  return "";
}

// The single highest-value on-device case: continuity across a REAL process
// kill + relaunch. HydratedStorage bridges the async AsyncStorage native module
// to core's synchronous storage contract, and bootstrapSession reattaches to the
// persisted session on the next launch. Unit tests only exercise a JS Map stub —
// only a real kill/relaunch proves the native module actually persisted the
// session and that hydrate() seeds it before the composition root reads it.
test.describe("rn-playground — session continuity across restart", () => {
  test("the same session id survives a terminate + relaunch (within the gap window)", async ({
    screen,
    device,
  }) => {
    test.setTimeout(120_000); // cold relaunch reloads the JS bundle + re-hydrates

    // Arrange: start clean, confirm a session (a tap is presence), and capture
    // its id. Then give the write-through cache's fire-and-forget AsyncStorage
    // writes a moment to flush before the kill (steady-state writes are async).
    await clearEvents();
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction");
    const before = await currentSessionId();
    expect(before).not.toBe("");
    await new Promise((r) => setTimeout(r, 2_000));

    // Act: terminate and relaunch the app, then drop the pre-restart batches so
    // we read a fresh post-restart one. Tap again on the relaunched app to
    // confirm + flush the restored session. Generous timeout: a cold relaunch
    // reconnects to Metro and reloads the JS bundle before the button is tappable.
    await device.terminateApp(BUNDLE_ID);
    await device.launchApp(BUNDLE_ID);
    await clearEvents();
    await screen.getByText(/Increment counter/).tap({ timeout: 45_000 });
    await waitForEvents("interaction", { timeout: 40_000 });
    const after = await currentSessionId();

    // Assert: the persisted session was restored, not rotated.
    expect(after).not.toBe("");
    expect(after).toBe(before);
  });
});
