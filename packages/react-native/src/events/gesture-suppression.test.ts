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
import { clearTouchHistory, recordTouchStart, type RawGesture } from "../internal/touch-bridge";
import { EMPTY_WALK } from "../react/fiber-walk";
import type { RNEventType } from "./rn-event-types";
import { shouldSuppressJsGesture, NO_NATIVE_COVERAGE } from "./gesture-suppression";

// The policy itself, unit-tested directly — the end-to-end wiring (signal → flag → the JS
// gesture never reaching the wire) is exercised by the integration suite below.
describe("shouldSuppressJsGesture (policy)", () => {
  const gesture = (kind: RawGesture["kind"], insideModal = false) => ({
    kind,
    target: { ...EMPTY_WALK, insideModal },
  });

  /** A tracker that hooks every surface — iOS, which attaches per UIWindow. */
  const everywhere = { attached: true, coversAllSurfaces: true };
  /** A tracker that hooks only some — Android, which attaches per activity. */
  const mainSurfaceOnly = { attached: true, coversAllSurfaces: false };

  it("suppresses the movement kinds native measures, but only once it is attached", () => {
    expect(shouldSuppressJsGesture(gesture("swipe"), everywhere)).toBe(true);
    expect(shouldSuppressJsGesture(gesture("scroll"), everywhere)).toBe(true);
  });

  it("keeps JS in charge until the native tracker is confirmed attached", () => {
    // A tracker that never attached must leave JS reporting scrolls, not drop them.
    expect(shouldSuppressJsGesture(gesture("swipe"), NO_NATIVE_COVERAGE)).toBe(false);
    expect(shouldSuppressJsGesture(gesture("scroll"), NO_NATIVE_COVERAGE)).toBe(false);
  });

  it("never suppresses a tap or a pinch — native reports neither", () => {
    expect(shouldSuppressJsGesture(gesture("tap"), everywhere)).toBe(false);
    expect(shouldSuppressJsGesture(gesture("pinch"), everywhere)).toBe(false);
  });

  /**
   * THE modal case. "Attached" is not app-wide: a tracker hooks SURFACES, and Android hooks
   * activities — so a React Native `Modal`, which renders into a `Dialog`, is not one of them.
   *
   * Standing down here on the strength of the main activity being hooked would drop the gesture
   * outright: native is not watching that surface and JS has been told not to. Nobody measures it
   * and no event is produced at all.
   */
  it("keeps JS in charge inside a modal when the tracker does not reach every surface", () => {
    expect(shouldSuppressJsGesture(gesture("swipe", true), mainSurfaceOnly)).toBe(false);
    expect(shouldSuppressJsGesture(gesture("scroll", true), mainSurfaceOnly)).toBe(false);
  });

  it("still stands down inside a modal when the tracker DOES reach every surface", () => {
    // iOS covers the modal's own UIWindow, so native's better numbers still win there — the modal
    // rule must not cost iOS its native measurement to buy Android's missing one.
    expect(shouldSuppressJsGesture(gesture("swipe", true), everywhere)).toBe(true);
    expect(shouldSuppressJsGesture(gesture("scroll", true), everywhere)).toBe(true);
  });

  it("is unaffected outside a modal by how much the tracker reaches", () => {
    expect(shouldSuppressJsGesture(gesture("scroll", false), mainSurfaceOnly)).toBe(true);
  });
});

// Which side reports a scroll or swipe. Native measures them properly — it sees the gesture
// through to the end, where the JS stream was cancelled — so JS stands down once its tracker
// is CONFIRMED attached. A tracker that failed to attach must leave JS in charge rather than
// silently dropping every scroll.
//
// Confirmation is the tracker's own `gestures_attached` signal, never `nativeInit`'s status,
// which is true before any recognizer exists and stays true if none is ever created.

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

/**
 * @param gesturesArmed what `gestures` in the status means: the tracker was REQUESTED and
 *   created. Not that it hooked a window — the attach is posted to the main thread and
 *   `nativeInit` resolves before it runs.
 * @param gesturesAttached the tracker is hooked to a window RIGHT NOW. Only ever true from a
 *   re-init: on a first init the attach has not run yet. An engine that has already armed
 *   returns its cached status without re-arming, so this is the only way a fresh JS context
 *   can learn about an attach whose signal fired before it existed.
 */
