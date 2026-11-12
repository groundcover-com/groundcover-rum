import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigManager,
  EventEnricher,
  RandomIdGenerator,
  type SDKConfigInput,
} from "@groundcover/rum-core";

import { VitalsEventsListener } from "./vitals-listener";
import type { NativeFrameSegment } from "../../platform/native-types";

function setup(isSessionInactive: () => boolean = () => false) {
  const config = new ConfigManager();
  config.initialize({
    dsn: "ingest.example",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
  } as SDKConfigInput);

  const eventsPool = { addEvent: vi.fn(), flush: vi.fn() };
  const listener = new VitalsEventsListener({
    config,
    eventsPool: eventsPool as never,
    enricher: new EventEnricher({
      enrichAttributes: () => ({ screen: { name: "Feed", key: "Feed-1" } }),
      idGenerator: new RandomIdGenerator(),
    }),
    idGenerator: new RandomIdGenerator(),
    isSessionInactive,
  });
  listener.initialize();

  return { listener, eventsPool };
}

type Harness = ReturnType<typeof setup>;

const attributesOf = (h: Harness) =>
  h.eventsPool.addEvent.mock.calls.map(
    ([event]) => (event as { attributes: Record<string, unknown> }).attributes
  );

const metrics = (h: Harness) =>
  h.eventsPool.addEvent.mock.calls.map(([event]) => {
    const attributes = (event as { attributes: Record<string, unknown> }).attributes;
    return {
      type: (event as { type: string }).type,
      name: attributes["performance_metric_name"],
      value: attributes["performance_metric_value"],
      navigationType: attributes["performance_metric_navigation_type"],
      screen: attributes["screen"],
    };
  });

const START_MS = 1_700_000_000_000;
const END_MS = 1_700_000_005_000;

const segment = (over: Partial<NativeFrameSegment> = {}): NativeFrameSegment => ({
  segmentStartMs: START_MS,
  segmentEndMs: END_MS,
  total: 300,
  slow: 30,
  frozen: 3,
  refreshRate: 60,
  // 30 slow frames that lost 8ms each beyond the 16.67ms budget, one of which took 250ms.
  delayMs: 240,
  budgetMs: 1000 / 60,
  reason: "navigation",
  ...over,
});

