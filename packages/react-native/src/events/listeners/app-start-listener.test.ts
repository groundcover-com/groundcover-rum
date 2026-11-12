import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigManager,
  EventEnricher,
  RandomIdGenerator,
  type SDKConfigInput,
} from "@groundcover/rum-core";

import { AppStartListener } from "./app-start-listener";
import {
  __resetInteractiveMarkForTest,
  markAutoInteractive,
  markManualInteractive,
} from "../../internal/interactive-mark";
import type { NativeAppStartPayload } from "../../platform/native-types";
import type { ScreenAttributes } from "../rn-event-types";

function setup(
  ttiSource: "auto" | "manual" = "auto",
  initialScreen: ScreenAttributes = { name: "Home", key: "Home-1" }
) {
  const config = new ConfigManager();
  config.initialize({
    dsn: "ingest.example",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
  } as SDKConfigInput);

  let screen = initialScreen;
  const screenHolder = {
    get: () => screen,
    set: (next: ScreenAttributes) => {
      screen = next;
    },
    subscribe: () => () => {},
  };

  const eventsPool = { addEvent: vi.fn(), flush: vi.fn() };
  const listener = new AppStartListener({
    config,
    eventsPool: eventsPool as never,
    enricher: new EventEnricher({
      enrichAttributes: () => ({ screen: screenHolder.get() }),
      idGenerator: new RandomIdGenerator(),
    }),
    screenHolder,
    ttiSource,
    idGenerator: new RandomIdGenerator(),
  });
  listener.initialize();

  return { listener, eventsPool, screenHolder };
}

type Harness = ReturnType<typeof setup>;

const metrics = (h: Harness) =>
  h.eventsPool.addEvent.mock.calls.map(([event]) => {
    const attributes = (event as { attributes: Record<string, unknown> }).attributes;
    return {
      name: attributes["performance_metric_name"],
      value: attributes["performance_metric_value"],
      navigationType: attributes["performance_metric_navigation_type"],
      screen: attributes["screen"],
      type: (event as { type: string }).type,
    };
  });

const coldStart = (over: Partial<NativeAppStartPayload> = {}): NativeAppStartPayload => ({
  type: "cold",
  startMs: 1_700_000_000_000,
  firstFrameMs: 1_700_000_000_842,
  ...over,
});

afterEach(() => {
  __resetInteractiveMarkForTest();
});

