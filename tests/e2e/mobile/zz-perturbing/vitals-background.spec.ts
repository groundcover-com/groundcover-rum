import { test, expect } from "@mobilewright/test";
import { expectEvents, settleAndClear, type RumEvent } from "../support/ingest-client";
import { BUNDLE_ID } from "../support/app";
import { dragUpFrom } from "../support/ui";

const attrs = (event: RumEvent): Record<string, unknown> =>
  (event.attributes ?? {}) as Record<string, unknown>;

const metricName = (event: RumEvent): string =>
  String(attrs(event)["performance_metric_name"] ?? "");

// The second of three ways a frame segment can end, and the one that matters for data loss:
// whatever the counters hold when the user leaves the app. Unlike a navigation this close is a
// native PUSH (didEnterBackgroundNotification, onActivityStopped), a completely different path
// from the JS pull — and the only thing that saves a screen's stats when the user backgrounds
// instead of navigating, which is the most common thing a user does.
//
// In `zz-perturbing/` because pressing HOME perturbs app state for anything behind it.
test.describe("rn-playground — frame vitals on backgrounding", { tag: "@native" }, () => {
  test("backgrounding closes the segment, with the screen still attached", async ({
    screen,
    device,
  }) => {
    test.setTimeout(180_000);

    await screen.getByLabel("Native tab").tap();
    // The Native tab tap itself closes a `navigation` segment for the previous
    // screen; settling past it is what leaves backgrounding as the only thing
    // that can produce the segment asserted below.
    await settleAndClear();

    for (let i = 0; i < 3; i++) {
      await dragUpFrom(screen, screen.getByText(/^Row \d+$/));
    }

    // Act: leave the app. The base preset's 60s segment cap means nothing else
    // can have closed a segment in the meantime.
    await screen.pressButton("HOME");

    // STAY backgrounded. `onActivityStopped` — which is what closes the segment —
    // fires after the home transition settles, not when the key goes down. A
    // relaunch within tens of milliseconds of HOME beats it: Android takes the
    // activity straight back to resumed and onStop never runs, so nothing closes
    // the segment and the spec fails looking like a missing feature.
    await new Promise((r) => setTimeout(r, 3_000));

    // Then come back, because the segment is CLOSED at backgrounding but not
    // DELIVERED there: the SDK flushes its queue from the AppState handler and
    // native's signal crosses the bridge just after, so the event lands in a pool
    // that was emptied a moment ago and waits for the next batch. Nothing is
    // lost. Asserting while backgrounded would be testing Android's process
    // scheduling rather than this SDK.
    await device.launchApp(BUNDLE_ID);

    const [slow] = await expectEvents("performance", {
      timeout: 60_000,
      // Keyed on the REASON, not just the metric: a navigation-closed segment
      // still in flight would satisfy a bare `frames_delay` wait and the
      // assertions below would then read the wrong segment.
      where: (e) =>
        metricName(e) === "frames_delay_total" &&
        String(attrs(e)["performance_segment_reason"] ?? "") === "background",
      describe: "a frame segment closed by backgrounding the app",
    });

    // Pushed by native, so the screen is stamped from the ambient holder rather
    // than from a captured outgoing value — a different code path from the
    // navigation close, and it has to reach the same answer.
    expect(String(attrs(slow!)["performance_segment_reason"] ?? "")).toBe("background");
    expect((attrs(slow!)["screen"] as { name?: string } | undefined)?.name).toBe("Native");

    // Not an empty segment: the frames drawn before HOME survived the close.
    // Native's counters are discarded on the way back to the foreground, so if
    // the flush did not happen BEFORE the reset these frames are gone for good.
    // A segment only exists if frames were recorded, so its bounds are the proof that something
    // was measured — `performance_frames_total` is not on the wire.
    expect(Number(attrs(slow!)["end_timestamp"] ?? 0)).toBeGreaterThan(
      Number(attrs(slow!)["start_timestamp"] ?? 0)
    );
  });
});
