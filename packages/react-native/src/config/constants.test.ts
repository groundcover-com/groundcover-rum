import { describe, it, expect, vi, afterEach } from "vitest";

import {
  DEFAULT_ANDROID_HANG_THRESHOLD_MS,
  DEFAULT_HANG_THRESHOLD_MS,
  DEFAULT_TTI_SOURCE,
  DEFAULT_VITALS_MAX_SEGMENT_MS,
  resolveHangThresholdMs,
  resolveTtiSource,
  resolveVitalsMaxSegmentMs,
  selectHangThresholdMs,
} from "./constants";

// The hang threshold is the one native knob whose right value DIFFERS BY
// PLATFORM: iOS has no system-level hang bar, so 2s is a real signal there,
// while Android's own ANR threshold is 5s and anything below it flags stalls
// the OS itself tolerates.
//
// A single number applied to both would mean a host tuning for iOS also arms a
// 2s watchdog on Android — silently, with the documented 5s default gone — and
// gets a flood of "hangs" the platform does not consider hangs.
describe("selectHangThresholdMs", () => {
  it("applies a bare number to both platforms", () => {
    expect(selectHangThresholdMs(3_000, "ios")).toBe(3_000);
    expect(selectHangThresholdMs(3_000, "android")).toBe(3_000);
  });

  it("picks the per-platform value when one is given for each", () => {
    const tuned = { ios: 1_500, android: 8_000 };

    expect(selectHangThresholdMs(tuned, "ios")).toBe(1_500);
    expect(selectHangThresholdMs(tuned, "android")).toBe(8_000);
  });

  // The whole point of the object form. Tuning iOS must not move Android off
  // its own default, which a single number cannot express.
  it("leaves the other platform on its default when only one is tuned", () => {
    expect(selectHangThresholdMs({ ios: 1_500 }, "android")).toBe(
      DEFAULT_ANDROID_HANG_THRESHOLD_MS
    );
    expect(selectHangThresholdMs({ android: 8_000 }, "ios")).toBe(DEFAULT_HANG_THRESHOLD_MS);
  });

  it("falls back to each platform's default when nothing is configured", () => {
    expect(selectHangThresholdMs(undefined, "ios")).toBe(DEFAULT_HANG_THRESHOLD_MS);
    expect(selectHangThresholdMs(undefined, "android")).toBe(DEFAULT_ANDROID_HANG_THRESHOLD_MS);
  });

  // A nonsense value must not reach native, where a bogus threshold arms a
  // watchdog that fires constantly or never.
  it.each([
    ["an empty object", {}],
    ["null", null],
    ["a string", "2000"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["below the floor", 10],
    ["above the ceiling", 10 * 60_000],
    ["a per-platform value out of range", { android: 5 }],
  ])("falls back to the platform default for %s", (_label, value) => {
    expect(selectHangThresholdMs(value as never, "android")).toBe(
      DEFAULT_ANDROID_HANG_THRESHOLD_MS
    );
  });

  // "other" is RN on web/macOS/windows — the SDK targets ios/android, and the
  // native module is absent there anyway, so it must resolve rather than throw.
  it("treats a non-mobile host as iOS-shaped rather than failing", () => {
    expect(selectHangThresholdMs(undefined, "other")).toBe(DEFAULT_HANG_THRESHOLD_MS);
  });

  // The two engines read this field with DIFFERENT numeric types: Kotlin takes
  // it through `JSONObject.optLong` into a `Long`, Swift into a `Double`. A
  // fractional value therefore means 1500 on Android and 1500.5 on iOS — the
  // same config producing two different watchdogs. Integral before it crosses
  // the bridge is the only place that can be fixed once for both.
  it.each([
    [1_500.5, 1_501],
    [1_500.4, 1_500],
    [2_000, 2_000],
  ])("rounds %p to whole milliseconds so both engines read the same value", (input, expected) => {
    expect(selectHangThresholdMs(input, "ios")).toBe(expected);
  });

  it("rounds a per-platform value too", () => {
    expect(selectHangThresholdMs({ android: 8_000.6 }, "android")).toBe(8_001);
  });
});

// The clamp underneath the per-platform selection, pinned on its own so the
// accepted range cannot change unnoticed.
describe("resolveHangThresholdMs", () => {
  it("passes an in-range value through", () => {
    expect(resolveHangThresholdMs(3_000, DEFAULT_HANG_THRESHOLD_MS)).toBe(3_000);
  });

  it.each([Number.NaN, 10, 10 * 60_000, "2000", null, undefined])(
    "falls back for %p",
    (value) => {
      expect(resolveHangThresholdMs(value as never, DEFAULT_HANG_THRESHOLD_MS)).toBe(
        DEFAULT_HANG_THRESHOLD_MS
      );
    }
  );
});

describe("resolveVitalsMaxSegmentMs", () => {
  it("passes an in-range value through", () => {
    expect(resolveVitalsMaxSegmentMs(20_000)).toBe(20_000);
  });

  // Same split as the hang threshold: Kotlin reads this one through optLong
  // into a Long, Swift into a Double.
  it("rounds to whole milliseconds so both engines read the same value", () => {
    expect(resolveVitalsMaxSegmentMs(20_000.6)).toBe(20_001);
  });

  it.each([Number.NaN, 100, 10 * 60_000, "20000", null, undefined])(
    "falls back for %p",
    (value) => {
      expect(resolveVitalsMaxSegmentMs(value as never)).toBe(DEFAULT_VITALS_MAX_SEGMENT_MS);
    }
  );
});

// `tti` is checked, never cast: read with a cast, anything that is not exactly "manual" falls
// through to auto. Unlike the numeric knobs above, this one is not a matter of degree: a host
// that typed "Manual" calls `markAppInteractive()` and the SDK ignores every call, measuring TTI
// a different way than asked — so it also warns, which the clamped numbers deliberately do not.
describe("resolveTtiSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["manual", "auto"] as const)("passes %p through", (value) => {
    expect(resolveTtiSource(value)).toBe(value);
  });

  it.each([undefined, null])("defaults silently when unset (%p)", (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveTtiSource(value)).toBe(DEFAULT_TTI_SOURCE);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["Manual", "MANUAL", "", "none", 1, true, {}])(
    "falls back to the default for %p",
    (value) => {
      expect(resolveTtiSource(value)).toBe(DEFAULT_TTI_SOURCE);
    }
  );

  // A value not used by any case above: `warnOnce` dedupes per MESSAGE for the life of the
  // process, so reusing one would make this assert against an already-spent warning.
  // The warning formats the offending value, and formatting HOST input is itself a hazard:
  // `JSON.stringify` throws on a BigInt, a circular object or a throwing `toJSON`, and it runs as
  // an argument — so `safeWarn`'s own try/catch never sees it. A resolver whose whole job is to
  // tolerate a bad option would then propagate out of `instrument()` into the init catch and tear
  // the SDK down, turning a typo into no SDK at all.
  it.each([
    ["a bigint", 1n],
    ["a circular object", (() => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return circular;
    })()],
    ["a throwing toJSON", { toJSON: () => {
      throw new Error("nope");
    } }],
  ])("survives %s instead of throwing at the caller", (_label, value) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => resolveTtiSource(value)).not.toThrow();
    expect(resolveTtiSource(value)).toBe(DEFAULT_TTI_SOURCE);
  });

  // Our own `console.warn` is captured by the log listener, so an unbounded value would ride into
  // a log event. Non-strings are described by TYPE — the host needs to know which option is wrong,
  // not to see its contents echoed back.
  it("bounds what it echoes back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    resolveTtiSource("m".repeat(500));

    const message = String(warn.mock.calls[0]![0]);
    expect(message.length).toBeLessThan(200);
    expect(message).toContain("tti");
  });

  it("warns once for a value the host meant to be meaningful", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(resolveTtiSource("eager")).toBe(DEFAULT_TTI_SOURCE);
    resolveTtiSource("eager");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("tti");
    // The offending value, or the host cannot tell which of its options is wrong.
    expect(String(warn.mock.calls[0]![0])).toContain("eager");
  });
});
