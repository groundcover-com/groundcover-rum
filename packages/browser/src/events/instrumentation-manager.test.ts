import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InstrumentationManager } from "./instrumentation-manager";
import { msToNs } from "@groundcover/rum-core/common/global";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { SessionState } from "@groundcover/rum-core/session/session-state";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";

// This file covers the BROWSER-side policy: replay start/stop/pause/revival,
// listener wiring, manual-event delegation, and instrument/uninstrument
// teardown. The platform-agnostic session POLICY (rotation, reconciliation,
// the ghost-session gate) is tested directly in core's
// session/session-lifecycle.test.ts — here rotations only appear where
// replay behavior is coupled to them.

let mockEmitCallback: ((event: string, isCheckout?: boolean) => void) | null =
  null;
const mockRecordStopFn = vi.fn();

vi.mock("rrweb", () => ({
  record: vi.fn((options: { emit: typeof mockEmitCallback }) => {
    mockEmitCallback = options.emit;
    return mockRecordStopFn;
  }),
}));

vi.mock("@rrweb/packer", () => ({
  pack: vi.fn(),
}));

const mockLog = vi.fn();
vi.mock("@groundcover/rum-core/common/logger", () => ({
  Logger: {
    getInstance: () => ({ log: mockLog }),
    initialize: () => ({ log: mockLog }),
  },
}));

vi.mock("@groundcover/rum-core/common/error-handler", () => ({
  handleError: vi.fn(),
}));

// DI: the events pool is a fake passed through the constructor deps.
const mockAddEvent = vi.fn();
const mockFlush = vi.fn();
const mockSetBeforeEnqueueHook = vi.fn();
const mockSetFlushGate = vi.fn();
const mockDiscardBuffer = vi.fn();
const fakeEventsPool = {
  addEvent: mockAddEvent,
  flush: mockFlush,
  initialize: vi.fn(),
  setBeforeEnqueueHook: mockSetBeforeEnqueueHook,
  setFlushGate: mockSetFlushGate,
  discardBuffer: mockDiscardBuffer,
} as unknown as EventsPool;

// DI: identity enricher through the constructor deps.
const fakeEnricher = {
  enrich: vi.fn((event: unknown) => event),
  reservedAttributeKeys: ["location"],
} as unknown as EventEnricher;

const mockSetSessionId = vi.fn();
const mockGetSessionMaxDuration = vi.fn(() => 4 * 60 * 60 * 1000);
const mockGetSessionStartTime = vi.fn(() => 0);
// Mirror the real SessionState's single activity signal: a session is born
// UNCONFIRMED (clock 0), and any genuine presence stamps it via setLastActivityMs
// — a stamped clock (>0) IS the confirmation. Birth resets it to 0.
const mockLastActivityState = { value: 0 };
const mockSetSessionStartTime = vi.fn((startNs: number) => {
  mockGetSessionStartTime.mockReturnValue(startNs);
  mockLastActivityState.value = 0;
});
const mockSetLastActivityMs = vi.fn((nowMs: number) => {
  mockLastActivityState.value = nowMs;
});
// DI: fake SessionState passed through the constructor deps (session identity
// and activity state live here, not in ConfigManager).
const fakeSession = {
  getSessionId: () => "previous-session-id",
  setSessionId: mockSetSessionId,
  setSessionStartTime: mockSetSessionStartTime,
  getSessionMaxDuration: mockGetSessionMaxDuration,
  getSessionStartTime: mockGetSessionStartTime,
  getLastActivityMs: () => mockLastActivityState.value,
  setLastActivityMs: mockSetLastActivityMs,
  hasUserActivity: () => mockLastActivityState.value > 0,
  persistLastActivity: vi.fn(),
  // Mirror the real elapsed/cap/gap rules off the controllable getter mocks.
  getSessionElapsedMs: (nowMs: number = Date.now()) => {
    const startNs = mockGetSessionStartTime();
    return startNs ? nowMs - startNs / 1_000_000 : 0;
  },
  isSessionExpired: (nowMs: number = Date.now()) => {
    const startNs = mockGetSessionStartTime();
    if (!startNs) return false;
    return nowMs - startNs / 1_000_000 >= mockGetSessionMaxDuration();
  },
  isSessionInactive: (nowMs: number = Date.now()) => {
    const base = mockLastActivityState.value > 0
      ? mockLastActivityState.value
      : mockGetSessionStartTime() / 1_000_000;
    return base > 0 && nowMs - base >= 30 * 60 * 1000;
  },
} as unknown as SessionState;

