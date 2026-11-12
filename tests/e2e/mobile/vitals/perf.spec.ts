import { test, expect } from "@mobilewright/test";
import { getEvents, getStats, settleAndClear, waitForEvents, type RumEvent } from "../support/ingest-client";
import { dragUpFrom } from "../support/ui";

// Overhead and volume, on the platform where they matter most: the claim that "the
// SDK is not expensive", asserted on device. The browser suite has its own
// replay-perf spec.
//
// These are deliberately VOLUME assertions rather than timing ones. Wall-clock
// budgets on an emulator are noise, but "how many events does one gesture
// produce" and "how much does the SDK send while nothing happens" are structural:
// they are decided by the aggregation design, not by the machine, so they hold on
// a slow CI emulator and still catch the regressions that matter.
const attrs = (event: RumEvent): Record<string, unknown> =>
  (event.attributes ?? {}) as Record<string, unknown>;

const metricName = (event: RumEvent): string =>
  String(attrs(event)["performance_metric_name"] ?? "");

const num = (event: RumEvent, key: string): number => Number(attrs(event)[key] ?? Number.NaN);

test.describe("rn-playground — overhead", { tag: "@native" }, () => {
  test("a sustained scroll reports per GESTURE, not per touch move", async ({ screen }) => {
    test.setTimeout(180_000);

    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    // Five real drags. A touch stream carries a move event per frame, so the
    // difference between reporting gestures and reporting moves is two orders of
    // magnitude — and it is the single easiest way for an instrumentation change
    // to multiply a customer's ingest bill without changing a single field on the
    // wire.
    const drags = 5;
    for (let i = 0; i < drags; i++) {
      await dragUpFrom(screen, screen.getByText(/^Row \d+$/));
    }
    await waitForEvents("interaction", { timeout: 30_000 });
    // Let the last gesture's batch land before counting.
    await new Promise((r) => setTimeout(r, 3_000));

    const interactions = (await getEvents()).filter((e) => e.type === "interaction");

    // The CEILING is the assertion; the floor only stops it being satisfied by silence,
    // and is 1 rather than ~drags because the harness cannot promise every drag lands —
    // the anchor row moves and later swipes may scroll nothing, so a platform can report
    // a single gesture for all five. Pinning the floor to the drag count would be testing
    // the driver.
    //
    // The ceiling carries the real claim: a per-touch-move implementation lands in the
    // hundreds, so 4x the drag count separates "one per gesture" from "one per frame" by
    // over an order of magnitude.
    expect(interactions.length).toBeGreaterThanOrEqual(1);
    expect(interactions.length).toBeLessThan(drags * 4);
  });

  test("frame vitals are bounded by segments, not by a timer, and an idle app goes quiet", async ({
    screen,
  }) => {
    test.setTimeout(180_000);

    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    // Phase 1 — RENDERING. Vitals only exist while frames are being produced, so
    // the volume claim has to be measured against a rendering app. Three drags is
    // what vitals.spec.ts uses to make segments close.
    for (let i = 0; i < 3; i++) {
      await dragUpFrom(screen, screen.getByText(/^Row \d+$/));
    }
    // A segment closes on a navigation, so one is needed to see anything at all
    // within the test — the drags alone accumulate counters silently.
    await screen.getByLabel("Logs tab").tap();
    await waitForEvents("performance", { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3_000));

    const performance = (await getEvents()).filter((e) => e.type === "performance");

    // THE assertion: aggregation. A tracker emitting per frame lands two to three orders of
    // magnitude above this bound while every individual rate still looks valid. Derived from
    // SEGMENTS rather than elapsed time — one navigation happened, the phase is far shorter than
    // the 60s cap so no safety segment is possible, and each close emits one event (the bound
    // allows two per segment, for slack). Two segments' headroom absorbs a straggler plus the
    // app-start and TTI metrics sharing the type.
    const segments = 1;
    expect(performance.length).toBeLessThanOrEqual((segments + 2) * 2 + 4);
    // ...and the tracker really is attached, so the ceiling is not satisfied by
    // silence.
    expect(performance.length).toBeGreaterThan(0);

    // Phase 2 — IDLE. Nothing is rendering and nothing is navigating, so the
    // correct behaviour is total silence — and with a 60s cap that is a
    // ZERO-EVENT claim rather than a byte budget. A timer-driven window would
    // close every few seconds whether or not anything had happened; a segment
    // model that still ships here has a timer left in it somewhere.
    await settleAndClear();
    await new Promise((r) => setTimeout(r, 12_000));
    const idleVitals = (await getEvents()).filter((e) => e.type === "performance");
    expect(idleVitals).toHaveLength(0);

    // The wire-volume ceiling stays as the broader guard: it catches an
    // order-of-magnitude regression anywhere in the pipeline — per-event
    // flushing, an unbounded buffer being re-sent, a heartbeat that ships the
    // session envelope every tick — not just in vitals.
    const idle = await getStats();
    expect(idle.bytes).toBeLessThan(100_000);

    // And an idle app produces no user-driven events at all. A stray interaction
    // stream at rest means the touch bridge is firing without a user, which is
    // both a data-quality and a battery problem.
    const idleEvents = await getEvents();
    expect(idleEvents.filter((e) => e.type === "interaction")).toHaveLength(0);
  });

  test("the app stays responsive while fully instrumented", async ({ screen }) => {
    test.setTimeout(180_000);

    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    for (let i = 0; i < 3; i++) {
      await dragUpFrom(screen, screen.getByText(/^Row \d+$/));
    }
    // Segments close on a navigation, so the drags alone would leave the counters
    // sitting in native for the whole 60s cap and nothing to assert on.
    await screen.getByLabel("Logs tab").tap();

    const [segment] = await waitForEvents("performance", {
      timeout: 60_000,
      where: (e) => metricName(e) === "frames_delay_total",
    });
    expect(segment).toBeTruthy();

    // The SDK measuring its own host, which is the only overhead signal available
    // on device — you cannot compare against an SDK-off baseline here, because
    // with vitals disabled there is nothing left to do the measuring.
    //
    // Deliberately a loose bar. This runs on a software-rasterised emulator in CI
    // where genuinely slow frames are normal, so a tight threshold would be a
    // flake generator; what it still catches is the regression that matters — a
    // fiber walk or a redaction pass moving onto the frame path, which pushes
    // FROZEN frames (>700ms) from occasional to constant.
    //
    // Per SECOND of dwell rather than as a fraction of frames. There is no frozen RATE on the
    // wire because the two platforms' denominators are not the same quantity, and
    // `performance_frames_total` is not on the wire for the same reason — it would count display
    // refreshes on iOS and real draws on Android. Seconds are seconds on both.
    const frozen = Number(attrs(segment!)["performance_frames_frozen"] ?? 0);
    const dwellS =
      (num(segment!, "end_timestamp") - num(segment!, "start_timestamp")) / 1e9;
    expect(dwellS).toBeGreaterThan(0);
    // A fiber walk or a redaction pass moving onto the frame path turns frozen frames from
    // occasional into constant; below one per second is loose enough for a software rasterizer.
    expect(frozen / dwellS).toBeLessThan(1);
  });
});
