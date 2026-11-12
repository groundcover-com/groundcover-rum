import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __emitNativeSignal,
  __nativeListenerCount,
  __reset,
  __setNativeModule,
} from "../test-utils/react-native-stub";
import {
  clearPendingCrashReports,
  flushFrameSegment,
  initNative,
  loadNativeModule,
  readPendingCrashReports,
  subscribeNativeSignals,
} from "./native-bridge";
import {
  NATIVE_EVENT_CHANNEL,
  NATIVE_MODULE_NAME,
  type GroundcoverNativeModule,
  type NativeFrameSegment,
} from "./native-types";
import type { FrameVitalsEventAttributes } from "../events/rn-event-types";

function stubModule(overrides: Partial<GroundcoverNativeModule> = {}): GroundcoverNativeModule {
  return {
    nativeInit: vi.fn().mockResolvedValue('{"crashes":true,"hangs":true,"appStart":true,"vitals":true,"gestures":true}'),
    updateSessionSnapshot: vi.fn(),
    getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
    clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
    flushFrameSegment: vi.fn().mockResolvedValue("null"),
    stop: vi.fn(),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
    ...overrides,
  };
}

const CONFIG = {
  features: { crashes: true, hangs: true, appStart: true, vitals: true, gestures: true },
  thresholds: { hangThresholdMs: 2000, vitalsMaxSegmentMs: 60000 },
};

afterEach(() => {
  __reset();
});

describe("loadNativeModule", () => {
  it("returns null when the binary has no native module (Expo Go, or a build without it)", () => {
    expect(loadNativeModule()).toBeNull();
  });

  it("returns the module once it is registered", () => {
    const mod = stubModule();
    __setNativeModule(NATIVE_MODULE_NAME, mod);

    expect(loadNativeModule()).toBe(mod);
  });
});

