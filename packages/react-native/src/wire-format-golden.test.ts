import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, strFromU8 } from "fflate";
import { SafeStorage, type Batch, type BaseEvent, type PlatformStorage } from "@groundcover/rum-core";
// The module object, not a named import: compiled JSX reads `jsx` off it at call
// time, which is the read the SDK's patch is installed on.
import JsxRuntime from "react/jsx-runtime";

import { RNSessionManager } from "./session-manager/session-manager";
import type { SDKConfigInput } from "./config/types";
import type { RNEventType } from "./events/rn-event-types";
import type { RawGesture } from "./internal/touch-bridge";
import { EMPTY_WALK, walkFiber } from "./react/fiber-walk";
// Imported by PATH, not through the "react-native" specifier: vitest aliases
// that specifier to this very file, so both resolve to the same module instance,
// but `tsc` resolves it to the real RN types — under which the stub's test-only
// exports are invisible and `TextInput` is not the plain function the stub models.
import ReactNativeModule, {
  __emitNativeSignal,
  __reset as resetRN,
  __setNativeModule,
} from "./test-utils/react-native-stub";
import { NATIVE_EVENT_CHANNEL, NATIVE_MODULE_NAME } from "./platform/native-types";

// ---------------------------------------------------------------------------
// GOLDEN WIRE-FORMAT SUITE (React Native)
//
// Characterization tests for the exact payload the backend ingests at
// {dsn}/json/rum from the RN SDK. A break here is a backend-visible
// regression, not a test to update casually.
//
// What every SDK shares has two parts. The requests: each file in
// packages/core/wire is the one request a call sends, exactly, and
// "shared wire fixtures" below checks this SDK sends it. The behaviour: the
// presence gate, sampling, session identity and rotation ordering, as plain
// tests every SDK's golden repeats (the fixtures' README lists them). What only
// RN sends — source/os/device, `interaction` and its gestures, the screen stamp,
// performance segments, the native crash batch, the fiber guard, the
// transport's abort and throw handling — stays inline too.
// ---------------------------------------------------------------------------

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const TRACE_ID = /^0{16}[0-9a-f]{16}$/;

const FIXTURE_DIR = join(__dirname, "../../core/wire");
const fixture = (file: string): unknown => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));

// wire/config.json, shared with every golden: a bare-host dsn (pins the
// getEndpoint() https:// upgrade) and batchSize 0, so every flushing event sends.
const BASE_CONFIG = fixture("config.json") as SDKConfigInput;

// The clock the fixture files were sent on (2027-01-15T08:00:00Z), so their times are exact.
const FIXTURE_CLOCK_MS = 1_800_000_000_000;

