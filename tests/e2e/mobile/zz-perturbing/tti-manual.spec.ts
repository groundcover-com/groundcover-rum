import { test, expect } from "@mobilewright/test";
import { expectEvents, getEvents, settleAndClear, type RumEvent } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset } from "../support/preset";
import { expectTapped, tapScrolling } from "../support/ui";

const metricName = (event: RumEvent): string =>
  String((event.attributes as Record<string, unknown>)["performance_metric_name"] ?? "");

// `native.tti: "manual"` plus `groundcover.markAppInteractive()`. The default `"auto"` anchors on
// the first screen landing, a floor rather than a promise, so `"manual"` is the honest measure and
// the one customers compare against their own numbers — both halves of the switch matter: auto
// must stop firing, and the manual mark must produce the metric.
//
// markAppInteractive also deliberately does NOT go through the pre-init call buffer, because
// buffering would replay it later and record the DRAIN time — a fabricated measurement.
test.describe("rn-playground — manual TTI", { tag: "@native" }, () => {
  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("TTI waits for markAppInteractive and is not emitted automatically", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "tti-manual");
    // The Config-tab tap from activatePreset already confirmed the session, so the
    // gate is open and anything the SDK wanted to send has had its chance.
    await settleAndClear();

    // Phase 1: no mark, no TTI. The app has fully launched and landed on a screen
    // — which under the default "auto" source is exactly what WOULD anchor TTI —
    // so this is the assertion that proves the switch took effect rather than
    // merely that the metric is slow to arrive.
    await new Promise((r) => setTimeout(r, 10_000));
    const early = (await getEvents()).filter(
      (e) => e.type === "performance" && metricName(e) === "app_start_tti"
    );
    expect(early).toHaveLength(0);

    // Phase 2: mark it.
    await tapScrolling(screen, "markAppInteractive");
    await expectTapped("markAppInteractive");

    const [tti] = await expectEvents("performance", {
      timeout: 45_000,
      where: (e) => metricName(e) === "app_start_tti",
      describe: "the TTI metric released by markAppInteractive",
    });
    expect(tti).toBeTruthy();

    // Still stamped as part of the cold launch it belongs to — the mark chooses
    // WHEN interactive happened, not which launch it describes.
    expect(["cold", "cold_prewarmed"]).toContain(
      (tti!.attributes as Record<string, unknown>)["performance_metric_navigation_type"]
    );

    // A real elapsed measurement, and one that is bounded ABOVE by this test's own
    // timeline rather than by the producer's guard rails: the mark happened after
    // the ~10s wait above, so a TTI measured from the launch anchor must exceed
    // that, and a value that ignored the mark (or fabricated a drain time) would
    // fall below it.
    const value = Number((tti!.attributes as Record<string, unknown>)["performance_metric_value"] ?? -1);
    expect(value).toBeGreaterThan(10_000);
    expect(value).toBeLessThan(120_000);

    // Emitted ONCE. The mark is set-once by design, and a duplicate would double
    // every launch in the TTI aggregate.
    const all = (await getEvents()).filter(
      (e) => e.type === "performance" && metricName(e) === "app_start_tti"
    );
    expect(all).toHaveLength(1);
  });
});