describe("initNative", () => {
  it("reports which features actually armed", async () => {
    const mod = stubModule({
      nativeInit: vi.fn().mockResolvedValue('{"crashes":true,"gestures":false}'),
    });

    const result = await initNative(mod, CONFIG);

    expect(result).toEqual({
      crashes: true,
      hangs: false,
      appStart: false,
      vitals: false,
      // A tracker that did not attach must report false — gesture suppression
      // keys on this, so a wrong `true` would silently drop the signal.
      gestures: false,
      gesturesAttached: false,
      // What that tracker can REACH, distinct from whether it is hooked. Absent from this
      // binary's JSON, and a binary that was never asked cannot promise coverage — so false,
      // which keeps JS reporting rather than suppressing a surface nobody watches.
      gesturesCoverAllSurfaces: false,
    });
  });

  /**
   * Distinct from `gestures`: armed vs hooked-right-now. Only a re-init reports true, and it is
   * the only way a JS context that arrived after the attach can learn about it — the
   * `gestures_attached` signal is edge-triggered and a re-init never re-attaches.
   */
  it("reads gesturesAttached as the separate fact it is", async () => {
    const mod = stubModule({
      nativeInit: vi.fn().mockResolvedValue('{"gestures":true,"gesturesAttached":true}'),
    });

    const result = await initNative(mod, CONFIG);

    expect(result.gestures).toBe(true);
    expect(result.gesturesAttached).toBe(true);
  });

  /**
   * A binary one version behind never sends the key. Absent has to mean "not attached": that
   * build only announces an attach through the signal, so defaulting to false leaves JS in charge
   * rather than standing it down for a tracker whose state nobody can confirm.
   */
  it("treats a missing gesturesAttached as not attached", async () => {
    const mod = stubModule({
      nativeInit: vi.fn().mockResolvedValue('{"gestures":true}'),
    });

    await expect(initNative(mod, CONFIG)).resolves.toMatchObject({
      gestures: true,
      gesturesAttached: false,
    });
  });

  it("degrades to no-features-armed when the native call rejects", async () => {
    const mod = stubModule({ nativeInit: vi.fn().mockRejectedValue(new Error("boom")) });

    await expect(initNative(mod, CONFIG)).resolves.toEqual({
      crashes: false,
      hangs: false,
      appStart: false,
      vitals: false,
      gestures: false,
      gesturesAttached: false,
    });
  });

  it("degrades to no-features-armed on malformed JSON", async () => {
    const mod = stubModule({ nativeInit: vi.fn().mockResolvedValue("not json") });

    const result = await initNative(mod, CONFIG);

    expect(result.crashes).toBe(false);
  });

  // `crashes: false` reads identically whether the host never asked for crash
  // reporting or asked and native could not install — which happens for real
  // whenever another KSCrash-based reporter already owns the
  // process-wide singleton. Refusing there is correct; being silent about it is
  // not, because the app then reports no native crashes at all and nothing says
  // so. Native reports the reason; JS owns the logger and warns.
  it("surfaces why crash reporting is unavailable", async () => {
    const mod = stubModule({
      nativeInit: vi
        .fn()
        .mockResolvedValue('{"crashes":false,"crashesUnavailable":"KSCrash already installed"}'),
    });

    const result = await initNative(mod, CONFIG);

    expect(result.crashesUnavailable).toBe("KSCrash already installed");
  });

  it("leaves the reason undefined when native reports nothing wrong", async () => {
    const mod = stubModule({
      nativeInit: vi.fn().mockResolvedValue('{"crashes":true}'),
    });

    const result = await initNative(mod, CONFIG);

    expect(result.crashesUnavailable).toBeUndefined();
  });

  // The reason reaches a log line and a template string. A non-string arriving
  // from a binary one version ahead would render as "[object Object]" in the
  // customer's console — noise that looks like an SDK bug.
  it.each([
    ["an object", "{}"],
    ["a number", "42"],
    ["null", "null"],
    ["an empty string", '""'],
  ])("ignores a reason that is not a usable string (%s)", async (_label, raw) => {
    const mod = stubModule({
      nativeInit: vi.fn().mockResolvedValue(`{"crashes":false,"crashesUnavailable":${raw}}`),
    });

    const result = await initNative(mod, CONFIG);

    expect(result.crashesUnavailable).toBeUndefined();
  });
});

