import { test, expect } from "@mobilewright/test";
import { getEvents, settleAndClear, waitForEvents } from "../support/ingest-client";
import { BUNDLE_ID } from "../support/app";
import { expectTapped, tapScrolling } from "../support/ui";

// Session rotation on device. The browser suite has a spec each for the
// inactivity gap and the max duration; the lifecycle code is shared core, so the
// same rules hold here.
//
// The browser drives this with a mocked clock, which a device does not offer. The
// equivalent here is to backdate the PERSISTED anchor and relaunch, which is
// arguably the better test: rotation is decided in bootstrapSession from exactly
// those stored values, so this drives the real production path — an app that was
// killed and reopened later — rather than a virtualised timer.
async function currentSessionId(): Promise<string> {
  const events = await getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const id = (events[i]!.__sessionAttributes as { session_id?: string } | undefined)?.session_id;
    if (id) return id;
  }
  return "";
}

test.describe("rn-playground — session rotation", () => {
  test("an inactivity gap past 30 minutes rotates the session on the next launch", async ({
    screen,
    device,
  }) => {
    test.setTimeout(180_000);

    // Establish a confirmed session and read its id.
    await settleAndClear();
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction", { timeout: 30_000 });
    const before = await currentSessionId();
    expect(before).not.toBe("");

    // Backdate the activity clock past SESSION_INACTIVITY_TIMEOUT_MS (30 min),
    // then relaunch so bootstrapSession reads it.
    await screen.getByLabel("Config tab").tap();
    await tapScrolling(screen, "backdate activity 31m");
    await expectTapped("backdate activity 31m");

    await device.terminateApp(BUNDLE_ID);
    await device.launchApp(BUNDLE_ID);
    await settleAndClear();

    // Rotation is LAZY — it happens on the first activity after the gap, not at
    // rest — so a tap is part of the arrangement rather than incidental.
    await screen.getByText(/Increment counter/).tap({ timeout: 45_000 });
    await waitForEvents("interaction", { timeout: 40_000 });
    const after = await currentSessionId();

    expect(after).not.toBe("");
    // The comparison that matters. `restart.spec.ts` asserts the exact opposite
    // for a relaunch INSIDE the window, so the two together pin the boundary
    // rather than just one side of it — a session id generator that rotated on
    // every launch would pass this test alone.
    expect(after).not.toBe(before);
  });

  test("crossing the max-duration cap rotates the session", async ({ screen, device }) => {
    test.setTimeout(180_000);

    await settleAndClear();
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction", { timeout: 30_000 });
    const before = await currentSessionId();
    expect(before).not.toBe("");

    // Backdate the session's START past the default 4h cap. Note this needs no
    // preset: the browser playground drops its cap to the 60s minimum to make the
    // wait affordable, and moving the anchor instead costs nothing at all and
    // tests the shipped default rather than a test-only value.
    await screen.getByLabel("Config tab").tap();
    await tapScrolling(screen, "backdate session start 5h");
    await expectTapped("backdate session start 5h");

    await device.terminateApp(BUNDLE_ID);
    await device.launchApp(BUNDLE_ID);
    await settleAndClear();

    await screen.getByText(/Increment counter/).tap({ timeout: 45_000 });
    await waitForEvents("interaction", { timeout: 40_000 });
    const after = await currentSessionId();

    expect(after).not.toBe("");
    expect(after).not.toBe(before);
  });
});
