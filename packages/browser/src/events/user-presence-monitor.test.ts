import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { UserPresenceMonitor } from "./user-presence-monitor";

vi.mock("@groundcover/rum-core/common/logger", () => ({
  Logger: {
    getInstance: () => ({ log: vi.fn() }),
  },
}));

vi.mock("@groundcover/rum-core/common/error-handler", () => ({
  handleError: vi.fn(),
}));

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const THROTTLE_MS = 30_000;

describe("UserPresenceMonitor", () => {
  let onPresence: Mock<(nowMs: number) => void>;
  let onIdle: Mock<() => void>;
  let monitor: UserPresenceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    onPresence = vi.fn();
    onIdle = vi.fn();
    monitor = new UserPresenceMonitor({ onPresence, onIdle });
  });

  afterEach(() => {
    monitor.destroy();
    vi.useRealTimers();
  });

  describe("presence detection", () => {
    it("fires onPresence with the current timestamp on raw input", () => {
      monitor.initialize();

      window.dispatchEvent(new Event("scroll"));

      expect(onPresence).toHaveBeenCalledTimes(1);
      expect(onPresence).toHaveBeenCalledWith(Date.now());
    });

    it("listens to all presence input types", () => {
      monitor.initialize();

      for (const type of ["pointerdown", "keydown", "scroll", "touchstart", "mousemove"]) {
        onPresence.mockClear();
        vi.advanceTimersByTime(THROTTLE_MS);
        window.dispatchEvent(new Event(type));
        expect(onPresence, type).toHaveBeenCalledTimes(1);
      }
    });

    it("throttles presence signals", () => {
      monitor.initialize();

      window.dispatchEvent(new Event("mousemove"));
      expect(onPresence).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      window.dispatchEvent(new Event("mousemove"));
      expect(onPresence).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(THROTTLE_MS);
      window.dispatchEvent(new Event("mousemove"));
      expect(onPresence).toHaveBeenCalledTimes(2);
    });

    it("does not listen before initialize", () => {
      window.dispatchEvent(new Event("pointerdown"));

      expect(onPresence).not.toHaveBeenCalled();
    });

    it("survives an onPresence callback that throws", () => {
      onPresence.mockImplementation(() => {
        throw new Error("boom");
      });
      monitor.initialize();

      expect(() => window.dispatchEvent(new Event("scroll"))).not.toThrow();
    });
  });

  describe("idle detection", () => {
    it("fires onIdle after the idle window with no presence", () => {
      monitor.initialize();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("fires onIdle once per idle period (no repeat without new presence)", () => {
      monitor.initialize();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 3);

      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("raw input re-arms the idle timer", () => {
      monitor.initialize();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 60_000);
      window.dispatchEvent(new Event("scroll"));

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 60_000);
      expect(onIdle).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("presence after an idle period re-arms idle detection", () => {
      monitor.initialize();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
      expect(onIdle).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event("pointerdown"));
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

      expect(onIdle).toHaveBeenCalledTimes(2);
    });
  });

  describe("notePresence (quiet poke)", () => {
    it("re-arms the idle timer without firing onPresence", () => {
      monitor.initialize();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 60_000);
      monitor.notePresence(Date.now());
      expect(onPresence).not.toHaveBeenCalled();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 60_000);
      expect(onIdle).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("also resets the input throttle", () => {
      monitor.initialize();

      monitor.notePresence(Date.now());
      window.dispatchEvent(new Event("scroll"));

      // Within the throttle window of the poke: suppressed.
      expect(onPresence).not.toHaveBeenCalled();
    });
  });

  describe("resetIdleTimer (idle re-arm only)", () => {
    it("re-arms the idle timer", () => {
      monitor.initialize();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 60_000);
      monitor.resetIdleTimer();

      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 60_000);
      expect(onIdle).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("does NOT consume the input throttle — unlike notePresence", () => {
      monitor.initialize();

      monitor.resetIdleTimer();
      // A genuine input right after must still get through.
      window.dispatchEvent(new Event("scroll"));

      expect(onPresence).toHaveBeenCalledTimes(1);
    });
  });

  describe("destroy", () => {
    it("removes listeners and cancels the idle timer", () => {
      monitor.initialize();
      monitor.destroy();

      window.dispatchEvent(new Event("pointerdown"));
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

      expect(onPresence).not.toHaveBeenCalled();
      expect(onIdle).not.toHaveBeenCalled();
    });
  });
});