describe("readPendingCrashReports", () => {
  /**
   * What a record looks like on the way out: the fields the JSON did not carry
   * are filled with the values the drain would have used for a missing field
   * anyway, so the returned object actually is the `PendingCrashRecord` its type
   * claims. `screen` is absent unless the JSON had a usable one — the drain falls
   * back to the crashed session snapshot's screen, and an empty screen would take
   * that fallback away.
   */
  function normalized(overrides: Record<string, unknown> = {}) {
    return {
      id: "r1",
      crashEpochMs: 1,
      errorType: "SIGSEGV",
      errorMessage: "",
      stacktrace: [],
      metadata: {},
      sessionSnapshotJson: null,
      ...overrides,
    };
  }

  it("parses the record array", async () => {
    const record = { id: "r1", crashEpochMs: 1, errorType: "SIGSEGV" };
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(JSON.stringify([record])),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([normalized()]);
  });

  it("passes a fully-formed record through unchanged", async () => {
    const record = {
      id: "r1",
      crashEpochMs: 1,
      errorType: "SIGSEGV",
      errorMessage: "boom",
      stacktrace: [{ filename: "App", function: "main", lineno: 0, colno: 0 }],
      metadata: { signal: "SIGSEGV" },
      sessionSnapshotJson: "{}",
      screen: { name: "Cart", key: "Cart-1" },
    };
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(JSON.stringify([record])),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([record]);
  });

  // `NativeStackFrame` declares four required fields and `normalizeStackFrames` asserts that
  // type, so checking `filename` alone would let a frame off a cross-version disk record
  // reach the wire with `function`/`lineno`/`colno` missing or the wrong type, under a
  // predicate claiming otherwise. Coerced rather than dropped, matching `toCrashRecord`: a frame
  // with a filename still symbolicates, and the defaults are the documented ones (`lineno` is 0
  // for native frames anyway).
  it("coerces stack frame fields other than filename", async () => {
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            id: "r1",
            crashEpochMs: 1,
            errorType: "SIGSEGV",
            stacktrace: [
              { filename: "App" },
              { filename: "Cart", function: 5, lineno: "12", colno: null },
            ],
          },
        ])
      ),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([
      normalized({
        stacktrace: [
          { filename: "App", function: "", lineno: 0, colno: 0 },
          { filename: "Cart", function: "", lineno: 0, colno: 0 },
        ],
      }),
    ]);
  });

  /**
   * The records are JSON off the device's disk, possibly written by another SDK version.
   * Asserting the type from an `id` check alone would ship whatever the file held — a
   * non-string `errorMessage` would go out as an `error_message` the schema calls a string,
   * fingerprinted from a stringified object. Coerced, not dropped: each fallback is what
   * a simply-absent field would have produced.
   */
  it("coerces fields the JSON did not type correctly", async () => {
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            id: "r1",
            crashEpochMs: 1,
            errorType: 42,
            errorMessage: { code: 7 },
            stacktrace: "not frames",
            metadata: "oops",
            sessionSnapshotJson: 5,
            screen: "Cart",
          },
        ])
      ),
    });

    // Every bad field falls back, and `screen` drops out entirely rather than
    // masquerading as an empty one.
    await expect(readPendingCrashReports(mod)).resolves.toEqual([normalized({ errorType: "" })]);
  });

  it("drops a screen object whose members are not strings, so the snapshot's screen wins", async () => {
    // An OBJECT passes an `isRecord` gate even with a numeric name; the drain prefers
    // record.screen over the snapshot's, so `{ name: 5 }` would ship a stringified non-string
    // in place of a valid screen. It must be treated as absent, exactly like `screen: "Cart"`.
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([{ id: "r1", crashEpochMs: 1, errorType: "SIGSEGV", screen: { name: 5 } }])
      ),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([normalized()]);
  });

  // Kotlin caps the chain at MAX_CAUSE_DEPTH = 5 and iOS writes none, but without a cap on this
  // side a corrupt or hand-written record could carry thousands, and every one of them would
  // reach `error_metadata` on the wire. Capped HERE rather than in the drain's redaction
  // step, because at privacy level `allow` that step does not run at all.
  it("caps a cause chain no producer could have written", async () => {
    const causes = Array.from({ length: 5_000 }, (_, i) => ({ type: "E", message: `c${i}` }));
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([{ id: "r1", crashEpochMs: 1, errorType: "SIGSEGV", metadata: { causes } }])
      ),
    });

    const [parsed] = await readPendingCrashReports(mod);
    const kept = (parsed!.metadata as { causes: unknown[] }).causes;
    expect(kept).toHaveLength(20);
    // Oldest-first: the chain's HEAD is the wrapper that was actually thrown, and the frames
    // above only describe it — truncating from the front would drop the exception the app saw.
    expect(kept[0]).toEqual({ type: "E", message: "c0" });
  });

  // A chain within the cap is untouched, including its object identity of contents — the cap is a
  // resource guard, not a rewrite of what native reported.
  it("leaves a plausible cause chain alone", async () => {
    const causes = [
      { type: "java.io.IOException", message: "socket closed" },
      { type: "java.net.SocketException", message: "reset" },
    ];
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([{ id: "r1", crashEpochMs: 1, errorType: "SIGSEGV", metadata: { causes } }])
      ),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([
      normalized({ metadata: { causes } }),
    ]);
  });

  // BOTH native mappers write `screen` unconditionally, using `{name:"", key:""}` when they
  // cannot lift one out of the snapshot (GcRumScreenSnapshot.screenFrom, and Swift's
  // `screen["name"] as? String ?? ""`). A types-only check calls that valid, so `record.screen`
  // would ALWAYS be truthy and the drain's `?? snapshot.screen` fallback unreachable — a crash
  // whose screen native failed to read would ship with no screen, while JS's own read of the very
  // same snapshot string would succeed. The sentinel has to read as absent.
  it("drops a screen whose members are both empty, so the snapshot's screen wins", async () => {
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([
          { id: "r1", crashEpochMs: 1, errorType: "SIGSEGV", screen: { name: "", key: "" } },
        ])
      ),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([normalized()]);
  });

  // Only the FULLY empty sentinel is absent. A screen native identified by key but could not
  // name (or the reverse) is real information, and dropping it would fall back to a snapshot
  // screen that may be staler.
  it("keeps a screen with only one empty member", async () => {
    const mod = stubModule({
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([
          { id: "r1", crashEpochMs: 1, errorType: "SIGSEGV", screen: { name: "", key: "Cart-1" } },
        ])
      ),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([
      normalized({ screen: { name: "", key: "Cart-1" } }),
    ]);
  });

  /**
   * `Infinity` is the one numeric value able to defeat the drain's fallback: NaN is
   * falsy so `timestamp || now` substitutes, but `Infinity * 1e6` is truthy and
   * `JSON.stringify` writes it as `null` — an event with no timestamp at all. It never
   * arrives, because records cross as a JSON string and JSON has no `Infinity` literal.
   * Written out because the guard reads as a mere type check.
   */
  it("cannot receive a non-finite crash time, because JSON cannot carry one", async () => {
    const mod = stubModule({
      getPendingCrashReports: vi
        .fn()
        .mockResolvedValue(JSON.stringify([{ id: "r1", crashEpochMs: Infinity, errorType: "SIGSEGV" }])),
    });

    const [read] = await readPendingCrashReports(mod);

    // Serialized as null on the way out, so it lands as the NaN that makes the
    // drain fall back — never as Infinity.
    expect(Number.isNaN(read!.crashEpochMs)).toBe(true);
  });

  it("returns an empty list rather than throwing on a corrupt payload", async () => {
    const mod = stubModule({ getPendingCrashReports: vi.fn().mockResolvedValue("{oops") });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([]);
  });

  /**
   * A record with no usable `id` is unackable, and unackable means FOREVER.
   *
   * The id is the ack key. Reported-then-acked is the only path that removes a
   * record from native, so an id that is missing or not a string is reported as
   * delivered and then acked as `clearPendingCrashReports([undefined])` — which
   * deletes nothing. The record is still there on the next launch, and the one
   * after that, redelivering the same crash for the life of the install while
   * occupying one of the ten pending slots.
   */
  it("drops a record with no usable id, which could never be acked", async () => {
    const good = { id: "r1", crashEpochMs: 1, errorType: "SIGSEGV" };
    const mod = stubModule({
      getPendingCrashReports: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify([good, { crashEpochMs: 2 }, { id: 7, crashEpochMs: 3 }, { id: "", crashEpochMs: 4 }, null, "x"])
        ),
    });

    await expect(readPendingCrashReports(mod)).resolves.toEqual([normalized()]);
  });
});