describe("AppStartListener", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setup();
  });

  it("reports a cold start as a performance event", () => {
    harness.listener.handleEvent(coldStart());

    expect(metrics(harness)).toEqual([
      {
        type: "performance",
        name: "app_start_cold",
        value: 842,
        navigationType: "cold",
        screen: { name: "Home", key: "Home-1" },
      },
    ]);
  });

  it("measures a warm start from ITS OWN anchor, not from process start", () => {
    // Guards against: a warm start two hours into a live process measured
    // from process start reports a two-hour "launch".
    const twoHoursMs = 2 * 60 * 60 * 1000;
    harness.listener.handleEvent({
      type: "warm",
      startMs: 1_700_000_000_000 + twoHoursMs,
      firstFrameMs: 1_700_000_000_000 + twoHoursMs + 180,
    });

    const [metric] = metrics(harness);
    expect(metric!.name).toBe("app_start_warm");
    expect(metric!.value).toBe(180);
  });

  it("carries the prewarmed launch type through", () => {
    // iOS may start the process long before the user opens the app; the launch
    // is real but not comparable to an ordinary cold start.
    harness.listener.handleEvent(coldStart({ type: "cold_prewarmed" }));

    const [metric] = metrics(harness);
    expect(metric!.name).toBe("app_start_cold");
    expect(metric!.navigationType).toBe("cold_prewarmed");
  });

  /**
   * A check like `payload.type !== "warm"` would treat an unknown `type` as a COLD start.
   * Cold-start duration is the number anyone actually watches, so a misclassification lands in the
   * one series where it does most damage — and the offending value would also ride through to the
   * wire as `performance_metric_navigation_type`.
   *
   * Dropped rather than guessed, unlike `NativeFrameSegmentReason`, which deliberately passes an
   * unknown label through. The difference is what the value DOES: a segment reason is a label on
   * data that is still good, while this string selects which metric series the value lands in. A
   * guessed series is worse than a missing point.
   *
   * Only reachable on JS/native version skew — a binary newer than the bundle — so it warns.
   *
   * `constructor` and friends are in the list because the lookup table is an object literal, so it
   * inherits `Object.prototype`. A plain `TYPES[raw]` finds `Object` for `"constructor"` — truthy,
   * therefore "known" — and spreading a function yields no `metric` at all, so the drop that every
   * other unrecognised string gets is skipped and an undefined metric name reaches the wire. Five
   * strings, out of every possible one, would take the success path.
   */
  it.each(["teleported", "constructor", "__proto__", "toString", "hasOwnProperty"])(
    "drops an app start whose type it does not recognise, and says so: %s",
    (type) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = setup();
      h.listener.handleEvent(coldStart({ type: type as never }));

      expect(h.eventsPool.addEvent).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("app start");
    } finally {
      warn.mockRestore();
    }
  }
  );

  /**
   * A HOT start — the app returned to the foreground with its UI intact — is its own population and
   * gets its own metric. Folded into `app_start_warm`, it would make that metric count a different
   * thing on each platform: iOS emits one per foreground return, Android only when the Activity has
   * actually been recreated.
   */
  it("reports a hot start under its own name, without touching the cold anchor", () => {
    const start = coldStart({ type: "hot" as never });
    harness.listener.handleEvent(start);

    expect(metrics(harness).map((m) => m.name)).toEqual(["app_start_hot"]);
    expect(metrics(harness)[0]!.navigationType).toBe("hot");

    // The TTI anchor is a COLD-start property. A hot start must not become one, or TTI would be
    // measured from a foreground return hours into the process.
    markAutoInteractive(start.firstFrameMs + 1_000);
    expect(metrics(harness).find((m) => m.name === "app_start_tti")).toBeUndefined();
  });

  it("composes TTI from the interactive mark and the cold-start anchor", () => {
    const start = coldStart();
    harness.listener.handleEvent(start);

    markAutoInteractive(start.startMs + 1_500);

    const tti = metrics(harness).find((m) => m.name === "app_start_tti");
    expect(tti).toMatchObject({ value: 1_500, navigationType: "cold" });
  });

  it("clamps TTI to the first frame — the app cannot be usable before it is visible", () => {
    // A native splash screen lets JS run before anything is drawn.
    const start = coldStart();
    harness.listener.handleEvent(start);

    markAutoInteractive(start.startMs + 100); // earlier than the 842ms first frame

    const tti = metrics(harness).find((m) => m.name === "app_start_tti");
    expect(tti!.value).toBe(842);
  });

  it("reports TTI when the mark landed BEFORE the native payload arrived", () => {
    const start = coldStart();
    markAutoInteractive(start.startMs + 1_200);

    harness.listener.handleEvent(start);

    expect(metrics(harness).find((m) => m.name === "app_start_tti")?.value).toBe(1_200);
  });

  it("reports TTI once, even if both marks land", () => {
    const start = coldStart();
    harness.listener.handleEvent(start);

    markAutoInteractive(start.startMs + 1_000);
    markManualInteractive(start.startMs + 2_000);

    expect(metrics(harness).filter((m) => m.name === "app_start_tti")).toHaveLength(1);
  });

  it("in manual mode ignores the automatic mark", () => {
    const manual = setup("manual");
    const start = coldStart();
    manual.listener.handleEvent(start);

    markAutoInteractive(start.startMs + 500);
    expect(metrics(manual).find((m) => m.name === "app_start_tti")).toBeUndefined();

    markManualInteractive(start.startMs + 3_000);
    expect(metrics(manual).find((m) => m.name === "app_start_tti")?.value).toBe(3_000);
  });

  it("does not report TTI for a warm start", () => {
    harness.listener.handleEvent({
      type: "warm",
      startMs: 1_700_000_000_000,
      firstFrameMs: 1_700_000_000_180,
    });

    markAutoInteractive(1_700_000_000_500);

    expect(metrics(harness).find((m) => m.name === "app_start_tti")).toBeUndefined();
  });

  it("holds a start metric until the landing screen is known", () => {
    // Launch metrics are far more useful attributed to the screen the user
    // arrived on than to an empty one.
    const noScreen = setup("auto", { name: "", key: "" });

    noScreen.listener.handleEvent(coldStart());
    expect(metrics(noScreen)).toHaveLength(0);

    noScreen.screenHolder.set({ name: "Home", key: "Home-1" });
    noScreen.listener.notifyScreenKnown();

    expect(metrics(noScreen)[0]).toMatchObject({
      name: "app_start_cold",
      screen: { name: "Home", key: "Home-1" },
    });
  });

  it("gives up waiting for a screen rather than losing the metric", () => {
    vi.useFakeTimers();
    try {
      const noScreen = setup("auto", { name: "", key: "" });
      noScreen.listener.handleEvent(coldStart());

      vi.advanceTimersByTime(5_000);

      expect(metrics(noScreen)[0]).toMatchObject({ name: "app_start_cold" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a payload with a negative or nonsense duration", () => {
    harness.listener.handleEvent(
      coldStart({ startMs: 1_700_000_001_000, firstFrameMs: 1_700_000_000_000 })
    );

    expect(metrics(harness)).toHaveLength(0);
  });

  it("ignores a signal that arrives after teardown", () => {
    harness.listener.destroy();

    harness.listener.handleEvent(coldStart());

    expect(harness.eventsPool.addEvent).not.toHaveBeenCalled();
  });

  it("unsubscribes from the mark on destroy", () => {
    const start = coldStart();
    harness.listener.handleEvent(start);
    harness.listener.destroy();

    markAutoInteractive(start.startMs + 1_000);

    expect(metrics(harness).find((m) => m.name === "app_start_tti")).toBeUndefined();
  });

  // Buffered metrics released at once must stay independent, or one failure takes the rest with
  // it. `queueEvent` already contains a POOL throw — these are about the id generation and
  // enrichment in `buildEvent`, which run outside it.

  it("a metric that fails to compose does not take the ones queued behind it", () => {
    // Two callbacks buffer when two starts arrive before any screen lands — a launch that is
    // backgrounded and resumed before the first screen mounts.
    const noScreen = setup("auto", { name: "", key: "" });
    const realBuild = AppStartListener.prototype.buildEvent;
    vi.spyOn(AppStartListener.prototype, "buildEvent").mockImplementation(function (
      this: AppStartListener,
      name,
      valueMs,
      navigationType
    ) {
      if (name === "app_start_cold") throw new Error("enrich boom");
      return realBuild.call(this, name, valueMs, navigationType);
    });

    noScreen.listener.handleEvent(coldStart());
    noScreen.listener.handleEvent(coldStart({ type: "warm" }));
    noScreen.screenHolder.set({ name: "Home", key: "Home-1" });

    // Escaping here would reach the composition root's screen-change callback, i.e. host navigation.
    expect(() => noScreen.listener.notifyScreenKnown()).not.toThrow();
    // The warm metric was queued BEHIND the throwing cold one and still shipped.
    expect(metrics(noScreen).map((m) => m.name)).toEqual(["app_start_warm"]);

    vi.restoreAllMocks();
  });

  it("the 5s giveaway timer contains a failing metric instead of throwing at nobody", () => {
    vi.useFakeTimers();
    try {
      const noScreen = setup("auto", { name: "", key: "" });
      vi.spyOn(AppStartListener.prototype, "buildEvent").mockImplementation(() => {
        throw new Error("enrich boom");
      });

      noScreen.listener.handleEvent(coldStart());

      // A throw out of a setTimeout callback is an uncaught error with no caller to attribute it
      // to — under Jest/vitest fake timers it surfaces here, on device it reaches the host's
      // global error handler and is reported as the app's own crash.
      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("a failed start metric does not suppress TTI from the same callback", () => {
    // One buffered callback emits the start metric AND then composes TTI. They come from
    // independent inputs, so a failure in the first must not silently delete the second.
    const noScreen = setup("auto", { name: "", key: "" });
    const start = coldStart();
    const realBuild = AppStartListener.prototype.buildEvent;
    vi.spyOn(AppStartListener.prototype, "buildEvent").mockImplementation(function (
      this: AppStartListener,
      name,
      valueMs,
      navigationType
    ) {
      if (name === "app_start_cold") throw new Error("enrich boom");
      return realBuild.call(this, name, valueMs, navigationType);
    });

    noScreen.listener.handleEvent(start);
    markAutoInteractive(start.startMs + 1_000);
    noScreen.screenHolder.set({ name: "Home", key: "Home-1" });
    noScreen.listener.notifyScreenKnown();

    expect(metrics(noScreen).map((m) => m.name)).toEqual(["app_start_tti"]);

    vi.restoreAllMocks();
  });
});
