import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __emitNativeSignal,
  __nativeListenerCount,
  __reset,
} from "../test-utils/react-native-stub";
import { NativeSignalsRouter } from "./native-signals-router";
import { NATIVE_EVENT_CHANNEL, type GroundcoverNativeModule } from "../platform/native-types";

function nativeStub(): GroundcoverNativeModule {
  return {
    nativeInit: vi.fn().mockResolvedValue("{}"),
    updateSessionSnapshot: vi.fn(),
    getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
    clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
    flushFrameSegment: vi.fn().mockResolvedValue("null"),
    stop: vi.fn(),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  };
}

const hangPayload = { kind: "anr" as const, startedAtMs: 1, durationMs: 5_000 };

afterEach(() => {
  __reset();
});

describe("NativeSignalsRouter", () => {
  it("routes a signal to the handler registered for its kind", () => {
    const hang = vi.fn();
    const frameSegment = vi.fn();
    const router = new NativeSignalsRouter(nativeStub());
    router.initialize({ hang, frame_segment: frameSegment });

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "hang", payload: hangPayload });

    expect(hang).toHaveBeenCalledWith(hangPayload);
    expect(frameSegment).not.toHaveBeenCalled();
  });

  it("drops a signal whose kind has no handler, without disturbing the ones that do", () => {
    const hang = vi.fn();
    const router = new NativeSignalsRouter(nativeStub());
    router.initialize({ hang });

    // A COMPLETE frame segment, deliberately. The obvious short payload
    // (`{ total, slow, frozen }`) is rejected by the bridge's own numeric-field guard
    // before any handler lookup happens, so it proves nothing about the router — and a bare
    // `not.toThrow()` would pass on that path too. The signal has to reach `dispatch` for
    // "no handler registered" to be what is under test.
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
      kind: "frame_segment",
      payload: {
        segmentStartMs: 1_000,
        segmentEndMs: 2_000,
        total: 60,
        slow: 1,
        frozen: 0,
        refreshRate: 60,
        reason: "navigation",
      },
    });

    // The real claim: an unregistered kind is a silent no-op, not a throw inside the
    // emitter callback and not a misdelivery to whoever else is listening.
    expect(hang).not.toHaveBeenCalled();

    // And the router still works afterwards — a dropped signal must not detach anything.
    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "hang", payload: hangPayload });
    expect(hang).toHaveBeenCalledWith(hangPayload);
  });

  it("subscribes exactly once even if initialize is called again", () => {
    const router = new NativeSignalsRouter(nativeStub());

    router.initialize({ hang: vi.fn() });
    router.initialize({ hang: vi.fn() });

    expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);
  });

  it("removes the subscription on destroy, so a re-init cannot double-report", () => {
    // A subscription leaked across re-init would report every hang once per
    // surviving listener.
    const first = vi.fn();
    const routerA = new NativeSignalsRouter(nativeStub());
    routerA.initialize({ hang: first });
    routerA.destroy();

    const second = vi.fn();
    const routerB = new NativeSignalsRouter(nativeStub());
    routerB.initialize({ hang: second });

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "hang", payload: hangPayload });

    expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing handler so the emitter callback never propagates", () => {
    const router = new NativeSignalsRouter(nativeStub());
    router.initialize({
      hang: () => {
        throw new Error("listener blew up");
      },
    });

    expect(() =>
      __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "hang", payload: hangPayload })
    ).not.toThrow();
  });

  it("ignores the ping used to prove the emitter is wired", () => {
    const hang = vi.fn();
    const router = new NativeSignalsRouter(nativeStub());
    router.initialize({ hang });

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "ping", payload: {} });

    expect(hang).not.toHaveBeenCalled();
  });
});
