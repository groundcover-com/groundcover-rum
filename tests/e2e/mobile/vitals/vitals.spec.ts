import { test, expect } from "@mobilewright/test";
import type { Screen } from "@mobilewright/core";
import { expectEvents, getEvents, settleAndClear, type RumEvent } from "../support/ingest-client";
import { isFrameVital, retiredFrameVitals } from "../support/frame-vitals";
import { dragUpFrom } from "../support/ui";

const attrs = (event: RumEvent): Record<string, unknown> =>
  (event.attributes ?? {}) as Record<string, unknown>;

const metricName = (event: RumEvent): string =>
  String(attrs(event)["performance_metric_name"] ?? "");

const metricValue = (event: RumEvent): number =>
  Number(attrs(event)["performance_metric_value"] ?? -1);

const reason = (event: RumEvent): string =>
  String(attrs(event)["performance_segment_reason"] ?? "");

const screenName = (event: RumEvent): string =>
  String((attrs(event)["screen"] as { name?: string } | undefined)?.name ?? "");

const num = (event: RumEvent, key: string): number => Number(attrs(event)[key] ?? Number.NaN);

/** A closed frame segment, as its single wire event describes it. */
type Segment = {
  screen: string;
  reason: string;
  slow: number;
  frozen: number;
  refreshRate: number;
  startNs: number;
  endNs: number;
  /** `frames_delay_total` — milliseconds lost across the whole segment, absolute. */
  delayMs: number;
};

/**
 * Read each frame-vitals event as the segment it describes, oldest close first.
 *
 * A closed segment emits ONE event, so this is a straight map, collected as-is and merely sorted.
 * Not keyed on `end_timestamp`: with nothing to join, such a key could only discard a second
 * segment sharing an end, and Android's ends are whole milliseconds (`System.currentTimeMillis`),
 * which is the kind of resolution a timestamp key eventually collides on.
 */
function segmentsFrom(events: RumEvent[]): Segment[] {
  return events
    .filter((event) => event.type === "performance" && isFrameVital(event))
    .map((event) => ({
      screen: screenName(event),
      reason: reason(event),
      slow: num(event, "performance_frames_slow"),
      frozen: num(event, "performance_frames_frozen"),
      refreshRate: num(event, "performance_refresh_rate_hz"),
      startNs: num(event, "start_timestamp"),
      endNs: num(event, "end_timestamp"),
      delayMs: metricValue(event),
    }))
    .sort((a, b) => a.endNs - b.endNs);
}

