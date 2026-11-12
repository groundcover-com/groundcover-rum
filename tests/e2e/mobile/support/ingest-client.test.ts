import { describe, expect, test } from "vitest";
import { waitForQuiet } from "./ingest-client";

/**
 * A fake clock, so "waited 15 seconds" costs no seconds.
 *
 * `sleep` advances time rather than passing it: the loop's shape — poll, compare,
 * back off — is what is under test, not setTimeout's accuracy.
 */
function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (by: number) => {
      ms += by;
    },
  };
}

/** Feeds a fixed series of request counts, repeating the last one forever. */
function counts(series: number[]): () => Promise<number> {
  let i = 0;
  return async () => series[Math.min(i++, series.length - 1)]!;
}

describe("waitForQuiet", () => {
  test("settles once the request count stops moving", async () => {
    const clock = fakeClock();
    const outcome = await waitForQuiet(counts([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]), {
      quietMs: 1_000,
      timeout: 15_000,
      ...clock,
    });

    expect(outcome.settled).toBe(true);
    expect(outcome.requests).toBe(3);
  });

  test("keeps waiting while batches are still arriving, then settles", async () => {
    const clock = fakeClock();
    // Three more batches land, then the ingest goes quiet.
    const outcome = await waitForQuiet(counts([1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4]), {
      quietMs: 1_000,
      timeout: 15_000,
      ...clock,
    });

    expect(outcome.settled).toBe(true);
    expect(outcome.requests).toBe(4);
  });

  /**
   * When batches never stop, falling out on the deadline and clearing anyway would hand
   * the caller a window it had not established — a spec such as `native-crash.spec.ts`
   * would then read a REJECTED crash as accepted, because the clear left a healthy-ingest
   * window seconds wide. An unsettled ingest has to be reported as unsettled.
   */
  test("reports that it never went quiet, instead of claiming a settled ingest", async () => {
    const clock = fakeClock();
    // A counter that never stops climbing — a foreign reporter, or an app stuck
    // emitting. Either way every negative assertion downstream is unreliable.
    let n = 0;
    const outcome = await waitForQuiet(async () => ++n, {
      quietMs: 1_000,
      timeout: 15_000,
      ...clock,
    });

    expect(outcome.settled).toBe(false);
  });

  test("reports how long it waited and what it last saw, so the failure is diagnosable", async () => {
    const clock = fakeClock();
    let n = 100;
    const outcome = await waitForQuiet(async () => ++n, {
      quietMs: 1_000,
      timeout: 15_000,
      ...clock,
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(15_000);
    expect(outcome.requests).toBeGreaterThan(100);
  });

  /**
   * Traffic that stops LATE still settles rather than timing out — the deadline
   * bounds the wait, it does not pre-empt a quiet period that arrives inside it.
   */
  test("settles on a late quiet period rather than failing on the deadline", async () => {
    const clock = fakeClock();
    // Climbs for the first ~5s of polling, then holds steady well inside 15s.
    let polls = 0;
    const outcome = await waitForQuiet(
      async () => {
        polls += 1;
        return polls < 20 ? polls : 20;
      },
      { quietMs: 1_000, timeout: 15_000, ...clock }
    );

    expect(outcome.settled).toBe(true);
    expect(outcome.requests).toBe(20);
  });
});