function nativeModule(
  gesturesArmed: boolean,
  gesturesAttached = false,
  gesturesCoverAllSurfaces = false
): GroundcoverNativeModule {
  return {
    nativeInit: vi.fn().mockResolvedValue(
      JSON.stringify({
        crashes: true,
        hangs: true,
        appStart: true,
        vitals: true,
        gestures: gesturesArmed,
        gesturesAttached,
        gesturesCoverAllSurfaces,
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

const jsSwipe = (): RawGesture => ({
  x: 300,
  y: 400,
  target: EMPTY_WALK,
  captureSource: "js",
  kind: "swipe",
  direction: "left",
  distanceDp: 180,
  durationMs: 200,
  velocityDpS: 900,
  pointerCount: 1,
  partial: false,
  startedAtMs: Date.now(),
});

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("gesture suppression", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: RNSessionManager | null = null;

  beforeEach(() => {
    resetRN();
    clearTouchHistory();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    sdk?.destroy();
    sdk = null;
    clearTouchHistory();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Typed over the RN event union so a misspelled kind in a comparison is a type
  // error — core's Batch leaves the event type an open string.
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

  const attr = (event: BaseEvent<RNEventType>, key: string) =>
    (event.attributes as Record<string, unknown>)[key];

  it("lets JS report swipes when there is no native module at all (Expo Go)", async () => {
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    sdk.reportInteraction(jsSwipe());
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const swipes = interactions().filter((e) => attr(e, "interaction_type") === "swipe");
    expect(swipes).toHaveLength(1);
    expect(attr(swipes[0]!, "interaction_gesture.capture_source")).toBe("js");
  });

  it("keeps JS in charge when native is present but its tracker did NOT attach", async () => {
    // The silent-loss failure mode: suppressing on mere presence would drop
    // every scroll on a device where the tracker could not arm.
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(false));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    sdk.reportInteraction(jsSwipe());
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    expect(interactions().filter((e) => attr(e, "interaction_type") === "swipe")).toHaveLength(1);
  });

  /**
   * The startup race, and the reason suppression is driven by a signal. `nativeInit` resolves as
   * soon as the engine is armed, but the attach is posted to the main thread while the engine
   * arms off it — so there is a window where the status says `gestures: true` and no recognizer
   * exists. Standing down on the status would suppress JS there, and for the whole session if the
   * attach never succeeds.
   */
  it("keeps JS in charge while native is armed but has not attached yet", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    // No `gestures_attached` yet: the posted attach has not run.
    sdk.reportInteraction(jsSwipe());
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const swipes = interactions().filter((e) => attr(e, "interaction_type") === "swipe");
    expect(swipes).toHaveLength(1);
    expect(attr(swipes[0]!, "interaction_gesture.capture_source")).toBe("js");
  });

  it("stands down for swipes and scrolls once the native tracker reports it attached", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    // The tracker hooked a real window.
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "gestures_attached", payload: {} });

    sdk.reportInteraction(jsSwipe());
    sdk.reportInteraction({ ...jsSwipe(), kind: "scroll", partial: true });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    // Native reports these with real kinematics; two events per gesture, the
    // JS one carrying worse numbers, is exactly what suppression prevents.
    expect(interactions().filter((e) => attr(e, "interaction_type") === "swipe")).toHaveLength(0);
    expect(interactions().filter((e) => attr(e, "interaction_type") === "scroll")).toHaveLength(0);
  });

  /**
   * The signal is EDGE-triggered, and a fresh JS context misses an edge that already passed.
   *
   * Both engines return their cached status from a second `nativeInit` without re-arming, so the
   * tracker is not re-created, `attach()` never runs again, and `gestures_attached` is never
   * re-emitted. The tracker is still hooked to the window and still emitting gestures. The cached
   * status therefore re-stamps `gesturesAttached`; without it JS would come back believing nothing
   * is attached while native measures every swipe — and both would report it.
   *
   * Reachable in every Metro session: fast-refresh re-runs `init()`, and with it `nativeInit`
   * against an engine that is already started, so without this every swipe after a reload would be
   * reported twice.
   */
  it("stands down when re-initialised against an engine whose tracker is already attached", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true, true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    // No `gestures_attached` will ever arrive: that edge fired in the previous JS context.
    sdk.reportInteraction(jsSwipe());
    sdk.reportInteraction({ ...jsSwipe(), kind: "scroll", partial: true });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    expect(interactions().filter((e) => attr(e, "interaction_type") === "swipe")).toHaveLength(0);
    expect(interactions().filter((e) => attr(e, "interaction_type") === "scroll")).toHaveLength(0);
  });

  /**
   * One physical swipe must store ONE `interaction` event, not two that disagree about distance
   * and velocity under the same attribute names. Asserted end to end — both sides report, and the
   * count is what a funnel over gestures would read.
   */
  it("emits ONE event per swipe when native is already attached and both sides see it", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true, true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    const startedAtMs = Date.now();
    // The JS classifier's view of the swipe (its numbers are the wrong ones).
    sdk.reportInteraction({ ...jsSwipe(), kind: "scroll", startedAtMs, x: 200, y: 400 });
    // Native's view of the SAME swipe, which arrives once the gesture has ended.
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "gesture",
      payload: {
        kind: "scroll",
        startedAtMs,
        endedAtMs: startedAtMs + 312,
        startX: 200,
        startY: 400,
        endX: 200,
        endY: 95,
        direction: "up",
        distanceDp: 305,
        velocityDpS: 1016,
        pointerCount: 1,
      },
    });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const scrolls = interactions().filter((e) => attr(e, "interaction_type") === "scroll");
    expect(scrolls).toHaveLength(1);
    // And the survivor is the one that measured the gesture correctly.
    expect(attr(scrolls[0]!, "interaction_gesture.capture_source")).toBe("native");
    expect(attr(scrolls[0]!, "interaction_gesture.velocity_dp_s")).toBe(1016);
  });

  /**
   * The re-init half of the coverage contract.
   *
   * `gestures_attached` carries `coversAllSurfaces`, but a re-init never sees that signal — the
   * edge fired in the previous JS context. Restoration goes through `nativeInit`'s STATUS instead,
   * so the status has to carry coverage too. Without it the replacement manager would store
   * "attached, covers nothing", and on iOS — whose tracker covers every `UIWindow` — modal
   * gestures would stop being suppressed and be reported by BOTH sides after every fast refresh.
   *
   * Asserted through the pool rather than on the flag, so it fails if the value is stored but
   * never consulted.
   */
  it("restores full coverage on re-init, so an iOS modal gesture is not reported twice", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true, true, true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    // A drag inside a modal, on a tracker that reaches every surface: native measures it, so JS
    // must stand down exactly as it does outside a modal.
    sdk.reportInteraction({
      ...jsSwipe(),
      kind: "scroll",
      target: { ...EMPTY_WALK, insideModal: true },
    });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    expect(interactions().filter((e) => attr(e, "interaction_type") === "scroll")).toHaveLength(0);
  });

  /** The other side of it: a tracker that does NOT reach every surface must leave JS reporting. */
  it("restores PARTIAL coverage on re-init, so an Android modal gesture still reaches the wire", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true, true, false));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    sdk.reportInteraction({
      ...jsSwipe(),
      kind: "scroll",
      target: { ...EMPTY_WALK, insideModal: true },
    });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const scrolls = interactions().filter((e) => attr(e, "interaction_type") === "scroll");
    expect(scrolls).toHaveLength(1);
    expect(attr(scrolls[0]!, "interaction_gesture.capture_source")).toBe("js");
  });

  it("still reports long presses and pinches from JS — native does not detect those", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    sdk.reportInteraction({ ...jsSwipe(), kind: "long_press" });
    sdk.reportInteraction({ ...jsSwipe(), kind: "pinch", pointerCount: 2 });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const kinds = interactions().map((e) => attr(e, "interaction_type"));
    expect(kinds).toContain("long_press");
    expect(kinds).toContain("pinch");
  });

  it("labels a native gesture from the touch JS saw start", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    const startedAtMs = Date.now();
    recordTouchStart({
      startedAtMs,
      x: 200,
      y: 400,
      target: {
        ...EMPTY_WALK,
        component: "ProductCarousel",
        label: "Featured products",
        componentPath: "HomeScreen > ProductCarousel",
      },
    });

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "gesture",
      payload: {
        kind: "scroll",
        startedAtMs,
        endedAtMs: startedAtMs + 420,
        startX: 200,
        startY: 400,
        endX: 200,
        endY: 100,
        direction: "up",
        distanceDp: 300,
        velocityDpS: 714,
        pointerCount: 1,
      },
    });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const [scroll] = interactions().filter((e) => attr(e, "interaction_type") === "scroll");
    expect(scroll).toBeDefined();
    // Native's numbers...
    expect(attr(scroll!, "interaction_gesture.distance_dp")).toBe(300);
    expect(attr(scroll!, "interaction_gesture.velocity_dp_s")).toBe(714);
    expect(attr(scroll!, "interaction_gesture.duration_ms")).toBe(420);
    expect(attr(scroll!, "interaction_gesture.capture_source")).toBe("native");
    // ...with JavaScript's labels, which native cannot produce for an RCTView.
    // Component and label are distinct fields, exactly as on the tap path.
    expect(attr(scroll!, "interaction_target.label")).toBe("Featured products");
    expect(attr(scroll!, "interaction_target.component")).toBe("ProductCarousel");
    expect(attr(scroll!, "interaction_component_path")).toBe("HomeScreen > ProductCarousel");
  });

  it("reports an uncorrelated native gesture unlabelled rather than dropping it", async () => {
    __setNativeModule(NATIVE_MODULE_NAME, nativeModule(true));
    sdk = new RNSessionManager(BASE, storage());
    await drain();

    // No matching touch — a native-only surface, or a gesture that began before
    // the SDK was listening.
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "gesture",
      payload: {
        kind: "swipe",
        startedAtMs: Date.now(),
        endedAtMs: Date.now() + 200,
        startX: 50,
        startY: 60,
        endX: 300,
        endY: 60,
        direction: "right",
        distanceDp: 250,
        velocityDpS: 1250,
        pointerCount: 1,
      },
    });
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drain();

    const [swipe] = interactions().filter((e) => attr(e, "interaction_type") === "swipe");
    expect(swipe).toBeDefined();
    expect(attr(swipe!, "interaction_target.label")).toBe("");
    expect(attr(swipe!, "interaction_gesture.distance_dp")).toBe(250);
  });
});
