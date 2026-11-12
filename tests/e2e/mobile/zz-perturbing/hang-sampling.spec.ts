import { test, expect } from "@mobilewright/test";
import { expectEvents, settleAndClear, type RumEvent } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset } from "../support/preset";

const HANG_TYPES = ["ANR", "AppHang"];

function isHang(event: RumEvent): boolean {
  if (event.type !== "exception") return false;
  return HANG_TYPES.includes(
    String((event.attributes as Record<string, unknown>)?.["error_type"] ?? "")
  );
}

/** Dot-flattened by the enricher, not a nested object — see the note in crashes/hangs.spec.ts. */
function hangDurationMs(event: RumEvent): number {
  const attributes = event.attributes as Record<string, unknown> | undefined;
  return Number(attributes?.["error_metadata.hang_duration_ms"] ?? -1);
}

/** Mirrors HANG_STALL_MS in apps/rn-playground/src/screens/NativeScreen.tsx. */
const STALL_MS = 3_000;

/**
 * The `hang-sampling` preset's threshold, restated so the arithmetic below is checkable here.
 * Mirrors apps/rn-playground/src/config-presets.ts.
 */
const THRESHOLD_MS = 2_000;

/**
 * Repeated, so a watchdog that only SOMETIMES sees a stall fails.
 *
 * Detection has to be a property of the stall, not of when the watchdog happened to look — and
 * asserting that takes repetition, because a single trial cannot tell a reliable watchdog from a
 * coin. A sampling watchdog — one probe posted, the whole threshold slept, then a check whether
 * the probe has run — sees a stall only if the probe lands inside `[T, T + D - H)`. Its detection
 * probability is `(D - H) / (H + poll)`, certain only above `2H + poll`.
 *
 * `crashes/hangs.spec.ts` cannot catch this, and it is worth being precise about why: it runs the
 * same 3s stall against the DEFAULT preset's 1s threshold, where `(D - H) / (H + poll)` already
 * exceeds 1. That ratio sits inside the certain band even for a sampling watchdog, so that spec
 * would pass against one. The parameters are the gap, not the assertions — hence this preset,
 * whose only job is to move the ratio back into the band where sampling shows up. It is also why
 * this is a spec of its own rather than another assertion over there.
 *
 * Here a sampling watchdog detects the 3s stall about 40% of the time per trial, so with `TRIALS`
 * at 5 it survives this spec 0.4^5 ≈ 1% of the time. iOS is deterministic here (a 100ms heartbeat
 * compared against elapsed time), so on that platform this is a parity assertion rather than a
 * regression test.
 */
test.describe("rn-playground — hang detection is not sampled", { tag: "@native" }, () => {
  // No retries here. The 0.4^5 ≈ 1% escape margin above is computed for a SINGLE run; the config's
  // `retries: 2` (there for the iOS WDA cold start, which this preset-driven spec does not hit)
  // would give a resampled watchdog three independent shots to slip through — 1 - 0.99^3 ≈ 3% —
  // silently tripling the false-pass rate this spec holds at 1%.
  test.describe.configure({ retries: 0 });

  const TRIALS = 5;

  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("reports every one of several identical stalls", async ({ screen, device, platform }) => {
    test.setTimeout(300_000);

    await settleAndClear();
    await activatePreset({ screen, device, platform }, "hang-sampling");
    await screen.getByLabel("Native tab").tap();

    const durations: number[] = [];

    for (let trial = 1; trial <= TRIALS; trial++) {
      // Per trial rather than once up front: settleAndClear waits for the ingest to go QUIET
      // before clearing, so a report still in flight from the previous trial lands and is
      // discarded here instead of being counted as this trial's. Without that, one late arrival
      // could cover for a genuine miss and the spec would under-report the sampling it exists to
      // measure.
      await settleAndClear();

      await screen.getByLabel("Block main thread").tap();

      const [hang] = await expectEvents("exception", {
        timeout: 60_000,
        where: isHang,
        describe: `the recovered main-thread stall from trial ${trial} of ${TRIALS}`,
      });

      // Every trial's duration, not just its presence. A sampling watchdog also times the stall
      // from a probe posted INSIDE it, so a watchdog can be reliable and still be wrong about how
      // long the user waited.
      durations.push(hangDurationMs(hang!));
    }

    // Reported together so a failure shows the whole pattern — which trial was short, or whether
    // every one of them was, is the difference between a flake and the defect.
    expect(durations.filter((ms) => ms < STALL_MS)).toEqual([]);
    expect(durations).toHaveLength(TRIALS);

    // Sanity on the preset itself: at a 2s threshold a 3s stall is reportable, and a duration
    // below the threshold would mean the app booted on some other config and this whole spec
    // measured the wrong thing.
    expect(Math.min(...durations)).toBeGreaterThan(THRESHOLD_MS);
  });
});