// DI: fake ConfigManager passed through the constructor deps (configuration
// only — session state lives in fakeSession above).
const fakeConfigManager = {
  getConfig: () => ({ options: { enabledEvents: [] } }),
  getPrivacy: () => ({
    level: "mask-sensitive",
    maskTextSelector: undefined,
    maskSelectors: [],
    maskInputs: true,
    maskNetworkBodies: true,
    maskNetworkQueryParams: true,
    maskLogs: true,
    maskErrors: true,
    shouldMaskNetworkBodies: true,
    shouldMaskNetworkQueryParams: true,
    shouldMaskLogs: true,
    shouldMaskErrors: true,
    sensitiveKeys: [],
  }),
} as unknown as ConfigManager;

const createManager = () =>
  new InstrumentationManager({
    config: fakeConfigManager,
    session: fakeSession,
    eventsPool: fakeEventsPool,
    enricher: fakeEnricher,
  });

// Listener constructors return a stub instance with the lifecycle methods
// instrument()/uninstrument() call. (Factories are hoisted, so no shared
// top-level helper — inline the stub in each.)
vi.mock("./listeners/dom-events-listener", () => ({ DomEventsListener: vi.fn(function () { return { initialize: vi.fn(), destroy: vi.fn() }; }) }));
vi.mock("@groundcover/rum-core/events/listeners/logs-events-listener", () => ({ LogEventsListener: vi.fn(function () { return { initialize: vi.fn(), destroy: vi.fn() }; }) }));
vi.mock("./listeners/network-events-listener", () => ({ NetworkEventsListener: vi.fn(function () { return { initialize: vi.fn(), destroy: vi.fn() }; }) }));
vi.mock("./listeners/errors-events-listener", () => ({ ErrorsEventsListener: vi.fn(function () { return { initialize: vi.fn(), destroy: vi.fn() }; }) }));
vi.mock("./listeners/navigation-listener", () => ({ NavigationListener: vi.fn(function () { return { initialize: vi.fn(), destroy: vi.fn() }; }) }));
vi.mock("./listeners/page-load-listener", () => ({ PageLoadListener: vi.fn(function () { return { initialize: vi.fn(), destroy: vi.fn() }; }) }));
vi.mock("./listeners/performance-listener", () => ({ PerformanceListener: vi.fn(function () { return { initialize: vi.fn(), destroy: vi.fn() }; }) }));

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const resetMocks = () => {
  mockEmitCallback = null;
  mockRecordStopFn.mockClear();
  mockAddEvent.mockClear();
  mockFlush.mockClear();
  mockSetSessionId.mockClear();
  mockSetSessionStartTime.mockClear();
  mockSetBeforeEnqueueHook.mockClear();
  mockGetSessionMaxDuration.mockClear();
  mockGetSessionMaxDuration.mockReturnValue(FOUR_HOURS_MS);
  mockGetSessionStartTime.mockClear();
  mockGetSessionStartTime.mockReturnValue(0);
  mockSetLastActivityMs.mockClear();
  mockLastActivityState.value = 0;
  mockSetFlushGate.mockClear();
  mockDiscardBuffer.mockClear();
  mockLog.mockClear();
};