// Frame vitals cannot complain when they break — "no vitals" looks exactly like "a smooth app" —
// but "a metric arrived" is equally satisfied by a tracker measuring the WRONG thing: a
// timer-windowed aggregator would draw a stuttering transition under the screen the user had just
// arrived at. Attribution, the per-screen reset and the segment reasons are the subject.
//
// TWO tests, not one per claim: every assertion is about the SAME observed segment, and the
// arrangement is the expensive part, so repeating it per claim would multiply the suite's time.
test.describe("rn-playground — frame vitals", { tag: "@native" }, () => {
  /** Drag the Native tab's list, giving the tracker frames to count. */
  async function scrollNativeList(screen: Screen, times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await dragUpFrom(screen, screen.getByText(/^Row \d+$/));
    }
  }

  test("a navigation closes a segment that fully describes the screen being LEFT", async ({
    screen,
  }) => {
    test.setTimeout(180_000);

    // Sampled BEFORE the tab tap, because that tap is what opens the segment:
    // the previous segment closes there and the next one starts at the same
    // instant. Reading the clock after `settleAndClear` would put the segment's
    // own start before the window it is compared against.
    const dwellStart = Date.now();
    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    // Scrolling is the cheapest way to make the app render continuously; on a
    // software-GPU emulator it also produces genuinely slow frames.
    await scrollNativeList(screen, 3);

    // Act: leave. With the base preset's 60s segment cap, this navigation is the
    // only thing that can close a segment inside the test — so a `navigation`
    // segment appearing at all is caused by the tap, and by nothing else.
    await screen.getByLabel("Logs tab").tap();
    const dwellEnd = Date.now();

    // BY SCREEN, not by count: the tab tap that opens this test also closes a segment for the
    // launch screen, so a bare count is satisfied by an event this test is not asserting on and
    // the read below would happen before the Native one arrived.
    await expectEvents("performance", {
      timeout: 60_000,
      where: (e) => isFrameVital(e) && reason(e) === "navigation" && screenName(e) === "Native",
      describe: "the frames_delay_total event for the segment closed by leaving the Native tab",
    });

    const recorded = await getEvents();
    const navigationSegments = segmentsFrom(recorded).filter((s) => s.reason === "navigation");

    // THE regression assertion, in two halves. The frames were drawn on Native;
    // the app is on Logs by the time the segment reaches the ingest, so anything
    // labelling a segment with the CURRENT screen produces a Logs one and no
    // Native one.
    //
    // Selected BY SCREEN rather than by position. The tab tap that opens this
    // test also closes a segment for the launch screen, and that one can outrun
    // `settleAndClear` — taking the first navigation segment then reads "Home"
    // and fails for a reason that has nothing to do with attribution.
    const segment = navigationSegments.find((s) => s.screen === "Native");
    expect(segment).toBeTruthy();
    // And the destination is never credited with them, which is the specific
    // wrong answer a timer-window model would give.
    expect(navigationSegments.filter((s) => s.screen === "Logs")).toHaveLength(0);

    // No retired metric rides along with the current one. Emitting both would double the vitals
    // volume and keep shipping a rate whose denominator is not the same quantity on the two
    // platforms.
    expect(retiredFrameVitals(recorded)).toEqual([]);

    // `performance_frames_total` is deliberately off the wire — it would count display refreshes
    // on iOS and real draws on Android, so it is not comparable. The slow/frozen counts are, and
    // the segment BOUNDS are what normalizes them.
    expect(segment!.endNs).toBeGreaterThan(segment!.startNs);

    // Structural, and independent of how much the device happened to render: a segment with no slow
    // frames lost no time, and one with slow frames lost some. Either direction failing means the
    // counts and the delay were accumulated from different frames.
    expect(segment!.delayMs).toBeGreaterThanOrEqual(0);
    if (segment!.slow === 0) expect(segment!.delayMs).toBe(0);
    else expect(segment!.delayMs).toBeGreaterThan(0);

    // Frozen frames are a subset of slow ones by construction: the frozen bar
    // (700ms) is far above any "missed a vsync". A frame-delta unit error —
    // seconds read as milliseconds — breaks this and nothing else.
    expect(segment!.frozen).toBeLessThanOrEqual(segment!.slow);

    // The bar that produced the rate. A Hz/ms confusion (16.67 reported as the
    // "refresh rate") makes every rate meaningless while every rate stays in
    // range, so the unit has to be pinned on the wire.
    expect(segment!.refreshRate).toBeGreaterThanOrEqual(30);
    expect(segment!.refreshRate).toBeLessThanOrEqual(240);

    // NANOSECONDS, matching what RN `navigation` events already ship, so the
    // backend can intersect a segment with the navigations around it without a
    // unit conversion. The native payload is in MILLISECONDS, so a missing
    // conversion is the obvious bug — and it is invisible to an ordering check.
    // A ±1h window separates ns from ms (a factor of a million) without
    // pretending the device clock and this process's clock are in sync.
    const hourNs = 3_600 * 1e9;
    expect(segment!.endNs).toBeGreaterThan(segment!.startNs);
    expect(segment!.startNs).toBeGreaterThan(dwellStart * 1e6 - hourNs);
    expect(segment!.endNs).toBeLessThan(dwellEnd * 1e6 + hourNs);

    // The span is the DWELL, not the process lifetime: it cannot exceed the time
    // between arriving on the screen and leaving it. 2s of slack covers the lag
    // between the driver's tap returning and the navigation committing on device.
    const spanMs = (segment!.endNs - segment!.startNs) / 1e6;
    expect(spanMs).toBeGreaterThan(0);
    expect(spanMs).toBeLessThanOrEqual(dwellEnd - dwellStart + 2_000);
    expect(spanMs).toBeLessThan(60_000);

    // ONE event per closed segment, carrying everything needed to place it. Nothing derived from a
    // single frame (`refresh_rate_min`) rides along: identical jank would read differently
    // depending on how long the segment ran.
    const vitals = recorded.filter((e) => e.type === "performance" && isFrameVital(e));
    const delays = vitals.filter((e) => metricName(e) === "frames_delay_total");
    expect(delays.length).toBeGreaterThan(0);
    expect(vitals.length).toBe(delays.length);

    for (const delay of delays) {
      // Everything a consumer needs without a join: the bar the frames were judged against, the
      // segment's bounds, why it closed, and a distinct id.
      expect(attrs(delay)["performance_refresh_rate_hz"]).toBeDefined();
      expect(attrs(delay)["performance_frame_budget_ms"]).toBeDefined();
      expect(num(delay, "end_timestamp")).toBeGreaterThan(num(delay, "start_timestamp"));
      expect(String(attrs(delay)["performance_metric_id"] ?? "")).not.toBe("");
      // Vitals are not a navigation event; the field exists but stays empty.
      expect(attrs(delay)["performance_metric_navigation_type"]).toBe("");
    }
  });

  test("per-screen stats: one segment per screen, counters reset between them", async ({
    screen,
  }) => {
    test.setTimeout(180_000);

    await screen.getByLabel("Native tab").tap();
    await settleAndClear();

    // Native gets the work: three drags of a 60-row list.
    await scrollNativeList(screen, 3);
    await screen.getByLabel("Logs tab").tap();

    // Logs must draw SOMETHING or its segment is empty and never emitted. A SCROLL, not
    // taps: Android's FrameMetrics fires only on a real frame, a press animation is a
    // handful, and under a full run they can all land before native handles the previous
    // screen's pull. Dragging renders continuously. ONE drag against Native's three keeps
    // Logs the smaller of the two, which is what the comparison needs.
    await dragUpFrom(screen, screen.getByText("Logs"));
    await screen.getByLabel("Network tab").tap();

    // Wait for BOTH segments BY SCREEN rather than by count: a bare count is satisfied by the
    // Native one alone, so the read below would happen before the Logs segment had arrived. That
    // is fast enough to hide in isolation and fails under the load of a full suite run.
    for (const name of ["Native", "Logs"]) {
      await expectEvents("performance", {
        timeout: 60_000,
        where: (e) =>
          metricName(e) === "frames_delay_total" &&
          reason(e) === "navigation" &&
          screenName(e) === name,
        describe: `the segment closed by leaving the ${name} tab`,
      });
    }

    const segments = segmentsFrom(await getEvents()).filter((s) => s.reason === "navigation");
    const native = segments.find((s) => s.screen === "Native");
    const logs = segments.find((s) => s.screen === "Logs");

    // Two DISTINCT screens, which is the whole claim: a per-screen segment
    // cannot be attributed to a screen the user was not on.
    expect(native).toBeTruthy();
    expect(logs).toBeTruthy();

    // Both drew something. Asserted on the SEGMENT BOUNDS rather than a frame count, since the
    // count is not on the wire — a segment only exists at all if frames were recorded.
    expect(native!.endNs).toBeGreaterThan(native!.startNs);
    expect(logs!.endNs).toBeGreaterThan(logs!.startNs);

    // THE reset assertion, STRUCTURAL rather than a comparison of magnitudes: closing a
    // segment re-anchors the next at that instant, so a counter that failed to reset
    // would leave Logs starting where NATIVE did, before Native's own end.
    //
    // Deliberately independent of how much either screen rendered, since frame production
    // is a property of the device. `>=` not `===`, because a `safety` close between the
    // two would push Logs' start later, which is still correct.
    expect(logs!.startNs).toBeGreaterThanOrEqual(native!.endNs);

    // The magnitude check stays as a SECONDARY signal: Native dwells longer and does more work
    // under either capture model, so a leak that somehow preserved the bounds would still show up
    // as Logs carrying Native's work too. Measured on DWELL, since the frame count is not on the
    // wire — one drag against three is the shorter visit. It is the weaker of the two, sensitive
    // to device timing, so the claim does not rest on it.
    expect(logs!.endNs - logs!.startNs).toBeLessThan(native!.endNs - native!.startNs);
  });
});