const without = (object: object, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

type FetchCall = { url: string; headers: Record<string, string>; body: Uint8Array };

function makeStorage(): SafeStorage {
  const map = new Map<string, string>();
  const backing: PlatformStorage = {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return new SafeStorage(backing);
}

function recordedCalls(fetchMock: ReturnType<typeof vi.fn>): FetchCall[] {
  return fetchMock.mock.calls.map((call) => {
    const [url, init] = call as [string, { headers: Record<string, string>; body: Uint8Array }];
    return { url, headers: init.headers, body: init.body };
  });
}

function decodeBody(call: FetchCall): Batch {
  const bytes = call.headers["Content-Encoding"] === "gzip" ? gunzipSync(call.body) : call.body;
  return JSON.parse(strFromU8(bytes)) as Batch;
}

// Typed over the RN event union so a misspelled kind in a comparison is a type
// error — core's Batch leaves the event type an open string.
function allSentEvents(fetchMock: ReturnType<typeof vi.fn>): BaseEvent<RNEventType>[] {
  return recordedCalls(fetchMock).flatMap(
    (call) => decodeBody(call).events
  ) as BaseEvent<RNEventType>[];
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

// A tap is a RawGesture with kind "tap"; the kinematic fields sit at the classifier's
// defaults and the builder omits the whole gesture block for one.
const tap = (over: Partial<RawGesture> = {}): RawGesture => ({
  kind: "tap",
  x: 100,
  y: 200,
  target: EMPTY_WALK,
  captureSource: "js",
  startedAtMs: 0,
  distanceDp: 0,
  durationMs: 0,
  velocityDpS: 0,
  pointerCount: 1,
  partial: false,
  ...over,
});

// Drive a real edit through the installed TextInput patch — create the element so the patch
// injects its handlers, then fire change → endEditing — exercising the full
// patch → reportInput → listener pipeline rather than a shortcut.
//
// Created through the JSX RUNTIME, read off the module object at call time, which is exactly what
// an app's compiled `<TextInput/>` does. The patch forwards the type untouched, so `element.type`
// is still TextInput; see text-input-instrumentation.ts for why changing it destroys the edit.
function typeInto(fiber: unknown): void {
  const jsx = (
    JsxRuntime as unknown as { jsx: (t: unknown, p: Record<string, unknown>) => unknown }
  ).jsx;
  const element = jsx(ReactNativeModule.TextInput, {}) as { props: Record<string, unknown> };
  const injected = element.props;
  const event = { _targetInst: fiber };
  (injected.onChange as (e: unknown) => void)(event);
  (injected.onEndEditing as (e: unknown) => void)(event);
}

describe("wire-format golden contract (react-native)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let manager: RNSessionManager | null = null;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    vi.unstubAllGlobals();
    // Clears the native-module registry too. In a HOOK rather than at the end of
    // the two tests that install a stub, because a failing assertion skips the
    // rest of a test body: one native test going red would otherwise hand the
    // stub to every test after it and bury the real failure under a cascade.
    // Also the pattern every sibling suite already uses.
    resetRN();
  });

  function initSDK(config: SDKConfigInput = BASE_CONFIG): RNSessionManager {
    manager = new RNSessionManager(config, makeStorage());
    return manager;
  }

  // The core envelope keys and their values are pinned by the shared wire
  // fixtures. This adds RN's own, and the EXACT key set (core + app, device, os,
  // source), so an extra key anywhere is caught.
  it("stamps the RN session envelope: source=mobile-rum + os + device", async () => {
    const sdk = initSDK();
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "e", attributes: {} });
    await drain();

    const attrs = decodeBody(recordedCalls(fetchMock)[0]!).sessionAttributes as Record<string, unknown>;
    expect(Object.keys(attrs).sort()).toEqual(
      [
        "app",
        "cluster",
        "device",
        "env",
        "namespace",
        "os",
        "releaseId",
        "service.name",
        "session_id",
        "session_start_time",
        "source",
        "user",
      ].sort()
    );
    expect(attrs.source).toBe("mobile-rum");
    expect(attrs.session_id).toEqual(expect.any(String));
    // Deployment coordinates from core.
    expect(attrs.cluster).toBe("golden-cluster");
    // Platform lives in os/device, NOT in source.
    const os = attrs.os as { name: string; version: string };
    expect(os.name).toBe("ios"); // stub defaults Platform.OS = "ios"
    expect(os.version).toEqual(expect.any(String));
    const device = attrs.device as { model: string; brand: string };
    expect(device.model).toEqual(expect.any(String));
    expect(device.brand).toEqual(expect.any(String));
    // Web-only fields must not appear.
    expect(attrs.userAgent).toBeUndefined();
    expect(attrs.browser).toBeUndefined();
  });

  it("emits a tap as an `interaction` event with the flattened wire shape", async () => {
    const sdk = initSDK();
    sdk.reportInteraction(tap({ x: 128, y: 440 }));
    // `interaction` is a skip-flush type (rides along like the browser's
    // dom.event), so a flushing event drains the batch that carries it.
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const interaction = allSentEvents(fetchMock).find((e) => e.type === "interaction");
    expect(interaction).toBeDefined();
    expect(interaction!.id).toEqual(expect.any(String));
    expect(interaction!.spanId).toMatch(HEX_16);
    expect(interaction!.traceId ?? "").toMatch(HEX_32);

    // Core flattens nested listener attributes — the WIRE carries dotted keys.
    const a = interaction!.attributes as Record<string, unknown>;
    expect(a["interaction_type"]).toBe("tap");
    expect(a["interaction_coordinates.x"]).toBe(128);
    expect(a["interaction_coordinates.y"]).toBe(440);
    expect(a).toHaveProperty("interaction_target.component");
    expect(a).toHaveProperty("interaction_target.label");
    expect(a).toHaveProperty("interaction_target.role");
    expect(a).toHaveProperty("interaction_target.hint");
    expect(a["interaction_target.test_id"]).toBeUndefined(); // not part of the target
    expect(a["interaction_touch_type"]).toBeUndefined(); // not on the wire
    expect(a).toHaveProperty("interaction_component_path");
    // Browser parity: only network events carry a span_name. An interaction's
    // identity is interaction_type + interaction_target.label.
    expect(interaction!.span_name).toBeUndefined();
  });

  it("masks a dataPrivate element's label even under the DEFAULT privacy level (per-element opt-out)", async () => {
    const sdk = initSDK(); // default privacy: mask-sensitive → labels normally NOT masked
    // Walked at the touch boundary, exactly as the provider does — the listener consumes the
    // walk and never re-walks, so `masked` has to survive the trip as a field on the payload.
    sdk.reportInteraction(
      tap({
        target: walkFiber({
          elementType: "Custom",
          memoizedProps: { dataPrivate: true, accessibilityLabel: "SSN 123-45-6789" },
          return: null,
        }),
      })
    );
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const interaction = allSentEvents(fetchMock).find((e) => e.type === "interaction");
    const a = interaction!.attributes as Record<string, unknown>;
    expect(a["interaction_target.label"]).toBe("***");
    expect(JSON.stringify(a)).not.toContain("123-45-6789");
  });

  it("emits a finished text edit as an `input` interaction — no value, no coordinates", async () => {
    const sdk = initSDK();
    // A labeled field (accessibilityLabel) that the user typed into and left.
    typeInto({
      elementType: "RCTTextInput",
      memoizedProps: {
        accessibilityLabel: "Email",
        accessibilityHint: "Enter your email",
        accessibilityState: { disabled: false },
        value: "secret@example.com",
      },
      return: null,
    });
    sdk.sendCustomEvent({ event: "flush", attributes: {} }); // drain the skip-flush batch
    await drain();

    const input = allSentEvents(fetchMock).find(
      (e) => e.type === "interaction" && (e.attributes as Record<string, unknown>)["interaction_type"] === "input"
    );
    expect(input).toBeDefined();

    const a = input!.attributes as Record<string, unknown>;
    expect(a["interaction_type"]).toBe("input");
    // The field is labeled from its accessibilityLabel, and the enriched target
    // carries hint + state (structural, never the typed value) via the fiber walk.
    expect(a["interaction_target.label"]).toBe("Email");
    expect(a["interaction_target.hint"]).toBe("Enter your email");
    expect(a["interaction_target.state.disabled"]).toBe(false);
    expect(a).toHaveProperty("interaction_target.component");
    expect(a).toHaveProperty("interaction_component_path");
    expect(input!.span_name).toBeUndefined();

    // Privacy + shape contract: the typed VALUE never appears anywhere on the
    // event; input events carry no tap-only coordinates and no test_id.
    expect(JSON.stringify(a)).not.toContain("secret@example.com");
    expect(a).not.toHaveProperty("interaction_coordinates.x");
    expect(a["interaction_touch_type"]).toBeUndefined();
    expect(a["interaction_target.test_id"]).toBeUndefined();
  });

  it("stamps the current screen on events after navigation", async () => {
    const sdk = initSDK();
    sdk.reportInteraction(tap());
    sdk.startNavigation({ screen: "Checkout" });
    sdk.endNavigation({ screen: "Checkout" });
    sdk.sendCustomEvent({ event: "on-checkout", attributes: {} });
    await drain();

    const events = allSentEvents(fetchMock);
    const navigation = events.find((e) => e.type === "navigation");
    expect(navigation).toBeDefined();

    // The navigation event identifies its screen through the SAME ambient block as every
    // other event, and ONLY through it. Carrying `screen_name`/`screen_key` as well, set by the
    // tracker while the enricher stamps `screen`, would mean two writers and four keys on the
    // wire for two values. `screen.*` is the cross-event convention, so it is the only one.
    const navAttrs = navigation!.attributes as Record<string, unknown>;
    expect(navAttrs.screen).toEqual({ name: "Checkout", key: "" });
    expect(navAttrs).not.toHaveProperty("screen_name");
    expect(navAttrs).not.toHaveProperty("screen_key");
    // `from_screen`/`from_key` are NOT part of that dedup — they describe the screen being LEFT,
    // which the ambient block cannot express because the holder has already moved on. Absent here
    // only because this drives the MANUAL api, which has no origin screen; the auto path's
    // from_screen is covered in navigation-tracker.test.ts.
    expect(navAttrs).not.toHaveProperty("from_screen");

    const custom = events.find(
      (e) => e.type === "custom" && e.attributes?.custom_event_name === "on-checkout"
    );
    expect(custom).toBeDefined();
    // The ambient screen block identifies the screen by name + key (per-instance
    // route id), never a URL/path. It rides on every event as a NESTED object —
    // `screen` is the sole nested attribute on an otherwise fully dot-flattened
    // payload, because enrichAttributes is merged AFTER formatEventObject. Pin
    // the nested shape precisely (toHaveProperty("screen.name") reads the dot as
    // a path and would pass for the flat key too, so it can't tell them apart).
    expect((custom!.attributes as Record<string, unknown>).screen).toEqual({
      name: "Checkout",
      key: "",
    });
    // Array form = a single LITERAL key: the wire must NOT carry a flattened
    // "screen.name"/"screen.key", and never a URL/path.
    expect(custom!.attributes).not.toHaveProperty(["screen.name"]);
    expect(custom!.attributes).not.toHaveProperty(["screen.key"]);
    expect(custom!.attributes).not.toHaveProperty(["screen.path"]);
  });

  it("reserves the stamped `screen` key on logs, and only that key", async () => {
    const sdk = initSDK();
    sdk.reportInteraction(tap());
    sdk.startNavigation({ screen: "Checkout" });
    sdk.endNavigation({ screen: "Checkout" });
    sdk.emitLog("user log", "info", {
      screen: { name: "spoofed", extra: 1 },
      location: "warehouse-7",
    });
    await drain();

    const log = allSentEvents(fetchMock).find((e) => e.type === "log");
    expect(log).toBeDefined();
    const a = log!.attributes as Record<string, unknown>;
    // A user `screen` can neither override the SDK's stamp nor leak alongside it
    // as flattened `screen.*` keys.
    expect(a.screen).toEqual({ name: "Checkout", key: "" });
    expect(a).not.toHaveProperty(["screen.name"]);
    expect(a).not.toHaveProperty(["screen.extra"]);
    // `location` is not an RN-stamped key, so it is ordinary user data here.
    expect(a.location).toBe("warehouse-7");
  });

  it("never walks a React fiber passed as an attribute (enrichment or redaction)", async () => {
    // A cyclic fiber pair: without the opaque-node guard, flattening walks it
    // until the depth cap and ships dozens of fiber-internal keys.
    class FiberNode {
      tag = 5;
      return: unknown = null;
      alternate: unknown = null;
      stateNode = {};
      memoizedProps = { secretProp: "hunter2" };
    }
    const fiber = new FiberNode();
    const alternate = new FiberNode();
    fiber.alternate = alternate;
    alternate.alternate = fiber;

    const sdk = initSDK();
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "fiber-probe", attributes: { node: fiber } });
    sdk.captureException(new Error("with fiber"), { node: fiber });
    await drain();

    const events = allSentEvents(fetchMock);
    const custom = events.find((e) => e.type === "custom")!;
    expect(custom.attributes?.["custom_event_attributes.node"]).toBe("[FiberNode]");
    const leaked = (e: BaseEvent<RNEventType>) =>
      Object.keys(e.attributes ?? {}).filter((k) => k.includes("memoizedProps"));
    expect(leaked(custom)).toEqual([]);
    // Error masking is on by default, so metadata meets redaction first.
    const exception = events.find((e) => e.type === "exception")!;
    expect(exception.attributes?.["error_metadata.node"]).toBe("[REDACTED]");
    expect(leaked(exception)).toEqual([]);
  });

  it("hands beforeSend/enrichEvent the DOT-FLATTENED attributes the callback type declares", async () => {
    // The declared RN callback type (CallbackEvent) must match what the pipeline
    // actually passes: core's enricher flattens nested attribute objects BEFORE
    // beforeSend/enrichEvent run. A type that claimed the nested build shape would
    // let a type-correct filter (`e.attributes.interaction_target.label`) throw
    // and silently drop every event. This pins the observed shape.
    let observed: Record<string, unknown> | undefined;
    const sdk = initSDK({
      ...BASE_CONFIG,
      options: {
        ...BASE_CONFIG.options,
        beforeSend: (e) => {
          if (e.type === "interaction") {
            observed = e.attributes;
            // Type-honesty guard (enforced by `tsc -p tsconfig.tests.json`): flat
            // bracket access compiles; the nested build-shape access does not.
            void e.attributes["interaction_target.label"];
            // @ts-expect-error runtime attributes are flat — nested access is not on the type.
            void e.attributes.interaction_target?.label;
          }
          return true;
        },
      },
    });
    sdk.reportInteraction(tap());
    await drain();

    expect(observed).toBeDefined();
    const attrs = observed as Record<string, unknown>;
    // Flattened keys are what the callback sees...
    expect(attrs["interaction_type"]).toBe("tap");
    const keys = Object.keys(attrs);
    expect(keys).toContain("interaction_target.label");
    expect(keys).toContain("interaction_target.component");
    expect(keys).toContain("interaction_coordinates.x");
    expect(keys).toContain("interaction_component_path");
    // ...and the nested build shape is NOT present at runtime.
    expect(attrs["interaction_target"]).toBeUndefined();
    expect(attrs["interaction_coordinates"]).toBeUndefined();
    // `screen` is the sole nested block (enrichAttributes merged after flatten).
    expect(attrs.screen).toEqual({ name: expect.any(String), key: expect.any(String) });
  });

  it("attaches an AbortSignal to the batch fetch (network timeout guard)", async () => {
    const sdk = initSDK();
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "e", attributes: {} });
    await drain();

    const call = fetchMock.mock.calls[0] as [string, { signal?: unknown }];
    expect(call).toBeDefined();
    const init = call[1];
    // A stalled connection must not hang forever — sendBatch bounds it via an
    // AbortController.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("contains a synchronously-throwing fetch in sendBatch (no crash / unhandled rejection)", async () => {
    const throwingFetch = vi.fn(() => {
      throw new TypeError("fetch is not a function");
    });
    vi.stubGlobal("fetch", throwingFetch);

    const sdk = initSDK();
    sdk.reportInteraction(tap()); // presence opens the send gate
    expect(() => sdk.sendCustomEvent({ event: "e", attributes: {} })).not.toThrow();
    await drain();

    // sendBatch surfaced the sync throw as a handled rejection (no crash), and
    // the flush still attempted delivery.
    expect(throwingFetch).toHaveBeenCalled();
  });

  it("emits a swipe as an `interaction` with the flattened gesture shape", async () => {
    const sdk = initSDK();
    sdk.reportInteraction({
      x: 320,
      y: 512,
      target: EMPTY_WALK,
      captureSource: "js",
      kind: "swipe",
      direction: "left",
      distanceDp: 184,
      durationMs: 210,
      velocityDpS: 876,
      pointerCount: 1,
      partial: false,
      startedAtMs: Date.now(),
    });
    // `interaction` is a skip-flush type, so a flushing event drains the batch.
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const swipe = allSentEvents(fetchMock).find(
      (e) =>
        e.type === "interaction" &&
        (e.attributes as Record<string, unknown>)["interaction_type"] === "swipe"
    );
    expect(swipe).toBeDefined();
    expect(swipe!.span_name).toBeUndefined();

    const a = swipe!.attributes as Record<string, unknown>;
    // Where the finger LANDED — that identifies the element, not where it lifted.
    expect(a["interaction_coordinates.x"]).toBe(320);
    expect(a["interaction_coordinates.y"]).toBe(512);
    expect(a["interaction_gesture.direction"]).toBe("left");
    expect(a["interaction_gesture.distance_dp"]).toBe(184);
    expect(a["interaction_gesture.velocity_dp_s"]).toBe(876);
    expect(a["interaction_gesture.duration_ms"]).toBe(210);
    expect(a["interaction_gesture.pointer_count"]).toBe(1);
    expect(a["interaction_gesture.capture_source"]).toBe("js");
    // Absent unless the stream was actually cut short.
    expect(a["interaction_gesture.partial"]).toBeUndefined();
    expect(a).toHaveProperty("interaction_target.label");
    expect(a).toHaveProperty("interaction_component_path");
  });

  it("marks a cancelled Android scroll as partial on the wire", async () => {
    const sdk = initSDK();
    sdk.reportInteraction({
      x: 200,
      y: 400,
      target: EMPTY_WALK,
      captureSource: "js",
      kind: "scroll",
      direction: "down",
      distanceDp: 60,
      durationMs: 90,
      velocityDpS: 666,
      pointerCount: 1,
      partial: true,
      startedAtMs: Date.now(),
    });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const scroll = allSentEvents(fetchMock).find(
      (e) =>
        e.type === "interaction" &&
        (e.attributes as Record<string, unknown>)["interaction_type"] === "scroll"
    );
    const a = scroll!.attributes as Record<string, unknown>;
    // Tells a consumer these kinematics are lower bounds, not measurements.
    expect(a["interaction_gesture.partial"]).toBe(true);
  });

  it("emits a native performance metric with the flattened wire shape", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, {
      nativeInit: vi
        .fn()
        .mockResolvedValue(
          '{"crashes":true,"hangs":true,"appStart":true,"vitals":true,"gestures":true}'
        ),
      updateSessionSnapshot: vi.fn(),
      getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
      clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
      flushFrameSegment: vi.fn().mockResolvedValue("null"),
      stop: vi.fn(),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    });

    const sdk = initSDK();
    sdk.reportInteraction(tap()); // presence opens the send gate
    await drain();

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "frame_segment",
      payload: {
        segmentStartMs: 1_700_000_000_000,
        segmentEndMs: 1_700_000_005_000,
        total: 300,
        slow: 30,
        frozen: 3,
        refreshRate: 60,
        delayMs: 240,
        maxFrameMs: 250,
        // Deliberately NOT 1000/refreshRate: on an adaptive panel iOS judges against the cadence
        // the display is really running at, which is the whole reason this ships separately.
        budgetMs: 16.666,
        reason: "navigation",
      },
    });
    // `performance` is a skip-flush type, so a flushing event drains the batch.
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const slow = allSentEvents(fetchMock).find(
      (e) =>
        e.type === "performance" &&
        (e.attributes as Record<string, unknown>)["performance_metric_name"] ===
          "frames_delay_total"
    );
    expect(slow).toBeDefined();
    // The segment's END, not the emit time — the enricher honours an explicit
    // timestamp, and a segment is a past interval rather than an instant.
    expect(slow!.timestamp).toBe(1_700_000_005_000 * 1e6);
    // Browser parity: only network events carry a span_name.
    expect(slow!.span_name).toBeUndefined();

    const a = slow!.attributes as Record<string, unknown>;
    // MILLISECONDS lost, absolute — not a fraction of anything. A rate would need a frame-count
    // denominator, and iOS and Android do not count the same frames.
    expect(a["performance_metric_value"]).toBe(240);
    expect(a["performance_metric_id"]).toEqual(expect.any(String));
    expect(a["performance_metric_navigation_type"]).toBe("");

    // THE COUNTS. A rate alone cannot be aggregated downstream: summing or
    // averaging rates across segments of different lengths is wrong, and there is
    // no way to correct it after the fact. Pinned here because these keys are the
    // reason a consumer can compute anything at all.
    // `performance_frames_total` is not on the wire: it counts display refreshes on iOS and
    // real draws on Android, so it is not the same quantity across platforms. slow/frozen ship.
    expect(a).not.toHaveProperty("performance_frames_total");
    expect(a["performance_frames_slow"]).toBe(30);
    expect(a["performance_frames_frozen"]).toBe(3);
    // The panel's nominal rate — device-dependent, so a consumer
    // comparing two devices needs it.
    expect(a["performance_refresh_rate_hz"]).toBe(60);
    // The budget `slow` and `delayMs` were ACTUALLY judged against, which
    // `performance_refresh_rate_hz` does not determine: 1000/60 is 16.67 here by coincidence of the
    // fixture, but on a ProMotion panel the nominal rate implies 8.33 while the budget is ~16.7.
    // Pinned in the golden test and not only in the listener unit, because a flattening change
    // elsewhere can drop this field, and the listener unit cannot see one.
    expect(a["performance_frame_budget_ms"]).toBe(16.67);

    // NANOSECONDS, reusing the exact key names RN `navigation` events ship, so
    // a consumer can intersect a segment with the navigations around it with no
    // unit conversion and no name mapping. The native payload is in ms, so the
    // products are pinned rather than just the ordering: a missing msToNs is the
    // obvious bug and an ordering check cannot see it.
    expect(a["start_timestamp"]).toBe(1_700_000_000_000 * 1e6);
    expect(a["end_timestamp"]).toBe(1_700_000_005_000 * 1e6);

    // Which of the three triggers closed it. Lets a consumer sum consecutive
    // `safety` segments up to a `navigation`/`background` one and recover a whole
    // screen's total.
    expect(a["performance_segment_reason"]).toBe("navigation");

    // No `duration_ms`: it is end − start, and this payload carries enough
    // redundancy already.
    expect(a["performance_segment_duration_ms"]).toBeUndefined();

    // The platform screen stamp stays NESTED. Empty here because this test never
    // navigates — the per-screen attribution itself is covered in
    // vitals-listener.test.ts and on device.
    expect(a["screen"]).toEqual({ name: "", key: "" });

    // And that is the WHOLE segment: ONE event, not two. No second event rides alongside this one
    // carrying a refresh-rate minimum over the same bounds and reason: such a value comes from a
    // SINGLE frame — the worst non-frozen one — so identical jank reads differently depending on
    // how long the segment happened to run.
    //
    // Pinned as exactly one event per segment: nothing else here would notice a second one, and it
    // would double every consumer's vitals volume while carrying a metric that is not part of the
    // wire.
    const performanceEvents = allSentEvents(fetchMock).filter((e) => e.type === "performance");
    expect(
      performanceEvents.map(
        (e) => (e.attributes as Record<string, unknown>)["performance_metric_name"]
      )
    ).toEqual(["frames_delay_total"]);
  });

  // The whole point of the per-screen model, pinned end to end: a segment closed
  // by a navigation reaches the wire stamped with the screen being LEFT.
  //
  // Worth pinning HERE rather than only at the listener, because the failure is
  // structural: `enrichAttributes` is merged after flattening, so the ambient
  // screen wins over anything the listener passes in. Every layer between the
  // pull and the wire has to cooperate for this to hold.
  it("attributes a navigation-closed frame segment to the OUTGOING screen", async () => {
    const flushFrameSegment = vi.fn().mockResolvedValue(
      JSON.stringify({
        segmentStartMs: 1_700_000_000_000,
        segmentEndMs: 1_700_000_004_000,
        total: 240,
        slow: 24,
        frozen: 0,
        refreshRate: 60,
        delayMs: 192,
        maxFrameMs: 120,
        reason: "navigation",
      })
    );
    __setNativeModule(NATIVE_MODULE_NAME, {
      nativeInit: vi
        .fn()
        .mockResolvedValue(
          '{"crashes":true,"hangs":true,"appStart":true,"vitals":true,"gestures":true}'
        ),
      updateSessionSnapshot: vi.fn(),
      getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
      clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
      flushFrameSegment,
      stop: vi.fn(),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    });

    const sdk = initSDK();
    sdk.reportInteraction(tap()); // presence opens the send gate
    // First screen: nothing to attribute yet, so no pull.
    sdk.startNavigation({ screen: "Feed" });
    await drain();
    expect(flushFrameSegment).not.toHaveBeenCalled();

    // Leave Feed. THIS is the pull.
    sdk.startNavigation({ screen: "Checkout" });
    await drain();
    expect(flushFrameSegment).toHaveBeenCalledTimes(1);

    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    // Named explicitly rather than matched on a pattern, so no other vitals metric can pass
    // for this one.
    const metricNameOf = (e: { attributes?: unknown }): string =>
      String((e.attributes as Record<string, unknown> | undefined)?.["performance_metric_name"] ?? "");
    const sent = allSentEvents(fetchMock).filter((e) => e.type === "performance");
    const vitals = sent.filter((e) => metricNameOf(e) === "frames_delay_total");
    expect(vitals).toHaveLength(1);
    // And none of these non-contract metric names may appear on the wire; any of them would
    // double the vitals volume per segment.
    expect(
      sent
        .map(metricNameOf)
        .filter((n) =>
          [
            "slow_frames_rate",
            "frozen_frames_rate",
            "refresh_rate_average",
            "refresh_rate_min",
          ].includes(n)
        )
    ).toEqual([]);
    for (const event of vitals) {
      const a = event.attributes as Record<string, unknown>;
      // Feed, not Checkout. The frames were drawn on Feed; the app is on Checkout
      // by the time the segment is composed.
      expect(a["screen"]).toEqual({ name: "Feed", key: "" });
      expect(a["performance_segment_reason"]).toBe("navigation");
      // `performance_frames_total` is off the wire: it counts display refreshes on iOS and real
      // draws on Android, so it is not the same quantity across platforms.
      expect(a).not.toHaveProperty("performance_frames_total");
      expect(a["performance_frames_slow"]).toBe(24);
    }
  });

  it("does not transmit anything before genuine presence (ghost-session gate)", async () => {
    const sdk = initSDK();
    sdk.sendCustomEvent({ event: "pre-presence", attributes: {} });
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();

    // A tap is presence — it opens the send gate.
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "post-presence", attributes: {} });
    await drain();

    expect(fetchMock).toHaveBeenCalled();
    const names = allSentEvents(fetchMock)
      .filter((e) => e.type === "custom")
      .map((e) => e.attributes?.custom_event_name);
    expect(names).toContain("pre-presence");
    expect(names).toContain("post-presence");
  });

  it("sends nothing when sessionSampleRate is 0", async () => {
    const sdk = initSDK({
      ...BASE_CONFIG,
      options: { ...BASE_CONFIG.options, sessionSampleRate: 0 },
    });
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "e", attributes: {} });
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps session identity stable across flushes within a session", async () => {
    const sdk = initSDK();
    sdk.reportInteraction(tap());

    sdk.sendCustomEvent({ event: "first", attributes: {} });
    await drain();
    sdk.sendCustomEvent({ event: "second", attributes: {} });
    await drain();

    const calls = recordedCalls(fetchMock);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const ids = calls.map((c) => decodeBody(c).sessionAttributes.session_id);
    expect(new Set(ids).size).toBe(1);
    expect(sdk.getSessionId()).toBe(ids[0]);
  });

  // The downstream contract, not an implementation detail: consumers derive
  // session duration from last event − session_start_time, so an envelope
  // claiming a start LATER than an event it carries produces an end before the
  // start and a negative duration. Deliberately scenario-independent — it walks
  // whatever this suite already sent, so it keeps holding as scenarios grow.
  // Batches are per-call here, so iterate calls rather than flattening.
  it("never claims a session started after an event in the same batch", async () => {
    const sdk = initSDK();
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "first", attributes: {} });
    await drain();
    sdk.sendCustomEvent({ event: "second", attributes: {} });
    await drain();

    const calls = recordedCalls(fetchMock);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    for (const call of calls) {
      const { sessionAttributes, events } = decodeBody(call);
      // network events carry start_timestamp instead of timestamp.
      const times = events
        .map((event) => event.timestamp ?? event.start_timestamp)
        .filter((time): time is number => typeof time === "number");
      expect(times.length).toBeGreaterThan(0);
      expect(sessionAttributes.session_start_time).toBeLessThanOrEqual(Math.min(...times));
    }
  });

  // The test above holds trivially in a fresh session, because bootstrap stamps
  // the start before any event exists. This one crosses the max-duration cap so
  // a real ROTATION mints the start, which is where an inversion can arise — and
  // it forces the interleave that would invert it.
  //
  // The clock is a Date.now spy (not fake timers, which the async encode path
  // needs). `beforeSend` runs inside addEvent BEFORE the rotation hook, so
  // advancing the clock there reproduces real work in between: the enricher
  // stamps the event from one reading, the rotation stamps the session from a
  // later one.
  it("never claims a rotated session started after the event that triggered it", async () => {
    const SESSION_MAX_DURATION_MS = 60_000;
    const base = Date.now();
    let clock = base;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      let advanceOnSend = false;
      const sdk = initSDK({
        ...BASE_CONFIG,
        options: {
          ...BASE_CONFIG.options,
          sessionMaxDuration: SESSION_MAX_DURATION_MS,
          // The interleave: real elapsed time between the enricher's stamp and
          // the rotation's stamp.
          beforeSend: () => {
            if (advanceOnSend) clock += 5;
            return true;
          },
        },
      });
      sdk.reportInteraction(tap());

      sdk.sendCustomEvent({ event: "before-cap", attributes: {} });
      await drain();
      const sessionIdBefore = recordedCalls(fetchMock)
        .map((c) => decodeBody(c).sessionAttributes.session_id)
        .at(-1);
      expect(sessionIdBefore).toBeTruthy();

      // Past the cap. Rotation is lazy — the next event triggers it.
      clock = base + SESSION_MAX_DURATION_MS + 1_000;
      advanceOnSend = true;
      sdk.sendCustomEvent({ event: "after-cap", attributes: {} });
      advanceOnSend = false;
      await drain();

      // The rotation reset the activity clock, so the new session is born
      // unconfirmed and the ghost-session gate holds its batch. Confirm it, then
      // give the pool a reason to drain.
      sdk.reportInteraction(tap());
      sdk.sendCustomEvent({ event: "post-rotation", attributes: {} });
      await drain();

      const rotated = recordedCalls(fetchMock)
        .map(decodeBody)
        .filter((b) => b.sessionAttributes.session_id !== sessionIdBefore);
      expect(rotated.length, "the cap should have rotated the session").toBeGreaterThan(0);

      for (const { sessionAttributes, events } of rotated) {
        const times = events
          .map((event) => event.timestamp ?? event.start_timestamp)
          .filter((time): time is number => typeof time === "number");
        expect(times.length).toBeGreaterThan(0);
        expect(
          sessionAttributes.session_start_time,
          "the rotated session started after an event it carries"
        ).toBeLessThanOrEqual(Math.min(...times));
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  // The resolver reads the triggering event BEFORE
  // the public `enrichEvent` hook runs, and it is enrichEvent's RESULT that
  // enters the buffer. So a hook that moves the timestamp earlier — a supported
  // transformation — must not defeat the ordering guarantee.
  it("never claims a rotated session started after an enrichEvent-backdated trigger", async () => {
    const SESSION_MAX_DURATION_MS = 60_000;
    const base = Date.now();
    let clock = base;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      let backdate = false;
      const sdk = initSDK({
        ...BASE_CONFIG,
        options: {
          ...BASE_CONFIG.options,
          sessionMaxDuration: SESSION_MAX_DURATION_MS,
          enrichEvent: ((event: BaseEvent) => {
            if (!backdate || typeof event.timestamp !== "number") return event;
            return { ...event, timestamp: event.timestamp - 5 * 1_000_000 };
          }) as unknown as NonNullable<SDKConfigInput["options"]>["enrichEvent"],
        },
      });
      sdk.reportInteraction(tap());

      sdk.sendCustomEvent({ event: "before-cap", attributes: {} });
      await drain();
      const sessionIdBefore = recordedCalls(fetchMock)
        .map((c) => decodeBody(c).sessionAttributes.session_id)
        .at(-1);
      expect(sessionIdBefore).toBeTruthy();

      // Past the cap. The next event rotates, and enrichEvent moves ITS
      // timestamp 5ms earlier than the value the resolver saw.
      clock = base + SESSION_MAX_DURATION_MS + 1_000;
      backdate = true;
      sdk.sendCustomEvent({ event: "after-cap", attributes: {} });
      backdate = false;
      await drain();

      // The rotation reset the activity clock; confirm the successor and drain.
      sdk.reportInteraction(tap());
      sdk.sendCustomEvent({ event: "post-rotation", attributes: {} });
      await drain();

      const rotated = recordedCalls(fetchMock)
        .map(decodeBody)
        .filter((b) => b.sessionAttributes.session_id !== sessionIdBefore);
      expect(rotated.length, "the cap should have rotated the session").toBeGreaterThan(0);

      for (const { sessionAttributes, events } of rotated) {
        const times = events
          .map((event) => event.timestamp ?? event.start_timestamp)
          .filter((time): time is number => typeof time === "number");
        expect(times.length).toBeGreaterThan(0);
        expect(
          sessionAttributes.session_start_time,
          "the rotated session started after an enriched event it carries"
        ).toBeLessThanOrEqual(Math.min(...times));
      }
    } finally {
      nowSpy.mockRestore();
    }
  });


  // The shared requests. Each file in packages/core/wire is what one call
  // sends after presence (a tap), on the fixture clock.
  describe("shared wire fixtures", () => {
    // The request as the file holds it: without the random ids (their format is
    // checked here instead), what only RN sends, and the stack trace, whose frames
    // are the platform's.
    function sharedRequest(call: FetchCall): unknown {
      const batch = decodeBody(call);
      expect(batch.sessionAttributes.session_id).toMatch(HEX_32);
      const events = batch.events
        .filter((event) => event.type !== "interaction")
        .map((event) => {
          expect(event.id).toMatch(HEX_32);
          expect(event.spanId).toMatch(HEX_16);
          expect(event.traceId).toMatch(TRACE_ID);
          const attributes = without(event.attributes ?? {}, ["screen", "error_stacktrace"]);
          return { ...without(event, ["id", "spanId", "traceId"]), attributes };
        });
      const sessionAttributes = without(batch.sessionAttributes, ["session_id", "app", "device", "os", "source"]);
      return { url: call.url, headers: call.headers, body: { ...batch, sessionAttributes, events } };
    }

    async function onlyRequest(send: (sdk: RNSessionManager) => void): Promise<unknown> {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXTURE_CLOCK_MS);
      try {
        const sdk = initSDK();
        sdk.reportInteraction(tap());
        send(sdk);
        await drain();
      } finally {
        nowSpy.mockRestore();
      }
      const calls = recordedCalls(fetchMock);
      expect(calls).toHaveLength(1);
      return sharedRequest(calls[0]!);
    }

    it("custom-event.json", async () => {
      const sent = await onlyRequest((sdk) =>
        sdk.sendCustomEvent({ event: "purchase", attributes: { amount: 42, nested: { sku: "abc" } } })
      );
      expect(sent).toEqual(fixture("custom-event.json"));
    });

    it("log-event.json", async () => {
      const sent = await onlyRequest((sdk) => sdk.emitLog("golden log line", "warn", { context: "checkout" }));
      expect(sent).toEqual(fixture("log-event.json"));
    });

    it("exception-event.json", async () => {
      const sent = await onlyRequest((sdk) => sdk.captureException(new Error("golden failure"), { stage: "test" }));
      expect(sent).toEqual(fixture("exception-event.json"));
    });
  });

  // A crash from a PREVIOUS run is the one payload whose envelope is not the
  // live session's — it carries the crashed session's, verbatim. This pins that
  // batch end to end, since a regression here silently reattributes every
  // mobile crash to the wrong session.
  describe("drained native crash batch", () => {
    const CRASHED_SESSION = {
      session_id: "0123456789abcdef0123456789abcdef",
      session_start_time: 1_700_000_000_000_000_000,
      source: "mobile-rum",
      cluster: "golden-cluster",
      env: "golden-env",
      namespace: "golden-namespace",
      releaseId: "golden-release",
      user: { id: "user-1", email: "user@example.com" },
      "service.name": "golden-app",
      os: { name: "ios", version: "17.4" },
      screen: { name: "Checkout", key: "Checkout-1" },
    };
    const CRASH_EPOCH_MS = 1_700_000_123_456;

    async function drainCrash(): Promise<Batch> {
      const { drainNativeCrashReports, __resetDrainStateForTest } = await import(
        "./events/native-crash-drain"
      );
      const { ConfigManager, RandomIdGenerator } = await import("@groundcover/rum-core");
      __resetDrainStateForTest();

      const config = new ConfigManager();
      config.initialize(BASE_CONFIG as never);

      await drainNativeCrashReports({
        config,
        idGenerator: new RandomIdGenerator(),
        native: {
          nativeInit: vi.fn().mockResolvedValue("{}"),
          updateSessionSnapshot: vi.fn(),
          getPendingCrashReports: vi.fn().mockResolvedValue(
            JSON.stringify([
              {
                id: "kscrash-1700000123456-01",
                crashEpochMs: CRASH_EPOCH_MS,
                errorType: "EXC_BAD_ACCESS",
                errorMessage: "Attempted to dereference garbage pointer 0x10",
                stacktrace: [
                  { filename: "GoldenApp", function: "0x0000000104a3f1c8", lineno: 0, colno: 0 },
                  { filename: "UIKitCore", function: "-[UIApplication sendAction:]", lineno: 0, colno: 0 },
                ],
                metadata: { crash_source: "kscrash", signal: "SIGSEGV", crashed_thread: 0 },
                sessionSnapshotJson: JSON.stringify(CRASHED_SESSION),
                screen: { name: "Checkout", key: "Checkout-1" },
              },
            ])
          ),
          clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
          flushFrameSegment: vi.fn().mockResolvedValue("null"),
          stop: vi.fn(),
          addListener: vi.fn(),
          removeListeners: vi.fn(),
        },
      });

      return decodeBody(recordedCalls(fetchMock)[0]!);
    }

    it("POSTs its own batch under the CRASHED session's envelope", async () => {
      const batch = await drainCrash();

      expect(recordedCalls(fetchMock)[0]!.url).toBe("https://ingest.golden.example/json/rum");
      expect(Object.keys(batch).sort()).toEqual(["events", "sessionAttributes"]);
      expect(batch.sessionAttributes.session_id).toBe(CRASHED_SESSION.session_id);
      expect(batch.sessionAttributes.session_start_time).toBe(CRASHED_SESSION.session_start_time);
      expect(batch.sessionAttributes.user).toEqual(CRASHED_SESSION.user);
      // `screen` is per-event, never part of the envelope.
      expect(batch.sessionAttributes.screen).toBeUndefined();
      expect(batch.events).toHaveLength(1);
    });

    it("pins the exception event's wire shape", async () => {
      const batch = await drainCrash();
      const event = batch.events[0]!;

      expect(event.type).toBe("exception");
      expect(event.id).toMatch(HEX_32);
      expect(event.spanId).toMatch(HEX_16);
      // Crash TIME, not drain time (ns).
      expect(event.timestamp).toBe(CRASH_EPOCH_MS * 1_000_000);
      // Browser parity: only network events carry a span_name.
      expect(event.span_name).toBeUndefined();

      const a = event.attributes as Record<string, unknown>;
      expect(a["error_type"]).toBe("EXC_BAD_ACCESS");
      expect(a["error_message"]).toBe("Attempted to dereference garbage pointer 0x10");
      expect(a["error_handled"]).toBe(false);
      expect(a["error_fingerprint"]).toBe(
        "EXC_BAD_ACCESS:Attempted to dereference garbage pointer 0x10"
      );
      // error_metadata is an object → dot-flattened by the enricher.
      expect(a["error_metadata.native"]).toBe(true);
      expect(a["error_metadata.fatal"]).toBe(true);
      expect(a["error_metadata.crash_source"]).toBe("kscrash");
      expect(a["error_metadata.signal"]).toBe("SIGSEGV");
      expect(a["error_metadata.crash_report_id"]).toBe("kscrash-1700000123456-01");
      // The platform screen stamp stays NESTED (merged after flattening).
      expect(a["screen"]).toEqual({ name: "Checkout", key: "Checkout-1" });
    });

    it("pins the stacktrace's array-of-prefixed-keys shape", async () => {
      // Arrays stay arrays, but object ELEMENTS inside them get prefixed dotted
      // keys — what the browser SDK has always shipped for JS exceptions, and
      // therefore the shape the ingest already parses.
      const batch = await drainCrash();
      const frames = (batch.events[0]!.attributes as Record<string, unknown>)[
        "error_stacktrace"
      ] as Array<Record<string, unknown>>;

      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual({
        "error_stacktrace[0].filename": "GoldenApp",
        "error_stacktrace[0].function": "0x0000000104a3f1c8",
        "error_stacktrace[0].lineno": 0,
        "error_stacktrace[0].colno": 0,
      });
      expect(frames[1]!["error_stacktrace[1].function"]).toBe("-[UIApplication sendAction:]");
    });
  });
});