// The beforeEnqueue hook the manager's SessionLifecycle registers on
// instrument(). Invoking the returned fn simulates an event landing in
// EventsPool.addEvent (defaults to a user/business event; pass
// { type: "replay" } to simulate a replay batch).
const getHook = (): ((event?: { type: string }) => void) => {
  const hook = mockSetBeforeEnqueueHook.mock.calls.at(-1)?.[0];
  if (typeof hook !== "function") throw new Error("hook not registered");
  return (event = { type: "dom.event" }) => (hook as (e: unknown) => void)(event);
};

describe("InstrumentationManager - replay inactivity", () => {
  let manager: InstrumentationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();

    manager = createManager();
    // The idle timer lives in UserPresenceMonitor, armed at instrument()
    // (which always precedes replay in real usage).
    manager.instrument();
  });

  afterEach(() => {
    manager.uninstrument();
    vi.useRealTimers();
  });

  it("stops recording on inactivity WITHOUT rotating the session (lazy gap rotation owns that)", () => {
    manager.startReplayRecording();

    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);

    expect(mockRecordStopFn).toHaveBeenCalledTimes(1);
    expect(manager.isReplayRecording()).toBe(false);
    // No eager rotation while the user is absent — the session rotates lazily
    // on the next activity event.
    expect(mockSetSessionId).not.toHaveBeenCalled();
    expect(mockSetSessionStartTime).not.toHaveBeenCalled();
  });

  it("sends the final buffered replay batch on inactivity stop", () => {
    manager.startReplayRecording();
    // One buffered event (< batchSize) so only the stop path can send it.
    mockEmitCallback?.("evt");

    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);

    expect(mockAddEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "replay" })
    );
  });

  it("should clear sessionReplayListener on inactivity so a new recording can start", () => {
    manager.startReplayRecording();

    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
    mockRecordStopFn.mockClear();
    mockEmitCallback = null;

    manager.startReplayRecording();

    expect(mockEmitCallback).not.toBeNull();
  });

  it("a programmatic startReplayRecording into an already-idle tab is still bounded by the idle pause", () => {
    // The user is long gone: the idle timer fires with nothing recording and
    // stays disarmed (no presence to re-arm it).
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
    expect(manager.isReplayRecording()).toBe(false);

    // The app starts replay programmatically (consent callback, app timer) —
    // no user input involved. The explicit start is a fresh 30-minute lease…
    manager.startReplayRecording();
    expect(manager.isReplayRecording()).toBe(true);

    // …not an indefinite one: still nobody there, so recording pauses again
    // instead of capturing an empty tab forever.
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
    expect(manager.isReplayRecording()).toBe(false);
  });

  it("should not allow starting a second recording while one is active", () => {
    manager.startReplayRecording();
    const firstEmitCallback = mockEmitCallback;

    manager.startReplayRecording();

    expect(mockEmitCallback).toBe(firstEmitCallback);
    expect(mockLog).toHaveBeenCalledWith(
      "[instrumentation-manager] replay recording already started"
    );
  });

  describe("isReplayRecording", () => {
    it("returns false before any startReplayRecording call", () => {
      expect(manager.isReplayRecording()).toBe(false);
    });

    it("returns true after startReplayRecording", () => {
      manager.startReplayRecording();
      expect(manager.isReplayRecording()).toBe(true);
    });

    it("returns false after stopReplayRecording", () => {
      manager.startReplayRecording();
      manager.stopReplayRecording();
      expect(manager.isReplayRecording()).toBe(false);
    });

    it("returns false after inactivity-driven stop", () => {
      manager.startReplayRecording();
      vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
      expect(manager.isReplayRecording()).toBe(false);
    });
  });

  describe("emitLog redaction", () => {
    // groundcover.logger.* flows through emitLog, which bypasses the
    // console-capture listener — it must apply the same log masking so
    // logger.warn("password=…", {...}) is redacted like console.warn(…).
    it("redacts the message text and attributes under the privacy contract", () => {
      mockAddEvent.mockClear();

      manager.emitLog("login password=secret", "warn", {
        password: "secret",
        user: "bob",
      });

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      const event = mockAddEvent.mock.calls[0]?.[0];
      expect(event?.type).toBe("log");
      expect(event?.attributes.message).toBe("login password=[REDACTED]");
      expect(event?.attributes.password).toBe("[REDACTED]");
      expect(event?.attributes.user).toBe("bob");
    });
  });

  describe("restartReplayForConfigChange", () => {
    it("restarts the active recording so new privacy config applies", () => {
      manager.startReplayRecording();
      mockRecordStopFn.mockClear();

      manager.restartReplayForConfigChange();

      // Old recording stopped and a new one started (rrweb record re-invoked).
      expect(mockRecordStopFn).toHaveBeenCalledTimes(1);
      expect(manager.isReplayRecording()).toBe(true);
    });

    it("is a no-op when replay is not recording", () => {
      expect(manager.isReplayRecording()).toBe(false);
      manager.restartReplayForConfigChange();
      expect(manager.isReplayRecording()).toBe(false);
      expect(mockRecordStopFn).not.toHaveBeenCalled();
    });
  });
});

