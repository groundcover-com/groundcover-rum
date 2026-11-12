import { test, expect } from "@mobilewright/test";
import { expectEvents, getEvents, settleAndClear, type RumEvent } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset } from "../support/preset";
import { isFrameVital } from "../support/frame-vitals";
import { dragUpFrom } from "../support/ui";

const attrs = (event: RumEvent): Record<string, unknown> =>
  (event.attributes ?? {}) as Record<string, unknown>;

const metricName = (event: RumEvent): string =>
  String(attrs(event)["performance_metric_name"] ?? "");

const reason = (event: RumEvent): string =>
  String(attrs(event)["performance_segment_reason"] ?? "");

// The third way a segment can end: it simply ran too long.
//
// Segments are per screen and a screen has no upper bound on how long a user
// stays — a video player, a feed, a map. Without a cap the counters accumulate
// for the whole visit and the data only lands when the user finally leaves, so a
// long-lived screen reports nothing at all while it is being watched. The cap is
// the safety valve, and it is worth a spec of its own because it is the only
// close that fires with no user action behind it.
//
// Needs the `vitals-fast` preset: at the 60s production default the spec would
// have to dwell on one screen for a full minute to see one segment.
test.describe("rn-playground — frame vitals safety flush", { tag: "@native" }, () => {
  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("a long dwell force-flushes partial segments without a navigation", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "vitals-fast");

    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    // Keep rendering for well past several 2s caps, and NEVER navigate. The
    // continuous work is not decoration: Android closes a segment on the first
    // frame after the deadline, so a still screen would sit past the cap without
    // producing the frame that notices.
    const dwellUntil = Date.now() + 10_000;
    while (Date.now() < dwellUntil) {
      await dragUpFrom(screen, screen.getByText(/^Row \d+$/));
    }

    // At least two, so this is the cap firing repeatedly rather than one
    // incidental close.
    const safety = await expectEvents("performance", {
      timeout: 60_000,
      min: 2,
      where: (e) => metricName(e) === "frames_delay_total" && reason(e) === "safety",
      describe: "segments closed by the 2s cap while dwelling on the Native tab",
    });

    for (const event of safety) {
      // Still attributed, even though no navigation was involved.
      expect((attrs(event)["screen"] as { name?: string } | undefined)?.name).toBe("Native");
      // A segment only exists if frames were recorded, so its bounds are the proof that something
      // was measured — `performance_frames_total` is not on the wire.
      expect(Number(attrs(event)["end_timestamp"] ?? 0)).toBeGreaterThan(
        Number(attrs(event)["start_timestamp"] ?? 0)
      );

      // Roughly the cap, generously: the close lands on the first frame past the
      // deadline, and on a software-rasterised emulator that frame can be late.
      // The claim is that the span is the CAP and not the dwell — a broken cap
      // gives one ~10s segment, which this bound rejects.
      const spanMs =
        (Number(attrs(event)["end_timestamp"]) - Number(attrs(event)["start_timestamp"])) / 1e6;
      expect(spanMs).toBeGreaterThan(500);
      expect(spanMs).toBeLessThan(6_000);
    }

    // And no navigation segment appeared, which is what makes the `safety`
    // reason meaningful: it is a distinct trigger, not a relabelling of the
    // close this suite already tests.
    const all = await getEvents();
    expect(
      all.filter((e) => e.type === "performance" && isFrameVital(e) && reason(e) === "navigation")
    ).toHaveLength(0);
  });

  test("every frame segment carries a reason from the enum", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "vitals-fast");

    // Dwell to produce safety closes, then navigate away so a second trigger is
    // in the mix too.
    await screen.getByLabel("Native tab").tap();
    await settleAndClear();
    const dwellUntil = Date.now() + 6_000;
    while (Date.now() < dwellUntil) {
      await dragUpFrom(screen, screen.getByText(/^Row \d+$/));
    }
    await screen.getByLabel("Logs tab").tap();

    // Wait on the SAFETY close only, deliberately not the navigation one: under a 2s cap the
    // navigation pull can legitimately find the counters empty, so emitting nothing there is
    // correct rather than a fault, and requiring it would make this flaky. `vitals.spec.ts`
    // pins the navigation close deterministically under the 60s default; this spec's subject is
    // the cap.
    await expectEvents("performance", {
      timeout: 60_000,
      min: 2,
      where: (e) => isFrameVital(e) && reason(e) === "safety",
      describe: "a segment closed by the 2s cap",
    });

    const events = (await getEvents()).filter((e) => e.type === "performance" && isFrameVital(e));
    const reasons = new Set(events.map(reason));

    // A cheap guard against the native reason strings drifting away from the TS
    // union: nothing off-device compares the two, and an unrecognised value ships
    // silently and makes the field useless for grouping. The sweep covers every
    // frame event recorded, so a navigation segment that DID arrive is checked
    // too — it just isn't required to.
    for (const value of reasons) {
      expect(["navigation", "background", "safety"]).toContain(value);
    }
    // Not vacuous: something really was recorded.
    expect(reasons.has("safety")).toBe(true);
  });
});
