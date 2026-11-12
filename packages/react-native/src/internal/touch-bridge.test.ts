import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@groundcover/rum-core";

import { reportInteraction, reportPresence, setTouchHandlers, type RawGesture } from "./touch-bridge";
import { EMPTY_WALK } from "../react/fiber-walk";

const swipe = (): RawGesture => ({
  kind: "swipe",
  x: 300,
  y: 400,
  target: EMPTY_WALK,
  captureSource: "js",
  startedAtMs: 1_700_000_000_000,
  direction: "left",
  distanceDp: 184,
  durationMs: 210,
  velocityDpS: 876,
  pointerCount: 1,
  partial: false,
});

describe("touch bridge dispatch", () => {
  afterEach(() => {
    setTouchHandlers({ onPresence: null, onInteraction: null });
    vi.restoreAllMocks();
  });

  /**
   * Contained, but not silent. The listener guards its own event building, so anything that
   * escapes to this boundary is the layer beneath it — a session-lifecycle or reconciliation
   * failure on a real touch. A bare `catch {}` here would make exactly those disappear, which reads
   * downstream as "presence just stopped working" with nothing to go on.
   */
  it("reports a handler failure rather than swallowing it", () => {
    const reported = vi.spyOn(core, "handleError").mockImplementation(() => {});
    setTouchHandlers({
      onPresence: null,
      onInteraction: () => {
        throw new Error("reconcile boom");
      },
    });

    expect(() => reportInteraction(swipe())).not.toThrow();
    expect(reported).toHaveBeenCalledTimes(1);
    expect((reported.mock.calls[0]?.[0] as Error).message).toBe("reconcile boom");
  });

  it("reports a presence-handler failure too — same boundary, same guarantee", () => {
    const reported = vi.spyOn(core, "handleError").mockImplementation(() => {});
    setTouchHandlers({
      onPresence: () => {
        throw new Error("presence boom");
      },
      onInteraction: null,
    });

    expect(() => reportPresence(1_700_000_000_000)).not.toThrow();
    expect(reported).toHaveBeenCalledTimes(1);
  });

  /** The host's touch dispatch is the one thing that must never see a throw — not even from
   *  the error reporter itself, which is why the report is nested inside its own guard. */
  it("still contains the failure when the error reporter itself throws", () => {
    vi.spyOn(core, "handleError").mockImplementation(() => {
      throw new Error("reporter boom");
    });
    setTouchHandlers({
      onPresence: null,
      onInteraction: () => {
        throw new Error("reconcile boom");
      },
    });

    expect(() => reportInteraction(swipe())).not.toThrow();
  });
});
