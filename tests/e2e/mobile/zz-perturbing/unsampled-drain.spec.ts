import { test, expect } from "@mobilewright/test";
import {
  expectEvents,
  failNextBatches,
  getEvents,
  getStats,
  settleAndClear,
  waitForEvents,
} from "../support/ingest-client";
import { BUNDLE_ID } from "../support/app";
import { activatePreset, restoreDefaultPreset } from "../support/preset";

function sessionIdOf(event: { __sessionAttributes?: unknown }): string {
  return (event.__sessionAttributes as { session_id?: string } | undefined)?.session_id ?? "";
}

/** `error_metadata.fatal` survives `JSON.parse` as a real boolean, so compare as one — a
 *  string `"true"` from some other source must not satisfy this. */
function isNativeFatal(event: { attributes?: unknown }): boolean {
  const attrs = event.attributes as Record<string, unknown> | undefined;
  return attrs?.["error_metadata.fatal"] === true && attrs?.["error_metadata.native"] === true;
}

// The one claim the composition root makes that nothing else verifies: SAMPLING GATES CAPTURE,
// NOT DELIVERY.
//
// An unsampled launch arms crash capture only, so the engine can harvest stored reports, and clears
// the session snapshot — an unsampled session emits nothing, and that has to include a crash it
// might produce. But the drain still runs, because a fatal from an
// EARLIER, sampled session is already on disk and belongs to a session that was sampled in.
// Dropping it would mean a customer who lowers `sessionSampleRate` silently loses crashes that were
// already captured.
//
// Not reachable from the unit suite, which stubs the native module: the record has to survive a real
// process death and be read back by a DIFFERENT launch running a DIFFERENT config. Two processes,
// two configs, one file on disk.
test.describe("rn-playground — sampling gates capture, not delivery", { tag: "@native" }, () => {
  test.afterEach(async ({ platform }) => {
    // Unconditional, in both directions: a spec that fails between arming and disarming would
    // otherwise leave the ingest rejecting for whatever runs next.
    await failNextBatches(0);
    await restoreDefaultPreset({ platform });
  });

  test("a crash captured while sampled is still delivered on a launch that is not", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(300_000); // a crash, a Metro re-bundle, up to three relaunches, a redelivery

    // RUNS ON BOTH PLATFORMS. On iOS the HARVEST — transcribing KSCrash's store into our pending
    // records — lives inside the engine's `config.features.crashes` block, so if `armNative` gated
    // that flag on the current launch's sampling verdict, an unsampled launch would never harvest
    // and a crash from a previous SAMPLED session would not be delivered at all, waiting in
    // KSCrash's own store (10-report cap) for some future sampled launch. Android's handler writes
    // self-contained records at crash time, so it does not depend on the harvest.
    //
    // `crashes` is gated on config alone, and the composition root clears the session snapshot
    // once init settles so an unsampled session's own crash stays unattributable. On iOS this is
    // the only check that the harvest stays independent of sampling.

    // ── Arrange, on the DEFAULT (sampled) preset ──
    // `settleAndClear` rather than `clearEvents`: an in-flight POST landing after a bare clear
    // would leave a PRE-clear batch in the recorder, and the session oracle below would read it.
    await settleAndClear();

    await screen.getByLabel("Native tab").tap();
    // A tap both confirms the session — opening the send gate — and gets a batch out so its
    // envelope is readable. Row 3 rather than a native button: no side effects.
    await screen.getByText("Row 3").tap();

    // The oracle is THIS interaction's envelope, not "the newest event in the recorder": a later
    // navigation or a late batch could otherwise supply it, and the comparison at the end would be
    // against a session the crash never belonged to.
    const [interaction] = await waitForEvents("interaction");
    const sampledSessionId = sessionIdOf(interaction!);
    expect(sampledSessionId).not.toBe("");

    // Let the debounced snapshot write reach disk before killing the process — without it there is
    // no envelope to attribute the crash to and this would pass for the wrong reason.
    await new Promise((r) => setTimeout(r, 2_000));

    // ── Act I: crash, and make sure NOTHING can ack the record before the preset is live ──
    //
    // This is what makes the assertion mean what its name says. `activatePreset` relaunches up to
    // three times (the first can outrun Metro's watcher) and the drain fires at EVERY init, so a
    // stale-bundle attempt still running the DEFAULT preset would deliver and ack the record — and
    // an assertion that merely looked for the crash somewhere in the recorder would pass on that,
    // proving nothing about an unsampled launch. A rejecting ingest keeps the record un-acked
    // through those attempts, so the delivery asserted below can only be the one after the preset
    // is confirmed.
    const armed = await failNextBatches(200, 500);
    expect(armed.failRemaining).toBe(200);

    await screen.getByLabel("Crash natively").tap();
    await new Promise((r) => setTimeout(r, 3_000)); // the process dies

    // Called with the app DEAD, necessarily: no launch may deliver this record before the preset
    // is live. `activatePreset` tolerates a terminate with no process to kill for that reason —
    // see its comment.
    await activatePreset({ screen, device, platform }, "unsampled");

    // The drain TRIED and was refused, on at least one launch. Asserted rather than assumed: a
    // drain that never fired would leave this at 0, and everything below would then be measuring
    // a record nothing had touched.
    const deadline = Date.now() + 60_000;
    let rejected = 0;
    while (Date.now() < deadline) {
      rejected = (await getStats()).rejectedBatches;
      if (rejected > 0) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(rejected).toBeGreaterThan(0);

    // ── Act II: the preset is confirmed unsampled. Open the ingest and relaunch. ──
    await failNextBatches(0);
    // Clear HERE, so everything asserted below arrived on a launch whose preset is already known.
    await settleAndClear();

    await device.terminateApp(BUNDLE_ID);
    await device.launchApp(BUNDLE_ID);

    // ── Assert ──
    const [crash] = await expectEvents("exception", {
      timeout: 120_000,
      where: isNativeFatal,
      describe: "the fatal from the previous, sampled session, redelivered on an unsampled launch",
    });

    // Under the envelope the CRASHED session left behind — not the unsampled launch's, and not a
    // rebuilt bare one. This is what separates "delivered" from "delivered correctly".
    expect(sessionIdOf(crash!)).toBe(sampledSessionId);
    expect(String((crash!.attributes as Record<string, unknown>)["error_metadata.crash_report_id"] ?? "")).not.toBe("");

    // And the complement, which is now safe to assert because the window is bounded to one launch
    // of known preset: the unsampled session contributed nothing of its own. Every event here
    // belongs to the session that crashed.
    const strays = (await getEvents()).filter((e) => sessionIdOf(e) !== sampledSessionId);
    expect(strays.map((e) => `${String(e.type)}/${sessionIdOf(e)}`)).toEqual([]);
  });
});