describe("VitalsEventsListener", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setup();
  });


  /**
   * `performance_frames_total` is not on the wire, and this pins that it cannot appear by accident.
   *
   * The division is meaningless: CADisplayLink ticks whether or not the app drew, so on iOS
   * `total` is `elapsed x refresh rate` and carries nothing the segment bounds do not already have,
   * while on Android it IS render activity. One field name, two different quantities, and
   * `slow / total` would read near zero on iOS and high on Android for the same class of app.
   *
   * What ships is absolute and genuinely comparable: a slow frame is a slow frame on both.
   * Normalize by TIME using `start_timestamp`/`end_timestamp`, the one denominator both platforms
   * agree on.
   */
  it("does not ship performance_frames_total — it is not comparable across platforms", () => {
    harness.listener.handleEvent(segment());

    for (const attributes of attributesOf(harness)) {
      expect(attributes).not.toHaveProperty("performance_frames_total");
    }
  });




  /**
   * Without this the wire does not determine the numbers on it: iOS judges an adaptive panel
   * against the cadence the display is ACTUALLY running at, so on an idle 120Hz screen the budget
   * is ~16.7ms while `performance_refresh_rate_hz` says 120 (8.33ms). A consumer recomputing our
   * slow count or lost-time total from the shipped fields would get a different answer, with
   * nothing to explain the gap.
   */
  it("ships the budget slow was judged against, on the delay event", () => {
    harness.listener.handleEvent(segment({ refreshRate: 120, budgetMs: 16.7 }));
    const [delay] = attributesOf(harness);

    expect(delay!.performance_frame_budget_ms).toBe(16.7);
    // The nominal rate still ships and is still 120 — it is a fact about the panel, just not the
    // bar the frames were judged against.
    expect(delay!.performance_refresh_rate_hz).toBe(120);
  });

  it("omits a non-finite budget rather than shipping a null", () => {
    // `Infinity > 0` passes a bare positivity check and then serializes as JSON `null`, which
    // downstream reads as "native sent nothing" while native in fact sent garbage. The bridge
    // strips it first; this is the listener's own guard, the same `finiteNonNegative` it applies
    // to delayMs.
    harness.listener.handleEvent(segment({ budgetMs: Number.POSITIVE_INFINITY }));
    const [delay] = attributesOf(harness);

    expect(delay).not.toHaveProperty("performance_frame_budget_ms");
    // The rest of the segment is untouched — one spoiled optional must not cost the metrics.
    expect(delay!.performance_frames_slow).toBe(30);
    expect(delay!.performance_refresh_rate_hz).toBe(60);
  });

  /**
   * A closed segment emits exactly ONE event — no refresh-rate minimum beside it.
   *
   * Such a value would come from a single frame — the worst non-frozen one — so it would be very
   * noisy: one stutter anywhere in a long otherwise-smooth screen dominates it, and the same
   * underlying jank produces wildly different numbers depending on how long the segment happens to
   * be.
   *
   * Everything it would be reached for is already carried by metrics that aggregate correctly:
   * `frames_delay_total` is the time actually lost, and `performance_frames_slow` / `_frozen` are
   * the counts. A one-frame-derived rate on top of those would be noise with a number attached.
   */
  it("emits ONE metric per segment", () => {
    harness.listener.handleEvent(segment());

    expect(metrics(harness).map((m) => m.name)).toEqual(["frames_delay_total"]);
  });

    it("rounds to two places — enough to keep one marginally-slow frame off zero", () => {
    // A single frame 0.28ms past the 60Hz budget is the smallest real delay there is. Whole-
    // millisecond rounding would report 0 for it, making it indistinguishable from a segment with
    // nothing slow in it at all.
    harness.listener.handleEvent(segment({ slow: 1, frozen: 0, delayMs: 0.2833 }));

    expect(metrics(harness)[0]!.value).toBe(0.28);
  });

  it("reports a perfectly smooth segment rather than skipping it", () => {
    // A smooth screen is a RESULT, not an absence: suppressing it would make
    // "smooth" indistinguishable from "not measured" on a dashboard.
    harness.listener.handleEvent(segment({ slow: 0, frozen: 0, delayMs: 0 }));

    expect(metrics(harness).map((m) => m.value)).toEqual([0]);
  });


  it("skips the metric, loudly, when the native engine sends no timing detail", () => {
    // A binary one version behind has no delayMs. Emitting nothing is right; doing it
    // SILENTLY is not — an app whose vitals stop looks exactly like a smooth one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = setup();
      h.listener.handleEvent(segment({ delayMs: undefined }));

      expect(h.eventsPool.addEvent).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("frame vitals will not be reported");
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a zero delay as a real measurement, not as a missing field", () => {
    // `?? null`-style guards that fold 0 into "absent" would suppress vitals for exactly the
    // screens that are working correctly.
    harness.listener.handleEvent(segment({ slow: 0, delayMs: 0 }));

    expect(harness.eventsPool.addEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores a segment with no frames instead of shipping NaN", () => {
    harness.listener.handleEvent(segment({ total: 0, slow: 0, frozen: 0 }));

    expect(harness.eventsPool.addEvent).not.toHaveBeenCalled();
  });

  // The reason the counts ship at all: absolute counts let a consumer combine
  // segments, while a per-segment ratio cannot be averaged across segments of
  // different lengths, and the error cannot be corrected after the fact.
  it("ships the counts on the frames_delay_total event, so segments can be aggregated", () => {
    harness.listener.handleEvent(segment());

    // Aggregation keys off the frames_delay_total event (index 0), the only one a segment emits,
    // so the counts are stamped exactly once.
    const delay = attributesOf(harness)[0]!;
    expect(delay["performance_frames_slow"]).toBe(30);
    expect(delay["performance_frames_frozen"]).toBe(3);
  });

  it("ships the refresh rate the slow bar was derived from", () => {
    // Without it a 120Hz reading cannot be compared with a 60Hz one, because the
    // threshold that produced each slow count was different.
    harness.listener.handleEvent(segment({ refreshRate: 120 }));

    expect(attributesOf(harness)[0]!["performance_refresh_rate_hz"]).toBe(120);
  });

  it("converts the segment bounds from milliseconds to NANOSECONDS", () => {
    // The native payload is in ms; RN `navigation` events ship ns under these
    // exact key names. A missing conversion leaves the values individually
    // plausible and only the scale wrong, which nothing downstream would notice.
    harness.listener.handleEvent(segment());

    const attributes = attributesOf(harness)[0]!;
    expect(attributes["start_timestamp"]).toBe(START_MS * 1e6);
    expect(attributes["end_timestamp"]).toBe(END_MS * 1e6);
  });

  it("stamps the event timestamp with the segment's END, not the emit time", () => {
    // A segment describes a past interval. Timestamping it "now" would place a
    // screen's jank after the navigation that ended it.
    harness.listener.handleEvent(segment());

    const events = harness.eventsPool.addEvent.mock.calls.map(([e]) => e as { timestamp: number });
    expect(events).toHaveLength(1);
    for (const event of events) expect(event.timestamp).toBe(END_MS * 1e6);
  });

  it.each(["navigation", "background", "safety"] as const)(
    "carries the %s reason through to the wire",
    (reason) => {
      const h = setup();
      h.listener.handleEvent(segment({ reason }));

      expect(attributesOf(h)).toHaveLength(1);
      for (const attributes of attributesOf(h)) {
        expect(attributes["performance_segment_reason"]).toBe(reason);
      }
    }
  );

  it("describes the segment completely on the one event it emits", () => {
    // There is one event per segment, so it has to carry everything a consumer needs to place the
    // segment in time and on a screen without a join.
    harness.listener.handleEvent(segment());

    const [only] = attributesOf(harness);
    expect(attributesOf(harness)).toHaveLength(1);
    for (const key of [
      "performance_refresh_rate_hz",
      "performance_frame_budget_ms",
      "start_timestamp",
      "end_timestamp",
      "performance_segment_reason",
      "screen",
      "performance_metric_id",
    ]) {
      expect(only![key]).toBeDefined();
    }
  });

  // THE attribution test, and the reason this listener needs an override at all.
  // `enrichAttributes` is merged AFTER flattening, so it wins over anything the
  // listener puts in `attributes` — the only way to name a different screen is a
  // separate enricher, the same pattern native-crash-drain.ts uses for the
  // crash-time screen.
  it("attributes the segment to the OUTGOING screen when one is supplied", () => {
    harness.listener.handleEvent(segment(), { name: "Checkout", key: "Checkout-9" });

    expect(attributesOf(harness)).toHaveLength(1);
    for (const attributes of attributesOf(harness)) {
      expect(attributes["screen"]).toEqual({ name: "Checkout", key: "Checkout-9" });
    }
  });

  it("falls back to the ambient screen when no override is supplied", () => {
    // The background and safety closes are native pushes: the screen has not
    // changed, so the ambient stamp is the correct one.
    harness.listener.handleEvent(segment({ reason: "background" }));

    expect(attributesOf(harness)).toHaveLength(1);
    for (const attributes of attributesOf(harness)) {
      expect(attributes["screen"]).toEqual({ name: "Feed", key: "Feed-1" });
    }
  });

  it("does not force a flush — vitals ride along with the next batch", () => {
    harness.listener.handleEvent(segment());

    expect(harness.eventsPool.flush).not.toHaveBeenCalled();
  });

  /**
   * Ungated, the passive heartbeat would keep a foregrounded-but-idle app's session growing for as
   * long as the screen stays on. It is gated on the same inactivity rule gap rotation uses, read at
   * emit time so the two cannot disagree. The browser's equivalent is pausing rrweb on idle.
   */
  it("drops the segment while the session is inactive", () => {
    const idle = setup(() => true);

    idle.listener.handleEvent(segment({ reason: "safety" }));

    expect(idle.eventsPool.addEvent).not.toHaveBeenCalled();
  });

  it("gates the navigation-closed segment too, not just the native push", () => {
    // Both entry points (native's push, the JS pull on a screen change) land in handleEvent, so one
    // guard covers both — asserted, because a guard in the manager's router wiring would miss this.
    const idle = setup(() => true);

    idle.listener.handleEvent(segment({ reason: "navigation" }), {
      name: "Checkout",
      key: "Checkout-9",
    });

    expect(idle.eventsPool.addEvent).not.toHaveBeenCalled();
  });

  it("resumes emitting as soon as the session is active again", () => {
    // Read per segment, so the return needs no resume path. Also the control half: without it a
    // listener that dropped EVERY segment would pass the two tests above.
    let inactive = true;
    const h = setup(() => inactive);

    h.listener.handleEvent(segment());
    expect(h.eventsPool.addEvent).not.toHaveBeenCalled();

    inactive = false;
    h.listener.handleEvent(segment());
    expect(h.eventsPool.addEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores a signal that arrives after teardown", () => {
    harness.listener.destroy();

    harness.listener.handleEvent(segment());

    expect(harness.eventsPool.addEvent).not.toHaveBeenCalled();
  });

  it("does not let a pool failure escape into the emitter callback", () => {
    harness.eventsPool.addEvent.mockImplementation(() => {
      throw new Error("pool exploded");
    });

    expect(() => harness.listener.handleEvent(segment())).not.toThrow();
  });
});
