import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";
import { SafeStorage, type Batch, type BaseEvent, type PlatformStorage } from "@groundcover/rum-core";

import { RNSessionManager } from "../session-manager/session-manager";
import type { SDKConfigInput } from "../config/types";
import type { RNEventType } from "../events/rn-event-types";
import { __reset as resetRN, __emitAppState } from "../test-utils/react-native-stub";
import type { RawGesture } from "../internal/touch-bridge";
import { EMPTY_WALK } from "../react/fiber-walk";

/** A tap as the touch boundary reports one: kind "tap", target already walked. */
const tap = (x = 1, y = 1): RawGesture => ({
  kind: "tap",
  x,
  y,
  target: EMPTY_WALK,
  captureSource: "js",
  startedAtMs: 0,
  distanceDp: 0,
  durationMs: 0,
  velocityDpS: 0,
  pointerCount: 1,
  partial: false,
});

// End-to-end integration across the real composition root, real core and real
// listeners — only the RN host boundary (react-native / AsyncStorage) is stubbed
// and `fetch` is captured as a fake ingest. This is the strongest red/green
// signal CI can run without a device.

const BASE: SDKConfigInput = {
  dsn: "ingest.example",
  apiKey: "k",
  cluster: "c",
  environment: "e",
  appId: "a",
  options: { debug: false, transport: { batchSize: 0, compression: false } },
};

function storage(): SafeStorage {
  const map = new Map<string, string>();
  const backing: PlatformStorage = {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return new SafeStorage(backing);
}

// Typed over the RN event union so a misspelled kind in a comparison is a type
// error — core's Batch leaves the event type an open string.
function events(fetchMock: ReturnType<typeof vi.fn>): BaseEvent<RNEventType>[] {
  return fetchMock.mock.calls.flatMap((call) => {
    const [, init] = call as [string, { headers: Record<string, string>; body: Uint8Array }];
    const bytes = init.headers["Content-Encoding"] === "gzip" ? gunzipSync(init.body) : init.body;
    return (JSON.parse(strFromU8(bytes)) as Batch).events as BaseEvent<RNEventType>[];
  });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("e2e — multi-signal flow", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: RNSessionManager | null = null;

  beforeEach(() => {
    resetRN();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    sdk?.destroy();
    sdk = null;
    vi.unstubAllGlobals();
  });

  it("captures tap → custom → log across one session and delivers all three", async () => {
    sdk = new RNSessionManager(BASE, storage());
    sdk.reportInteraction(tap(10, 20));
    sdk.sendCustomEvent({ event: "checkout", attributes: { total: 1 } });
    sdk.emitLog("hello", "info");
    await drain();

    const all = events(fetchMock);
    const types = all.map((e) => e.type);
    expect(types).toContain("interaction");
    expect(types).toContain("custom");
    expect(types).toContain("log");

    // Interaction target shape: no test_id; the enriched hint field is present.
    const interaction = all.find((e) => e.type === "interaction");
    const ia = interaction?.attributes as Record<string, unknown>;
    expect(ia["interaction_target.test_id"]).toBeUndefined();
    expect(ia).toHaveProperty("interaction_target.hint");
    expect(ia["interaction_touch_type"]).toBeUndefined();
  });

  it("emits NO navigation events (auto or manual) when 'navigation' is excluded from enabledEvents", async () => {
    sdk = new RNSessionManager(
      { ...BASE, options: { ...BASE.options, enabledEvents: ["interaction"] } },
      storage()
    );
    sdk.reportInteraction(tap(1, 1)); // confirm the session
    sdk.startNavigation({ screen: "A" });
    sdk.endNavigation({ screen: "A" });
    sdk.sendCustomEvent({ event: "flush", attributes: {} }); // drain the batch
    await drain();

    expect(events(fetchMock).filter((e) => e.type === "navigation")).toHaveLength(0);
  });

  it("a tap confirms the session even when interaction capture is disabled", async () => {
    sdk = new RNSessionManager(
      { ...BASE, options: { ...BASE.options, enabledEvents: ["logs"] } },
      storage()
    );
    // Presence confirms the session independently of which listeners are enabled.
    sdk.reportInteraction(tap(10, 20));
    sdk.sendCustomEvent({ event: "after-tap", attributes: {} });
    await drain();

    const all = events(fetchMock);
    expect(all.filter((e) => e.type === "interaction")).toHaveLength(0);
    const names = all
      .filter((e) => e.type === "custom")
      .map((e) => e.attributes?.custom_event_name);
    expect(names).toContain("after-tap");
  });

  it("flushes on AppState background transition", async () => {
    sdk = new RNSessionManager(BASE, storage());
    sdk.reportInteraction(tap(1, 1));
    // Buffer a navigation event (skip-flush type) so nothing has flushed yet.
    sdk.startNavigation({ screen: "A" });
    sdk.endNavigation({ screen: "A" });

    __emitAppState("background");
    await drain();

    expect(fetchMock).toHaveBeenCalled();
  });

  it("persists activity on AppState 'inactive' but does NOT flush — only 'background' flushes", async () => {
    // iOS fires 'inactive' on transient interruptions (Control Center, incoming
    // call). Flushing there would send redundant fragmented batches; only true
    // backgrounding should flush. (Activity is still persisted on both.)
    sdk = new RNSessionManager(BASE, storage());
    sdk.reportInteraction(tap(1, 1)); // confirm session
    // Buffer a skip-flush navigation so nothing has flushed on its own.
    sdk.startNavigation({ screen: "A" });
    sdk.endNavigation({ screen: "A" });

    __emitAppState("inactive");
    await drain();
    expect(fetchMock).not.toHaveBeenCalled(); // transient interruption → no flush

    __emitAppState("background");
    await drain();
    expect(fetchMock).toHaveBeenCalled(); // true backgrounding → flush
  });

  it("rotates the session after a 30+ minute background gap, on return to active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      sdk = new RNSessionManager(BASE, storage());
      sdk.reportInteraction(tap(1, 1));
      sdk.sendCustomEvent({ event: "before", attributes: {} });
      await vi.advanceTimersByTimeAsync(1);
      const firstId = sdk.getSessionId();

      __emitAppState("background");
      vi.setSystemTime(new Date("2026-01-01T00:31:00Z")); // 31 min later
      __emitAppState("active");

      sdk.sendCustomEvent({ event: "after", attributes: {} });
      await vi.advanceTimersByTimeAsync(1);
      const secondId = sdk.getSessionId();

      expect(secondId).not.toBe(firstId);
    } finally {
      vi.useRealTimers();
    }
  });
});