describe("clearPendingCrashReports", () => {
  it("skips the bridge hop when there is nothing to ack", async () => {
    const mod = stubModule();

    await clearPendingCrashReports(mod, []);

    expect(mod.clearPendingCrashReports).not.toHaveBeenCalled();
  });

  it("swallows a native failure — a failed ack means redelivery, not a crash", async () => {
    const mod = stubModule({
      clearPendingCrashReports: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    await expect(clearPendingCrashReports(mod, ["r1"])).resolves.toBeUndefined();
  });
});

const SEGMENT = {
  segmentStartMs: 1_700_000_000_000,
  segmentEndMs: 1_700_000_002_000,
  total: 120,
  slow: 12,
  frozen: 1,
  refreshRate: 60,
  reason: "navigation" as const,
};

// The pull path. Every failure has to collapse to `null` rather than propagate:
// the caller is a screen change, and a screen change must not fail because native
// did — nor wait for it to succeed.
describe("flushFrameSegment", () => {
  it("parses the segment native hands back", async () => {
    const mod = stubModule({
      flushFrameSegment: vi.fn().mockResolvedValue(JSON.stringify(SEGMENT)),
    });

    await expect(flushFrameSegment(mod)).resolves.toEqual(SEGMENT);
  });

  it("resolves null when native reports nothing to flush", async () => {
    // The common case, not an error: a screen the app never drew a frame on.
    const mod = stubModule({ flushFrameSegment: vi.fn().mockResolvedValue("null") });

    await expect(flushFrameSegment(mod)).resolves.toBeNull();
  });

  it("resolves null on malformed JSON", async () => {
    const mod = stubModule({ flushFrameSegment: vi.fn().mockResolvedValue("{oops") });

    await expect(flushFrameSegment(mod)).resolves.toBeNull();
  });

  it("rejects a segment whose required numbers are not finite", async () => {
    // `1e999` parses to Infinity, not to a string or a NaN literal — valid JSON of the
    // wrong VALUE, which `typeof x === "number"` waves through. It then survives all the
    // way to `JSON.stringify`, which writes it as `null`: a schema-declared number
    // arriving null, indistinguishable from a field native never sent.
    const mod = stubModule({
      flushFrameSegment: vi.fn().mockResolvedValue(
        JSON.stringify({ ...SEGMENT }).replace(/"total":\d+/, '"total":1e999')
      ),
    });

    await expect(flushFrameSegment(mod)).resolves.toBeNull();
  });

  it("drops a non-finite optional metric but keeps the segment", async () => {
    // The opposite call from the required fields, on purpose: absent is a case these two
    // already handle (a binary one version behind does not send them), so a garbage value
    // costs what a missing one costs. Discarding the segment would throw away the counts,
    // the refresh rate and both timestamps over one spoiled metric.
    // Spliced into the JSON TEXT rather than written as a literal: `1e999` in source is an
    // Infinity the linter rejects outright (no-loss-of-precision), and `JSON.stringify`
    // would render an `Infinity` value as `null` — neither reproduces what native sends.
    const mod = stubModule({
      flushFrameSegment: vi.fn().mockResolvedValue(
        JSON.stringify({ ...SEGMENT, budgetMs: 16.7 }).replace(/}$/, ',"delayMs":1e999}')
      ),
    });

    const segment = await flushFrameSegment(mod);

    expect(segment).not.toBeNull();
    expect(segment).not.toHaveProperty("delayMs");
    expect(segment?.budgetMs).toBe(16.7);
    expect(segment?.total).toBe(SEGMENT.total);
  });

  it("resolves null when the promise rejects", async () => {
    const mod = stubModule({
      flushFrameSegment: vi.fn().mockRejectedValue(new Error("bridge gone")),
    });

    await expect(flushFrameSegment(mod)).resolves.toBeNull();
  });

  it("resolves null when the binary predates the method", async () => {
    // An OTA JS bundle can be newer than the installed binary, so the method may
    // simply not be there. Vitals go quiet; nothing else notices.
    const mod = stubModule({ flushFrameSegment: undefined as never });

    await expect(flushFrameSegment(mod)).resolves.toBeNull();
  });

  it("rejects a payload that is not a segment at all", async () => {
    // Valid JSON of the wrong shape is the dangerous case: without a check, a
    // `total` of undefined reaches the listener and ships NaN rates.
    const mod = stubModule({ flushFrameSegment: vi.fn().mockResolvedValue('{"nope":1}') });

    await expect(flushFrameSegment(mod)).resolves.toBeNull();
  });

  /**
   * `isFrameSegment` accepts any string for `reason` on purpose: an OTA ships JS alone,
   * so the installed binary can be NEWER and close a segment for a reason this build has
   * never heard of. The seven other fields are still understood, and the wire field is
   * free text. Rejecting would return `null`, which the caller drops — discarding
   * `total`, `slow`, `frozen`, `refreshRate` and both timestamps over one label. This
   * test exists to make that regression loud, since tightening the guard looks like a fix.
   */
  it("keeps a segment whose reason this build has never heard of", async () => {
    const forward = { ...SEGMENT, reason: "timeout" };
    const mod = stubModule({
      flushFrameSegment: vi.fn().mockResolvedValue(JSON.stringify(forward)),
    });

    const segment = await flushFrameSegment(mod);

    expect(segment).toEqual(forward);
    // The counts are the point: they survive intact alongside the unknown label.
    expect(segment?.total).toBe(120);
    expect(segment?.slow).toBe(12);
    expect(segment?.reason).toBe("timeout");
  });

  it("still rejects a segment whose reason is missing or not a string", async () => {
    // Forward-compatibility is about values we do not RECOGNISE, not about a
    // field that is absent or of the wrong type — that is a malformed payload.
    const { reason: _dropped, ...noReason } = SEGMENT;
    const missing = stubModule({
      flushFrameSegment: vi.fn().mockResolvedValue(JSON.stringify(noReason)),
    });
    const wrongType = stubModule({
      flushFrameSegment: vi.fn().mockResolvedValue(JSON.stringify({ ...SEGMENT, reason: 7 })),
    });

    await expect(flushFrameSegment(missing)).resolves.toBeNull();
    await expect(flushFrameSegment(wrongType)).resolves.toBeNull();
  });

  /**
   * The stale-native-build trap, and why it needs a voice.
   *
   * Metro serves fresh JavaScript against the INSTALLED binary, so a bundle that knows about
   * `flushFrameSegment` can run on an engine without it. Returning null is the right degradation
   * — vitals go quiet, nothing else is affected — but done silently it makes a stale binary look
   * like a dead feature, because every other native signal still works.
   *
   * The condition is actionable in one sentence — rebuild the app — so it says so.
   */
  it("warns when the installed binary predates the method, instead of going quiet", async () => {
    // A FRESH module instance: the warning is deliberately once-per-process, and the
    // resolves-null test above already consumes that budget. Re-importing makes this test
    // independent of the order the file happens to run in, rather than of a reset hook that
    // would exist only for tests.
    vi.resetModules();
    const { flushFrameSegment: flushFresh } = await import("./native-bridge");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `flushFrameSegment` deliberately absent, as on a binary without it.
    const { flushFrameSegment: _absent, ...withoutFlush } = stubModule();
    const old = withoutFlush as unknown as GroundcoverNativeModule;

    await expect(flushFresh(old)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    // Names the cause and the fix, not just the symptom.
    expect(message).toContain("rebuild");
    expect(message).toContain("groundcoverIgnore");

    // Once per process, not once per screen change: this runs on EVERY navigation, so a
    // per-call warning would bury the app's own logs on a stale build.
    await expect(flushFresh(old)).resolves.toBeNull();
    await expect(flushFresh(old)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The type has to admit what the runtime guard admits: `isFrameSegment` is a predicate
 * but checks only `typeof reason === "string"`, so naming three literals would make the
 * narrowing a lie. These compile-time assertions fail to COMPILE if either union is
 * narrowed back to the three known values.
 */
const FORWARD_BRIDGE_REASON: NativeFrameSegment["reason"] = "timeout";
const FORWARD_WIRE_REASON: FrameVitalsEventAttributes["performance_segment_reason"] = "timeout";

describe("frame segment reason typing", () => {
  it("admits a reason a newer binary might send", () => {
    // Reading them keeps `noUnusedLocals` happy; the assertion is the annotation.
    expect([FORWARD_BRIDGE_REASON, FORWARD_WIRE_REASON]).toEqual(["timeout", "timeout"]);
  });
});

describe("subscribeNativeSignals", () => {
  it("dispatches a known signal", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "hang",
      payload: { kind: "anr", startedAtMs: 1, durationMs: 5200 },
    });

    expect(handler).toHaveBeenCalledWith({
      kind: "hang",
      payload: { kind: "anr", startedAtMs: 1, durationMs: 5200 },
    });
  });

  /**
   * The twin of "still rejects a segment whose reason is missing or not a string" on the PULL
   * path. Frame segments arrive both ways — pulled on a screen change, pushed on the
   * background and the safety cap — and this file's own comment says both directions hand the
   * same payload type to the same consumer. `isFrameSegment` requires `reason` to be a string,
   * so the push path must too, or a `reason: 7` would cross one way and not the other.
   */
  it("rejects a pushed segment whose reason is missing or not a string", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    const complete = {
      segmentStartMs: 1,
      segmentEndMs: 2,
      total: 120,
      slow: 12,
      frozen: 1,
      refreshRate: 60,
    };

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "frame_segment",
      payload: { ...complete, reason: 7 },
    });
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "frame_segment", payload: complete });

    expect(handler).not.toHaveBeenCalled();

    // And the forward-compatible case still passes, same as on the pull path: an unrecognised
    // LABEL is valid telemetry, and dropping the segment would discard six real measurements
    // over one string.
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "frame_segment",
      payload: { ...complete, reason: "a_reason_this_build_predates" },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({
      kind: "frame_segment",
      payload: { ...complete, reason: "a_reason_this_build_predates" },
    });
  });

  it("ignores an unknown kind — an OTA JS bundle can be older than the binary", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "future_signal", payload: {} });

    expect(handler).not.toHaveBeenCalled();
  });

  const GESTURE = {
    kind: "swipe",
    startedAtMs: 10,
    endedAtMs: 120,
    startX: 5,
    startY: 5,
    endX: 200,
    endY: 5,
    direction: "right",
    distanceDp: 195,
    velocityDpS: 1772,
    pointerCount: 1,
  };

  it("dispatches a well-formed gesture", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "gesture", payload: GESTURE });

    expect(handler).toHaveBeenCalledWith({ kind: "gesture", payload: GESTURE });
  });

  /**
   * Kind-level skew is guarded above; FIELD-level skew is the same hazard.
   * A native engine a release ahead can rename a field, and `Math.round(undefined)` is
   * NaN, which `JSON.stringify` writes as `null` — so `distance_dp` would reach ingest as a
   * null where the schema promises a number. Dropped, not coerced, unlike a crash
   * record: gestures are interchangeable, and a zero-filled one asserts a movement the
   * user never made.
   */
  it("drops a gesture whose numeric fields did not survive version skew", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    const { distanceDp: _dropped, ...renamedByNewerNative } = GESTURE;
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "gesture",
      payload: { ...renamedByNewerNative, distance_dp: 195 },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("drops a gesture whose numerics arrived as strings", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "gesture",
      payload: { ...GESTURE, velocityDpS: "1772" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  /** Every kind with numerics on the wire, not only gestures: a frame segment
   *  missing its counts charts the same nulls. */
  it("drops a frame segment missing its counts", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "frame_segment",
      payload: { segmentStartMs: 1, segmentEndMs: 2, total: 60, slow: 3 },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  /** A payload with no numerics at all is still perfectly valid. */
  it("dispatches a kind that carries no numeric fields", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "gestures_attached", payload: {} });

    expect(handler).toHaveBeenCalledWith({ kind: "gestures_attached", payload: {} });
  });

  it("contains a throwing handler so the emitter callback never propagates", () => {
    const mod = stubModule();
    subscribeNativeSignals(mod, () => {
      throw new Error("listener blew up");
    });

    expect(() =>
      __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "ping", payload: {} })
    ).not.toThrow();
  });

  it("removes the subscription so a re-init cannot double-deliver", () => {
    const mod = stubModule();
    const subscription = subscribeNativeSignals(mod, vi.fn());
    expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);

    subscription?.remove();

    expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(0);
  });

  it("strips a non-finite optional metric from a PUSHED segment, without dropping it", () => {
    // The push and pull paths deliver the same payload type to the same consumer, and a frame
    // segment arrives both ways — pulled on a screen change, pushed on the background and
    // safety caps. `delayMs`/`budgetMs` are absent from NUMERIC_PAYLOAD_FIELDS because they
    // are optional, so that table cannot validate them: unchecked, a null or Infinity would reach
    // a handler whose type says `number`. Cleaning on only one path would be worse than neither,
    // since the consumer could not tell which path a bad value survived.
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    const segment = {
      segmentStartMs: 1_000,
      segmentEndMs: 2_000,
      total: 60,
      slow: 1,
      frozen: 0,
      refreshRate: 60,
      reason: "background",
    };

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "frame_segment",
      payload: { ...segment, delayMs: null, budgetMs: 16.7 },
    });

    // Delivered, not dropped — one spoiled metric must not cost the counts, the refresh rate
    // and both timestamps.
    expect(handler).toHaveBeenCalledTimes(1);
    const delivered = handler.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(delivered.payload).not.toHaveProperty("delayMs");
    expect(delivered.payload.budgetMs).toBe(16.7);
    expect(delivered.payload.total).toBe(60);
  });

  it("strips a non-finite budget on the PULL path, keeping the rest of the segment", async () => {
    // `budgetMs` sits in the optional table beside `delayMs`; outside it, it would bypass this
    // validation entirely and an Infinity would reach the transporter, where JSON.stringify
    // renders it as `null` — a field that reads as "native sent nothing" while native in fact
    // sent garbage. Same JSON-text splice as the delayMs case above, and for the
    // same two reasons.
    const mod = stubModule({
      flushFrameSegment: vi.fn().mockResolvedValue(
        JSON.stringify({ ...SEGMENT, delayMs: 12 }).replace(/}$/, ',"budgetMs":1e999}')
      ),
    });

    const segment = await flushFrameSegment(mod);

    expect(segment).not.toBeNull();
    expect(segment).not.toHaveProperty("budgetMs");
    expect(segment?.delayMs).toBe(12);
    expect(segment?.total).toBe(SEGMENT.total);
  });

  it("strips a non-finite budget on the PUSH path too — both directions must agree", () => {
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "frame_segment",
      payload: { ...SEGMENT, delayMs: 12, budgetMs: Number.POSITIVE_INFINITY },
    });

    const delivered = handler.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(delivered.payload).not.toHaveProperty("budgetMs");
    expect(delivered.payload.delayMs).toBe(12);
  });

  it("leaves a pushed segment untouched when its optional metrics are fine", () => {
    // The cleanup copies only when it has to, so this also pins that a healthy segment is
    // forwarded as-is rather than reconstructed.
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    const payload = {
      segmentStartMs: 1_000,
      segmentEndMs: 2_000,
      total: 60,
      slow: 1,
      frozen: 0,
      refreshRate: 60,
      reason: "navigation",
      delayMs: 120,
      budgetMs: 16.7,
    };

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "frame_segment", payload });

    expect(handler).toHaveBeenCalledWith({ kind: "frame_segment", payload });
  });

  it("drops an ARRAY payload, which passes a bare typeof check", () => {
    // `typeof [] === "object"`, and an array satisfies the numeric-field test for the two
    // zero-field kinds vacuously — so it would reach a handler whose payload type is
    // `Record<string, never>`. For any other kind, the field reads that handler performs
    // would all come back undefined.
    const mod = stubModule();
    const handler = vi.fn();
    subscribeNativeSignals(mod, handler);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "ping", payload: [] });
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "gestures_attached", payload: [] });

    expect(handler).not.toHaveBeenCalled();
  });
});
