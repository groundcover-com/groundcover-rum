import { Logger } from "@groundcover/rum-core/common/logger";
import { handleError } from "@groundcover/rum-core/common/error-handler";
import { _globalThis } from "../common/global";
import { SESSION_INACTIVITY_TIMEOUT_MS } from "@groundcover/rum-core/config/constants";

// Raw user input proves presence even when it produces no SDK event — a user
// reading or watching only scrolls and moves the pointer, which the DOM
// listener doesn't capture.
const PRESENCE_INPUT_EVENTS = [
  "pointerdown",
  "keydown",
  "scroll",
  "touchstart",
  "mousemove",
] as const;

// mousemove fires at frame rate and presence has 30-minute resolution — one
// signal per throttle window is plenty.
const PRESENCE_SIGNAL_THROTTLE_MS = 30_000;

type UserPresenceMonitorCallbacks = {
  // A throttled raw-input presence signal: the user is demonstrably there.
  onPresence: (nowMs: number) => void;
  // No presence of any kind (raw input or notePresence pokes) for the idle
  // window. Fires once per idle period; the next presence re-arms it.
  onIdle: () => void;
};

// The SDK's single authority on "is a user actually here?". Detects presence
// from passive window input listeners and exposes the complementary absence
// signal (the idle timer). Policy-free: what presence/idleness MEAN for the
// session lives in the owner (InstrumentationManager).
export class UserPresenceMonitor {
  private logger = Logger.getInstance();
  private callbacks: UserPresenceMonitorCallbacks;
  private lastSignalMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private installed = false;

  constructor(callbacks: UserPresenceMonitorCallbacks) {
    this.callbacks = callbacks;
  }

  // Bound once so add/removeEventListener refer to the same function.
  private handleInput = (): void => {
    const nowMs = Date.now();
    if (nowMs - this.lastSignalMs < PRESENCE_SIGNAL_THROTTLE_MS) return;
    this.notePresence(nowMs);

    try {
      this.callbacks.onPresence(nowMs);
    } catch (error) {
      handleError(error);
    }
  };

  initialize(): void {
    if (this.installed) return;
    this.installed = true;

    // Isolate each step so one failing addEventListener can't block the rest
    // (never crash the host app).
    PRESENCE_INPUT_EVENTS.forEach((type) => {
      try {
        _globalThis.addEventListener?.(type, this.handleInput, { capture: true, passive: true });
      } catch (error) {
        handleError(error);
      }
    });
    this.armIdleTimer();
    this.logger.log("[user-presence-monitor] installed");
  }

  // Quiet poke for presence the monitor can't see itself (SDK activity events
  // like clicks routed through listeners, programmatic custom events): re-arms
  // the idle timer AND consumes the throttle window WITHOUT firing onPresence.
  // Consuming the throttle dedupes the raw input that accompanies the same
  // physical interaction (a click's pointerdown) so it doesn't reconcile
  // twice — only call this when a real input is genuinely in flight.
  notePresence(nowMs: number): void {
    this.lastSignalMs = nowMs;
    this.armIdleTimer();
  }

  // Re-arm the idle timer only, leaving the input throttle untouched. For
  // callers that want a fresh idle lease without claiming a user signal —
  // e.g. a programmatic startReplayRecording() with no accompanying input,
  // which must NOT suppress the next genuine scroll/keypress.
  resetIdleTimer(): void {
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    // Contained: this runs inside input handlers and reconciliation — a
    // throwing clearTimeout/setTimeout must not leak into the host app, and a
    // failed re-arm must not leave a stale handle around.
    try {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
      }
      this.idleTimer = null;

      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.logger.log("[user-presence-monitor] user idle for", SESSION_INACTIVITY_TIMEOUT_MS, "ms");
        try {
          this.callbacks.onIdle();
        } catch (error) {
          handleError(error);
        }
      }, SESSION_INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      handleError(error);
    }
  }

  destroy(): void {
    if (!this.installed) return;
    this.installed = false;

    // Isolate each step so one failing removal can't strand the rest.
    PRESENCE_INPUT_EVENTS.forEach((type) => {
      try {
        _globalThis.removeEventListener?.(type, this.handleInput, { capture: true });
      } catch (error) {
        handleError(error);
      }
    });
    try {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
      }
    } catch (error) {
      handleError(error);
    } finally {
      this.idleTimer = null;
    }
  }
}