describe("InstrumentationManager - session policy wiring", () => {
  let manager: InstrumentationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();

    manager = createManager();
  });

  afterEach(() => {
    manager.uninstrument();
    vi.useRealTimers();
  });

  it("registers a beforeEnqueue hook on instrument()", () => {
    manager.instrument();
    expect(mockSetBeforeEnqueueHook).toHaveBeenCalledTimes(1);
    expect(typeof mockSetBeforeEnqueueHook.mock.calls[0]![0]).toBe("function");
  });

  it("clears the hook on uninstrument()", () => {
    manager.instrument();
    manager.uninstrument();
    expect(mockSetBeforeEnqueueHook).toHaveBeenLastCalledWith(null);
  });
});

describe("InstrumentationManager - rotation orchestration", () => {
  let manager: InstrumentationManager;

  const tripCap = () =>
    mockGetSessionStartTime.mockReturnValue(msToNs(Date.now() - FOUR_HOURS_MS - 1_000));

  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();

    manager = createManager();
    manager.instrument();
  });

  afterEach(() => {
    manager.uninstrument();
    vi.useRealTimers();
  });

  it("restarts replay under the new session when it was active (max-duration)", () => {
    manager.startReplayRecording();
    tripCap();

    getHook()();

    // Replay was active → restartReplay:true → a fresh recording is attached.
    expect(manager.isReplayRecording()).toBe(true);
  });

  it("does not start replay when it was inactive at rotation time", () => {
    tripCap();

    getHook()();

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(manager.isReplayRecording()).toBe(false);
  });

  it("does not rotate when inactivity fires while past the cap — the next activity event rotates once and revives replay", () => {
    // Reproduce the real EventsPool: addEvent fires the beforeEnqueue hook.
    // The replay-inactivity stop enqueues a final replay batch; that batch must
    // not trigger a max-duration rotation on its own (replay type-gate).
    mockAddEvent.mockImplementation(() => {
      const hook = mockSetBeforeEnqueueHook.mock.calls.at(-1)?.[0];
      if (typeof hook === "function") (hook as (e: unknown) => void)({ type: "replay" });
    });
    tripCap();

    try {
      manager.startReplayRecording();
      // Buffer a replay event so the inactivity stop flushes a final batch
      // (the enqueue that would re-trigger rotation).
      mockEmitCallback?.("evt");
      mockSetSessionId.mockClear();

      // Advance just PAST the window: an exact advance lands the gap check on an
      // equality boundary that msToNs()/1e6 sub-ms rounding tips either way.
      // The extra ms makes the gap unambiguous.
      vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS + 1);

      // No eager rotation at the timer: replay just stops.
      expect(mockSetSessionId).not.toHaveBeenCalled();
      expect(manager.isReplayRecording()).toBe(false);

      // The user comes back: exactly one rotation (gap and cap both expired,
      // but the gap rotation refreshes the start time so the cap can't fire
      // again), and replay restarts because its stop was inactivity-driven,
      // not explicit.
      getHook()();
      expect(mockSetSessionId).toHaveBeenCalledTimes(1);
      expect(manager.isReplayRecording()).toBe(true);
    } finally {
      mockAddEvent.mockReset();
    }
  });
});

