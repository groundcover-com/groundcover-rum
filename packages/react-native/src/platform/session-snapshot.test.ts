import { describe, expect, it, vi } from "vitest";

import { NativeSnapshotPusher } from "./session-snapshot";
import type { GroundcoverNativeModule } from "./native-types";

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

const SESSION_ATTRIBUTES = {
  session_id: "session-1",
  session_start_time: 1_700_000_000_000_000_000,
  source: "mobile-rum",
  user: { id: "user-1" },
};

describe("NativeSnapshotPusher", () => {
  it("pushes the session envelope with the current screen attached", () => {
    const native = nativeStub();
    const pusher = new NativeSnapshotPusher({
      native,
      getSessionAttributes: () => SESSION_ATTRIBUTES,
      getScreen: () => ({ name: "Checkout", key: "Checkout-1" }),
    });

    pusher.push();

    expect(native.updateSessionSnapshot).toHaveBeenCalledTimes(1);
    const pushed = JSON.parse(
      (native.updateSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    );
    expect(pushed).toEqual({ ...SESSION_ATTRIBUTES, screen: { name: "Checkout", key: "Checkout-1" } });
  });

  it("re-reads the envelope on every push so a rotation is reflected", () => {
    const native = nativeStub();
    let sessionId = "session-1";
    const pusher = new NativeSnapshotPusher({
      native,
      getSessionAttributes: () => ({ ...SESSION_ATTRIBUTES, session_id: sessionId }),
      getScreen: () => ({ name: "", key: "" }),
    });

    pusher.push();
    sessionId = "session-2";
    pusher.push();

    const calls = (native.updateSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(calls[0]![0] as string).session_id).toBe("session-1");
    expect(JSON.parse(calls[1]![0] as string).session_id).toBe("session-2");
  });

  it("clears native's copy so a post-teardown crash is not attributed to a dead session", () => {
    const native = nativeStub();
    const pusher = new NativeSnapshotPusher({
      native,
      getSessionAttributes: () => SESSION_ATTRIBUTES,
      getScreen: () => ({ name: "", key: "" }),
    });

    pusher.clear();

    expect(native.updateSessionSnapshot).toHaveBeenCalledWith(null);
  });

  it("is inert without a native module (Expo Go)", () => {
    const getSessionAttributes = vi.fn(() => SESSION_ATTRIBUTES);
    const pusher = new NativeSnapshotPusher({
      native: null,
      getSessionAttributes,
      getScreen: () => ({ name: "", key: "" }),
    });

    expect(() => {
      pusher.push();
      pusher.clear();
    }).not.toThrow();
    // Not even the envelope is assembled — no native module means no consumer.
    expect(getSessionAttributes).not.toHaveBeenCalled();
  });

  it("swallows a bridge failure — a stale snapshot beats breaking the pipeline", () => {
    const native = nativeStub();
    native.updateSessionSnapshot = vi.fn(() => {
      throw new Error("bridge is down");
    });
    const pusher = new NativeSnapshotPusher({
      native,
      getSessionAttributes: () => SESSION_ATTRIBUTES,
      getScreen: () => ({ name: "", key: "" }),
    });

    expect(() => pusher.push()).not.toThrow();
  });
});
