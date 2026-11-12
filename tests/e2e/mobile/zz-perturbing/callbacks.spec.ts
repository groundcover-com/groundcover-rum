import { test, expect } from "@mobilewright/test";
import { expectEvents, getEvents, getStats, settleAndClear, waitForEvents } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset } from "../support/preset";
import { expectAppAlive, tapScrolling } from "../support/ui";
import { app } from "../support/app";

// `beforeSend` / `enrichEvent` — the highest-blast-radius integration surface the SDK
// exposes. Attributes reach them DOT-FLATTENED, so the type deliberately refuses to
// describe the nested shape: a type-correct callback written against that shape would
// throw, and a throwing callback takes out every event, not just its own. Unit tests use a
// stub; this runs the callbacks against the real pool on a device.
const ENRICH_KEY = "e2e_enriched";
const ENRICH_VALUE = "by-enrich-event";
const DROP_MARKER = "DROPME";

const label = (event: { attributes?: Record<string, unknown> }): string =>
  String((event.attributes as Record<string, unknown>)["interaction_target.label"] ?? "");

test.describe("rn-playground — beforeSend / enrichEvent", () => {
  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("beforeSend drops only what it rejects, and enrichEvent stamps every type", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "callbacks");
    await settleAndClear();

    // Two taps: one the hook rejects, one it accepts. The survivor is what makes
    // the drop meaningful — "no event with the marker arrived" is equally true of
    // an SDK that has stopped reporting entirely, which is exactly what a
    // callback bug looks like.
    await tapScrolling(screen, new RegExp(DROP_MARKER));
    await tapScrolling(screen, /tap survivor/);

    const [survivor] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) => label(e).includes("survivor"),
      describe: "the tap beforeSend accepted",
    });
    expect(survivor).toBeTruthy();

    // The rejected one is absent. Checked AFTER the survivor arrived, so the
    // absence is a real verdict rather than a race against a batch still in
    // flight — both taps were queued before that flush.
    // beforeSend returned false for this one, so it must be absent.
    const dropped = (await getEvents()).filter((e) => label(e).includes(DROP_MARKER));
    expect(dropped).toHaveLength(0);

    // enrichEvent's attribute rides on the accepted event...
    expect((survivor!.attributes as Record<string, unknown>)[ENRICH_KEY]).toBe(ENRICH_VALUE);

    // ...and on an unrelated event TYPE. The callbacks are invoked from
    // EventsPool.addEvent, so they see everything; a regression that wired them
    // to one listener would satisfy every assertion above.
    await screen.getByLabel("Logs tab").tap();
    await screen.getByText(app.platformLog.button).tap();
    const [log] = await expectEvents("log", {
      timeout: 30_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)["message"] ?? "").includes(
          app.platformLog.message
        ),
      describe: "a log event, to prove enrichment is not interaction-only",
    });
    expect((log!.attributes as Record<string, unknown>)[ENRICH_KEY]).toBe(ENRICH_VALUE);
  });

  test("a beforeSend that throws is contained by the SDK, and drops events fail-closed", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "callbacks-throw");
    await settleAndClear();

    await tapScrolling(screen, /tap survivor/);

    // The contract is fail-closed: beforeSend sits inside EventsPool.addEvent's try/catch, so a
    // throw is swallowed and the event is never enqueued — every event, of every type, for the
    // life of the process. Pinned here because the choice lives in a catch block, where a
    // refactor could flip it to fail-open without anyone deciding to.
    await new Promise((r) => setTimeout(r, 5_000));
    // A throwing beforeSend drops every event, of every type.
    const stats = await getStats();
    expect(stats.requests).toBe(0);

    // But the HOST is fine — the part that must never regress, since the throw is the app's own
    // bug and the SDK must not turn it into a wedged app. Probed with a stateful control rather
    // than a status line: the counter's label carries its own tap count, so a live render loop is
    // what makes this pass. (The Config screen's status line sits below the fold, where a probe
    // would fail on scroll position.)
    await expectAppAlive(screen);

    // And recovery is real, not just cosmetic: with the hook gone the same tap
    // reports normally, which proves the pool was never left in a poisoned state.
    await activatePreset({ screen, device, platform }, "default");
    await settleAndClear();
    await tapScrolling(screen, /tap survivor/);
    await waitForEvents("interaction", { timeout: 30_000 });
    const recovered = (await getEvents()).filter((e) => label(e).includes("survivor"));
    expect(recovered.length).toBeGreaterThan(0);
  });
});