describe("InstrumentationManager - inactivity-gap rotation (lazy)", () => {
  let manager: InstrumentationManager;

  // Record activity, then advance the clock past the idle window (which also
  // fires the replay inactivity timer if a recording is active).
  const openGap = () => {
    mockLastActivityState.value = Date.now();
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();

    manager = createManager();
    manager.instrument();
  });

  afterEach(() => {
    manager.uninstrument();
    vi.useRealTimers();
  });

  it("rotates and restarts replay on the first activity event after a gap", () => {
    manager.startReplayRecording();
    openGap();

    // Idle timer stopped replay; no rotation yet.
    expect(manager.isReplayRecording()).toBe(false);
    expect(mockSetSessionId).not.toHaveBeenCalled();

    getHook()({ type: "dom.event" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    // The triggering event proves the user is back → replay restarts.
    expect(manager.isReplayRecording()).toBe(true);
  });

  it("does not rotate on non-activity events after a gap (background pollers can't revive replay)", () => {
    manager.startReplayRecording();
    openGap();

    getHook()({ type: "network" });
    getHook()({ type: "performance" });
    getHook()({ type: "log" });

    expect(mockSetSessionId).not.toHaveBeenCalled();
    expect(manager.isReplayRecording()).toBe(false);
  });

  it("rotates the session on a gap but does NOT restart replay after an explicit stop", () => {
    manager.startReplayRecording();
    manager.stopReplayRecording();
    openGap();

    getHook()({ type: "dom.event" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(manager.isReplayRecording()).toBe(false);
  });

  it("an explicit stop AFTER the inactivity stop clears restart eligibility", () => {
    manager.startReplayRecording();
    openGap();
    // Replay is already stopped by the idle timer; the app then explicitly
    // turns replay off — the gap rotation must respect that.
    manager.stopReplayRecording();

    getHook()({ type: "dom.event" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(manager.isReplayRecording()).toBe(false);
  });

  it("does NOT revive replay on a cap rotation triggered by background traffic — only the user's return does", () => {
    manager.startReplayRecording();
    mockLastActivityState.value = Date.now();
    // Idle timer stops replay (user gone); polling traffic keeps flowing.
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
    expect(manager.isReplayRecording()).toBe(false);

    // The cap expires; the next NETWORK event rotates the session but must
    // not restart recording in an empty tab.
    mockGetSessionStartTime.mockReturnValue(msToNs(Date.now() - FOUR_HOURS_MS - 1_000));
    getHook()({ type: "network" });
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(manager.isReplayRecording()).toBe(false);

    // The user returns shortly after — no gap, no cap (rotation refreshed
    // both clocks) — yet replay still revives on the activity signal.
    getHook()({ type: "dom.event" });
    expect(mockSetSessionId).toHaveBeenCalledTimes(1); // no second rotation
    expect(manager.isReplayRecording()).toBe(true);
  });

  it("raw input (scroll-only engagement) keeps the session alive — no spurious gap rotation mid-engagement", () => {
    manager.startReplayRecording();
    mockLastActivityState.value = Date.now();

    // 40 minutes of scroll-only engagement: zero activity-type SDK events
    // (no clicks), but raw input keeps hitting the presence listeners and
    // stamping the activity clock.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(5 * 60 * 1000);
      window.dispatchEvent(new Event("scroll"));
    }

    // …so the eventual click does NOT gap-rotate.
    getHook()({ type: "dom.event" });
    expect(mockSetSessionId).not.toHaveBeenCalled();
    expect(manager.isReplayRecording()).toBe(true);
  });

  it("presence input after a gap rotates the session and revives replay without any SDK event", () => {
    manager.startReplayRecording();
    openGap();
    expect(manager.isReplayRecording()).toBe(false);

    window.dispatchEvent(new Event("pointerdown"));

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(manager.isReplayRecording()).toBe(true);
  });

  it("a programmatic startReplayRecording into an open gap rotates BEFORE recording — replay never starts under the stale session", () => {
    // User last active, then 31 min idle: the gap is open but rotation is lazy
    // (nothing has signalled yet).
    mockLastActivityState.value = Date.now();
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS + 60_000);
    mockSetSessionId.mockClear();
    mockEmitCallback = null;

    // The app starts replay programmatically (e.g. a consent callback). The
    // gap must be resolved up front, so rrweb begins under the FRESH session —
    // not the one that ended at the last activity.
    manager.startReplayRecording();
    expect(mockSetSessionId).toHaveBeenCalledTimes(1); // rotated before recording
    expect(manager.isReplayRecording()).toBe(true);
    // rrweb's recording started only after the rotation (the listener's emit
    // callback is wired during startReplayListener, which runs post-rotation).
    expect(mockEmitCallback).not.toBeNull();

    // The returning scroll seconds later doesn't double-rotate: the rotation
    // already reset the activity clock.
    window.dispatchEvent(new Event("scroll"));
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("a programmatic startReplayRecording into an ACTIVE session records in place (no rotation)", () => {
    // Recent activity → no open gap → the explicit start must not rotate.
    mockLastActivityState.value = Date.now();
    mockSetSessionId.mockClear();

    manager.startReplayRecording();

    expect(mockSetSessionId).not.toHaveBeenCalled();
    expect(manager.isReplayRecording()).toBe(true);
  });

  it("a duplicate startReplayRecording while already recording is a no-op — never rotates, even past the cap", () => {
    // Recording active and the session is already past the cap (long-lived
    // continuous recording). A redundant start call must NOT rotate.
    mockLastActivityState.value = Date.now();
    manager.startReplayRecording();
    expect(manager.isReplayRecording()).toBe(true);

    mockGetSessionStartTime.mockReturnValue(msToNs(Date.now() - FOUR_HOURS_MS - 1_000));
    mockSetSessionId.mockClear();

    manager.startReplayRecording(); // duplicate

    expect(mockSetSessionId).not.toHaveBeenCalled();
    expect(manager.isReplayRecording()).toBe(true);
  });

  it("a programmatic startReplayRecording into a cap-exceeded session rotates BEFORE recording (stale = gap OR cap)", () => {
    // Recent activity (no gap) but the session started >4h ago — over the cap,
    // so it's stale and replay must not begin under it.
    mockLastActivityState.value = Date.now();
    mockGetSessionStartTime.mockReturnValue(msToNs(Date.now() - FOUR_HOURS_MS - 1_000));
    mockSetSessionId.mockClear();
    mockEmitCallback = null;

    manager.startReplayRecording();

    expect(mockSetSessionId).toHaveBeenCalledTimes(1); // rotated before recording
    expect(manager.isReplayRecording()).toBe(true);
    expect(mockEmitCallback).not.toBeNull(); // rrweb wired only after the rotation
  });

  it("does not revive an explicitly stopped replay on presence input", () => {
    manager.startReplayRecording();
    manager.stopReplayRecording();

    vi.advanceTimersByTime(60_000); // clear the presence throttle window
    window.dispatchEvent(new Event("pointerdown"));

    expect(manager.isReplayRecording()).toBe(false);
  });

  it("throttles presence signals", () => {
    window.dispatchEvent(new Event("mousemove"));
    expect(mockSetLastActivityMs).toHaveBeenCalledTimes(1);

    // Within the throttle window: ignored.
    vi.advanceTimersByTime(1_000);
    window.dispatchEvent(new Event("mousemove"));
    expect(mockSetLastActivityMs).toHaveBeenCalledTimes(1);

    // Past it: handled again.
    vi.advanceTimersByTime(30_000);
    window.dispatchEvent(new Event("mousemove"));
    expect(mockSetLastActivityMs).toHaveBeenCalledTimes(2);
  });

  it("uninstrument removes the presence listeners", () => {
    manager.uninstrument();

    window.dispatchEvent(new Event("pointerdown"));

    expect(mockSetLastActivityMs).not.toHaveBeenCalled();
  });
});

describe("InstrumentationManager - ghost-session send gate", () => {
  let manager: InstrumentationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();

    manager = createManager();
    manager.instrument();
  });

  afterEach(() => {
    manager.uninstrument();
    vi.useRealTimers();
  });

  it("installs a flush gate bound to hasUserActivity on instrument()", () => {
    expect(mockSetFlushGate).toHaveBeenCalledTimes(1);
    const gate = mockSetFlushGate.mock.calls[0]![0] as () => boolean;
    expect(typeof gate).toBe("function");
    mockLastActivityState.value = 0;
    expect(gate()).toBe(false);
    mockLastActivityState.value = Date.now();
    expect(gate()).toBe(true);
  });

  it("clears the flush gate on uninstrument()", () => {
    manager.uninstrument();
    expect(mockSetFlushGate).toHaveBeenLastCalledWith(null);
  });

  it("clears the flush gate only AFTER teardown enqueues, so an unconfirmed session's final replay batch stays gated", () => {
    // uninstrument() tears down the replay listener, whose stop path enqueues one
    // final batch via addEvent. That enqueue must happen while the gate is still
    // installed, else it leaks out of an unconfirmed session once the gate clears.
    manager.startReplayRecording();
    mockEmitCallback?.("evt"); // buffer a frame so stopRecording() emits a final batch
    mockAddEvent.mockClear();
    mockSetFlushGate.mockClear();

    manager.uninstrument();

    const teardownEnqueueOrder = mockAddEvent.mock.invocationCallOrder.at(-1);
    const gateNullIdx = mockSetFlushGate.mock.calls.findIndex((c) => c[0] === null);
    const gateNullOrder = mockSetFlushGate.mock.invocationCallOrder[gateNullIdx];
    expect(teardownEnqueueOrder).toBeDefined();
    expect(gateNullOrder).toBeDefined();
    expect(teardownEnqueueOrder!).toBeLessThan(gateNullOrder!);
  });

  it("confirms on raw input presence (scroll)", () => {
    window.dispatchEvent(new Event("scroll"));
    expect(mockLastActivityState.value > 0).toBe(true);
  });

  it("pageload is a no-op for presence — a scroll right after load still confirms", () => {
    // pageload is not an activity event, so it neither confirms the session nor
    // pokes the presence monitor.
    getHook()({ type: "pageload" });
    expect(mockLastActivityState.value > 0).toBe(false);

    // A genuine scroll right after load therefore confirms normally — nothing
    // pinned the raw-input throttle, so a scroll-only session is never dropped.
    window.dispatchEvent(new Event("scroll"));
    expect(mockLastActivityState.value > 0).toBe(true);
  });

  it("does NOT revive paused replay on a navigation (not an activity event) — only presence does", () => {
    // Replay recording, then idle → paused. A navigation is not an activity event,
    // so it must NOT revive the recording (that would record an empty screen);
    // revival keys off the same presence signal as the gate. A dom.event revives.
    manager.startReplayRecording();
    mockLastActivityState.value = Date.now();
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS + 1);
    expect(manager.isReplayRecording()).toBe(false);

    getHook()({ type: "navigation" });
    expect(manager.isReplayRecording()).toBe(false);

    getHook()({ type: "dom.event" });
    expect(manager.isReplayRecording()).toBe(true);
  });
});
