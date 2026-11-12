import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";
import { SafeStorage, type Batch, type BaseEvent, type PlatformStorage } from "@groundcover/rum-core";

import { RNSessionManager } from "../session-manager/session-manager";
import type { SDKConfigInput } from "../config/types";
import {
  __emitNativeSignal,
  __reset as resetRN,
  __setNativeModule,
} from "../test-utils/react-native-stub";
import {
  NATIVE_EVENT_CHANNEL,
  NATIVE_MODULE_NAME,
  type GroundcoverNativeModule,
} from "../platform/native-types";
import { clearTouchHistory } from "../internal/touch-bridge";
import { __internals } from "../react/GroundcoverProvider";
import type { RNEventType } from "./rn-event-types";

// Masking on the NATIVE gesture path. Taps, inputs and native gestures share one masking step
// (`maskTarget` in the interaction listener), and this is the only path that reports native
// swipes, since JS stands down once the tracker attaches and `gestures` is on by default — so the
// gesture side of that promise is pinned end to end here.
//
// Both cases drive the REAL chain rather than seeding the correlation buffer: the provider walks
// a fiber at touch-down and a native gesture is correlated back to it afterwards. Seeding by
// hand would skip the step where the masking decision could be lost.

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

// gestures: true — the tracker is armed, and the native gesture each case emits is
// reported by the native builder.
function nativeModule(): GroundcoverNativeModule {
  return {
    nativeInit: vi.fn().mockResolvedValue(
      JSON.stringify({
        crashes: false,
        hangs: false,
        appStart: false,
        vitals: false,
        gestures: true,
      })
    ),
    updateSessionSnapshot: vi.fn(),
    getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
    clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
    flushFrameSegment: vi.fn().mockResolvedValue("null"),
    stop: vi.fn(),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  };
}

/** The holder the provider's handlers thread their in-flight touch through. */
type Holder = Parameters<typeof __internals.onTouchEnd>[1];

/**
 * A synthetic touch event carrying a fiber, as RN's dispatch delivers one.
 * `_targetInst` is what both Paper and Fabric expose (see `resolveFiber`).
 */
function touchAt(x: number, y: number, fiber: unknown) {
  return { nativeEvent: { pageX: x, pageY: y, touches: [{}] }, _targetInst: fiber };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("native gesture masking", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: RNSessionManager | null = null;

  beforeEach(() => {
    resetRN();
    clearTouchHistory();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule());
  });

  afterEach(() => {
    sdk?.destroy();
    sdk = null;
    clearTouchHistory();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function interactions(): BaseEvent<RNEventType>[] {
    return fetchMock.mock.calls
      .flatMap((call) => {
        const [, init] = call as [string, { headers: Record<string, string>; body: Uint8Array }];
        const bytes =
          init.headers["Content-Encoding"] === "gzip" ? gunzipSync(init.body) : init.body;
        return (JSON.parse(strFromU8(bytes)) as Batch).events as BaseEvent<RNEventType>[];
      })
      .filter((e) => e.type === "interaction");
  }

  /**
   * Touch down on `fiber`, then have native report a scroll that grew out of
   * that same touch (same instant, same origin — what `correlateGesture`
   * matches on).
   */
  async function scrollOver(fiber: unknown): Promise<BaseEvent<RNEventType> | undefined> {
    const startedAtMs = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(startedAtMs);

    const holder: Holder = { current: null } as Holder;
    __internals.onTouchStart(touchAt(200, 400, fiber), holder);

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "gesture",
      payload: {
        kind: "scroll",
        startedAtMs,
        endedAtMs: startedAtMs + 400,
        startX: 200,
        startY: 400,
        endX: 200,
        endY: 120,
        direction: "up",
        distanceDp: 280,
        velocityDpS: 700,
        pointerCount: 1,
      },
    });

    sdk!.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    return interactions().find((e) => {
      const a = e.attributes as Record<string, unknown>;
      return a["interaction_type"] === "scroll";
    });
  }

  it("does not leak the label through `component` when global masking is on", async () => {
    // `component` is documented as structural and is deliberately never masked.
    // That is only safe while it holds a component NAME — the tap path uses
    // `walk.component`. If the gesture path puts a resolved LABEL there, then
    // masking `label` accomplishes nothing: the same string ships in the field
    // beside it.
    sdk = new RNSessionManager(
      { ...BASE, options: { ...BASE.options, privacy: { maskInteractionLabels: true } } },
      storage()
    );
    await drain();

    // No named component anywhere in the ancestry — a bare host view with an
    // accessibility label, which is the ordinary shape for View/Text/Pressable
    // composition. `describeTarget` therefore falls back to the label.
    const scroll = await scrollOver({
      elementType: "RCTView",
      memoizedProps: { accessibilityLabel: "Balance 12345 USD" },
      return: null,
    });

    expect(scroll).toBeDefined();
    const a = scroll!.attributes as Record<string, unknown>;
    expect(a["interaction_target.label"]).toBe("***");
    // The real assertion: the secret must not appear ANYWHERE in the event, in
    // `component` or otherwise. Masking one field while the value survives in
    // the next one is not masking.
    expect(JSON.stringify(a)).not.toContain("12345");
  });

  it("honours a dataPrivate element's opt-out, as the tap path already does", async () => {
    // Default privacy (mask-sensitive) — labels are NOT globally masked here, so
    // the per-element opt-out is the only thing protecting this value. The tap
    // path covers exactly this case in wire-format-golden.test.ts; a swipe or
    // scroll over the same element must behave the same way.
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    // A host view again, for the same reason as above: with a named component in
    // the ancestry the resolved target is that NAME and the label never reaches
    // the payload at all, so such a fiber cannot demonstrate a label leak.
    const scroll = await scrollOver({
      elementType: "RCTView",
      memoizedProps: { dataPrivate: true, accessibilityLabel: "SSN 123-45-6789" },
      return: null,
    });

    expect(scroll).toBeDefined();
    const a = scroll!.attributes as Record<string, unknown>;
    expect(a["interaction_target.label"]).toBe("***");
    expect(JSON.stringify(a)).not.toContain("123-45-6789");
  });

  it("still labels a non-sensitive gesture, so the masking above is not vacuous", async () => {
    // Without this, both tests above would pass just as happily against a
    // builder that masked everything unconditionally — or emitted nothing.
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    const scroll = await scrollOver({
      elementType: "ProductCarousel",
      memoizedProps: { accessibilityLabel: "Featured products" },
      return: null,
    });

    expect(scroll).toBeDefined();
    const a = scroll!.attributes as Record<string, unknown>;
    expect(a["interaction_target.label"]).toBe("Featured products");
    expect(a["interaction_target.component"]).toBe("ProductCarousel");
    // Native's kinematics still ride along.
    expect(a["interaction_gesture.distance_dp"]).toBe(280);
  });
});
