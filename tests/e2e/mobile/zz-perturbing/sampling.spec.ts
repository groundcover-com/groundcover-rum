import { test, expect } from "@mobilewright/test";
import { getStats, settleAndClear } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset } from "../support/preset";
import { expectAppAlive } from "../support/ui";
import { app } from "../support/app";

// `sessionSampleRate: 0`, where the correct behaviour is silence — indistinguishable from
// a broken SDK unless the test proves the app is otherwise working. Worth a device rather
// than a unit test for two reasons: "the SDK sent nothing" is the failure customers notice
// last and complain about loudest, and an explicit 0 is a real trap here, since `undefined`
// means "sample everything" and any falsy check inverts a 0 into exactly that — a privacy
// incident rather than a bug.
test.describe("rn-playground — session sampling", () => {
  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("an unsampled session arms nothing and sends nothing", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "unsampled");
    await settleAndClear();

    // Do the things that would each produce a batch under any other config: a
    // tap, a log, and a network request. Three surfaces rather than one, because
    // the early return has to hold for every listener — a sampling check that
    // only gated the interaction path would pass a single-surface test.
    await screen.getByLabel("Taps tab").tap();
    await screen.getByText(/Increment counter/).tap();
    await screen.getByLabel("Logs tab").tap();
    await screen.getByText(app.platformLog.button).tap();
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("fetch GET").tap();

    // THE NEGATIVE CONTROL, and the reason this test is worth anything. Every
    // assertion below is satisfied by an app that never received a single tap — a
    // locator that silently missed, a screen that never rendered, a wedged
    // emulator. This probe presses a control and reads the state it changed, using
    // no telemetry at all (which is the point, since telemetry is what is
    // suppressed here): the app is demonstrably live and simply choosing not to
    // report.
    await expectAppAlive(screen);

    // 12x the batch timeout, and long enough for the frame-vitals segments the
    // tab switches closed and the app-start metrics to have been produced and
    // dropped.
    await new Promise((r) => setTimeout(r, 6_000));

    // Counted at the REQUEST level, not the event level. An unsampled session
    // must not even open a connection: a batch carrying zero events still mints a
    // session server-side, and `events === 0` would call that a pass.
    // An unsampled session must not POST at all.
    const stats = await getStats();
    expect(stats.requests).toBe(0);
    expect(stats.batches).toBe(0);
  });

  // The opposite half — an unsampled launch STILL draining a crash from an earlier sampled
  // session — is untested here for harness reasons, not doubt about the claim. It needs the
  // preset to change between the crash and the very next launch, but switching presets IS a
  // relaunch, and that relaunch is the one the drain fires on: the arrangement would be a
  // coin toss rather than a fixture.
  test.fixme("an unsampled launch still drains a crash from a sampled session", async () => {
    // Intentionally empty: see above.
  });
});
