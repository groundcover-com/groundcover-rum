import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { msToNs } from "../common/global";
import { EventsPool, type FlushGate } from "../events/events-pool";
import { IdGenerator } from "../common/id-generator";
import { BaseEvent } from "../events/types";
import { SessionLifecycle, SessionLifecycleDeps } from "./session-lifecycle";
import { SessionState } from "./session-state";

// These are the drift-critical session POLICY tests (rotation, reconciliation,
// the ghost-session send gate). Everything here is platform-free — fake
// session/pool/idGenerator/hooks, injected event-kind sets — so every
// platform inherits this exact suite. Platform-specific presence sources
// (e.g. raw input) are tested by the platform package that wires them.

const mockLog = vi.fn();
vi.mock("../common/logger", () => ({
  Logger: {
    getInstance: () => ({ log: mockLog }),
    initialize: () => ({ log: mockLog }),
  },
}));

vi.mock("../common/error-handler", () => ({
  handleError: vi.fn(),
}));

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
// Roughly the skew of a device clock about 12 years fast.
const TWELVE_YEARS_MS = 12 * 365 * 24 * 60 * 60 * 1000;

// ── Fake pool ───────────────────────────────────────────────────────────────
const mockFlush = vi.fn();
const mockDiscardBuffer = vi.fn();
const mockSetBeforeEnqueueHook = vi.fn();
const mockSetFlushGate = vi.fn();
// Events the drain left behind. Non-null only on the no-cluster retention
// path, where flush() returns without emptying the buffer.
//
// Deliberately NAIVE: it ignores the (nowNs, maxAgeNs) the real pool filters
// by, so these tests exercise the lifecycle's own re-check of the value rather
// than inheriting the pool's. A faithful fake would hide that path entirely.
const mockGetEarliestEventTimestamp = vi.fn<() => number | null>(() => null);
const fakePool = {
  flush: mockFlush,
  discardBuffer: mockDiscardBuffer,
  setBeforeEnqueueHook: mockSetBeforeEnqueueHook,
  setFlushGate: mockSetFlushGate,
  getEarliestEventTimestamp: mockGetEarliestEventTimestamp,
} as unknown as EventsPool;

// ── Fake session state ──────────────────────────────────────────────────────
// Mirrors the real SessionState's single activity signal: a session is born
// UNCONFIRMED (clock 0), any genuine presence stamps it via setLastActivityMs
// — a stamped clock (>0) IS the confirmation. Birth (setSessionStartTime)
// resets it to 0.
const sessionData = {
  id: "previous-session-id",
  startNs: 0,
  lastActivityMs: 0,
  maxDurationMs: FOUR_HOURS_MS,
};
const mockSetSessionId = vi.fn((id: string) => {
  sessionData.id = id;
});
const mockSetSessionStartTime = vi.fn((startNs: number) => {
  sessionData.startNs = startNs;
  sessionData.lastActivityMs = 0;
});
const mockSetLastActivityMs = vi.fn((nowMs: number) => {
  sessionData.lastActivityMs = nowMs;
});
const fakeSession = {
  getSessionId: () => sessionData.id,
  setSessionId: mockSetSessionId,
  getSessionStartTime: () => sessionData.startNs,
  setSessionStartTime: mockSetSessionStartTime,
  getLastActivityMs: () => sessionData.lastActivityMs,
  setLastActivityMs: mockSetLastActivityMs,
  hasUserActivity: () => sessionData.lastActivityMs > 0,
  getSessionMaxDuration: () => sessionData.maxDurationMs,
  // Mirror the real elapsed/cap/gap rules off the controllable fake state.
  getSessionElapsedMs: (nowMs: number = Date.now()) =>
    sessionData.startNs ? nowMs - sessionData.startNs / 1_000_000 : 0,
  isSessionExpired: (nowMs: number = Date.now()) => {
    if (!sessionData.startNs) return false;
    return nowMs - sessionData.startNs / 1_000_000 >= sessionData.maxDurationMs;
  },
  isSessionInactive: (nowMs: number = Date.now()) => {
    const base =
      sessionData.lastActivityMs > 0
        ? sessionData.lastActivityMs
        : sessionData.startNs / 1_000_000;
    return base > 0 && nowMs - base >= INACTIVITY_TIMEOUT_MS;
  },
} as unknown as SessionState;

// ── Fake id generator + hooks ───────────────────────────────────────────────
const mockGenerateId = vi.fn(() => "new-session-id");
const fakeIdGenerator = { generateId: mockGenerateId } as unknown as IdGenerator;

const hookBeforeRotate = vi.fn();
const hookAfterRotate = vi.fn();
const hookOnReconcile = vi.fn();
const hookOnPresenceStamped = vi.fn();
// Host-side rotation-context fake (a platform's context might be "was a
// recorder active?" — here it's just an opaque boolean the lifecycle must
// round-trip from captureRotationContext to afterRotate).
const recorderState = { active: false };
const hookCaptureRotationContext = vi.fn(() => recorderState.active);

const createLifecycle = (overrides: Partial<SessionLifecycleDeps<boolean>> = {}) =>
  new SessionLifecycle<boolean>({
    session: fakeSession,
    pool: fakePool,
    idGenerator: fakeIdGenerator,
    // Platform-injected presence classification (core has no defaults):
    // each platform passes its own sets. Here "activity" is the user-activity
    // kind and "heartbeat" a platform-emitted kind the policy must ignore.
    activityEventTypes: new Set<BaseEvent["type"]>(["activity"]),
    ignoredEventTypes: new Set<BaseEvent["type"]>(["heartbeat"]),
    hooks: {
      captureRotationContext: hookCaptureRotationContext,
      beforeRotate: hookBeforeRotate,
      afterRotate: hookAfterRotate,
      onReconcile: hookOnReconcile,
      onPresenceStamped: hookOnPresenceStamped,
    },
    ...overrides,
  });

// A fake enqueued event. The timestamp fields mirror EventEnricher's only
// branch: `network` gets a top-level start_timestamp and NO timestamp, every
// other type gets a timestamp. Both are nanoseconds.
type FakeEvent = { type: string; timestamp?: number; start_timestamp?: number };

// The beforeEnqueue hook the lifecycle registers on install(). Invoking the
// returned fn simulates an event landing in EventsPool.addEvent (defaults to
// a user-activity event; pass { type: "heartbeat" } to simulate an ignored
// platform heartbeat).
const getHook = (): ((event?: FakeEvent) => void) => {
  const hook = mockSetBeforeEnqueueHook.mock.calls.at(-1)?.[0];
  if (typeof hook !== "function") throw new Error("hook not registered");
  return (event = { type: "activity" }) => (hook as (e: unknown) => void)(event);
};

const resetAll = () => {
  mockFlush.mockReset();
  mockDiscardBuffer.mockClear();
  mockSetBeforeEnqueueHook.mockClear();
  mockSetFlushGate.mockClear();
  mockSetSessionId.mockClear();
  mockSetSessionStartTime.mockClear();
  mockSetLastActivityMs.mockClear();
  mockGetEarliestEventTimestamp.mockClear();
  mockGetEarliestEventTimestamp.mockReturnValue(null);
  mockGenerateId.mockClear();
  hookBeforeRotate.mockReset();
  hookAfterRotate.mockReset();
  hookCaptureRotationContext.mockClear();
  hookOnReconcile.mockClear();
  hookOnPresenceStamped.mockClear();
  mockLog.mockClear();
  recorderState.active = false;
  sessionData.id = "previous-session-id";
  sessionData.startNs = 0;
  sessionData.lastActivityMs = 0;
  sessionData.maxDurationMs = FOUR_HOURS_MS;
};

const tripCap = () => {
  sessionData.startNs = msToNs(Date.now() - FOUR_HOURS_MS - 1_000);
};

// Record activity, then advance the clock past the idle window.
const openGap = () => {
  sessionData.lastActivityMs = Date.now();
  vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS + 1);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetAll();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionLifecycle - pool wiring (install/teardown)", () => {
  it("registers a beforeEnqueue hook on install()", () => {
    createLifecycle().install();
    expect(mockSetBeforeEnqueueHook).toHaveBeenCalledTimes(1);
    expect(typeof mockSetBeforeEnqueueHook.mock.calls[0]![0]).toBe("function");
  });

  it("uninstall() clears the hook FIRST, runs the host teardown, then clears the gate LAST", () => {
    const lifecycle = createLifecycle();
    lifecycle.install();

    const order: string[] = [];
    mockSetBeforeEnqueueHook.mockImplementation((hook) => {
      if (hook === null) order.push("hook-cleared");
    });
    mockSetFlushGate.mockImplementation((gate) => {
      if (gate === null) order.push("gate-cleared");
    });

    lifecycle.uninstall(() => order.push("host-teardown"));

    expect(order).toEqual(["hook-cleared", "host-teardown", "gate-cleared"]);
  });

  it("uninstall() still clears the gate when the host teardown throws", () => {
    const lifecycle = createLifecycle();
    lifecycle.install();

    lifecycle.uninstall(() => {
      throw new Error("listener teardown failed");
    });

    expect(mockSetBeforeEnqueueHook).toHaveBeenLastCalledWith(null);
    expect(mockSetFlushGate).toHaveBeenLastCalledWith(null);
  });

  it("installs a flush gate bound to hasUserActivity on install()", () => {
    createLifecycle().install();
    expect(mockSetFlushGate).toHaveBeenCalledTimes(1);
    const gate = mockSetFlushGate.mock.calls[0]![0] as FlushGate;
    expect(typeof gate).toBe("function");
    sessionData.lastActivityMs = 0;
    expect(gate({ lifecycle: false, events: [] })).toBe(false);
    expect(gate({ lifecycle: true, events: [] })).toBe(false);
    sessionData.lastActivityMs = Date.now();
    expect(gate({ lifecycle: false, events: [] })).toBe(true);
  });

  it("uninstall() with no host teardown clears both observation points", () => {
    const lifecycle = createLifecycle();
    lifecycle.install();
    lifecycle.uninstall();
    expect(mockSetBeforeEnqueueHook).toHaveBeenLastCalledWith(null);
    expect(mockSetFlushGate).toHaveBeenLastCalledWith(null);
  });

  // Core ships no default activity or ignored event types — presence
  // classification is platform-injected via the required
  // activityEventTypes/ignoredEventTypes deps. That the injected sets drive
  // classification is covered by "classifies presence via custom
  // activityEventTypes" and the heartbeat ignore tests below.
});

describe("SessionLifecycle - max-duration rotation decision", () => {
  beforeEach(() => {
    createLifecycle().install();
  });

  it("does not rotate when the session start time is not yet recorded", () => {
    sessionData.startNs = 0;

    getHook()();

    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it("does not rotate while elapsed time is below the cap", () => {
    sessionData.startNs = msToNs(Date.now());

    getHook()();

    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it("rotates once the cap is reached", () => {
    tripCap();

    getHook()();

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockSetSessionStartTime).toHaveBeenCalledTimes(1);
  });

  it("ignores heartbeat events even past the cap (no rotation on a platform heartbeat)", () => {
    tripCap();

    getHook()({ type: "heartbeat" });

    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it("applies the default cap when sessionMaxDuration is omitted", () => {
    // getSessionMaxDuration always returns a value (defaults to 4h); there is
    // no "feature off" state, so the lazy check is always armed.
    sessionData.maxDurationMs = FOUR_HOURS_MS;
    // Recent activity → no inactivity gap, so this isolates the max-duration cap.
    sessionData.lastActivityMs = Date.now();

    // 3h elapsed → below default cap → no rotation.
    sessionData.startNs = msToNs(Date.now() - 3 * 60 * 60 * 1000);
    getHook()();
    expect(mockSetSessionId).not.toHaveBeenCalled();

    // 5h elapsed → past default cap → rotation.
    sessionData.startNs = msToNs(Date.now() - 5 * 60 * 60 * 1000);
    getHook()();
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("short-circuits a re-entrant hook call during rotation (isRotating guard)", () => {
    tripCap();

    // Simulate beforeRotate/flush enqueuing an event mid-rotation, which would
    // re-fire the hook. The guard must prevent a recursive rotation.
    const hook = getHook();
    // Confirmed → rotation flushes (the step that re-enters via the mock below).
    sessionData.lastActivityMs = Date.now();
    mockFlush.mockImplementationOnce(() => hook());

    hook();

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("exposes isRotating=true only while a rotation is in progress", () => {
    const lifecycle = createLifecycle();
    expect(lifecycle.isRotating).toBe(false);

    let duringRotation: boolean | null = null;
    hookBeforeRotate.mockImplementationOnce(() => {
      duringRotation = lifecycle.isRotating;
    });

    lifecycle.rotate({ reason: "test" });

    expect(duringRotation).toBe(true);
    expect(lifecycle.isRotating).toBe(false);
  });
});

describe("SessionLifecycle - rotation orchestration", () => {
  beforeEach(() => {
    createLifecycle().install();
  });

  it("runs beforeRotate, flushes, then rotates ids — in that order", () => {
    tripCap();
    // Confirmed session → rotation flushes stragglers under the old id (vs.
    // discarding an unconfirmed ghost session's buffer).
    sessionData.lastActivityMs = Date.now();

    getHook()();

    const stopOrder = hookBeforeRotate.mock.invocationCallOrder[0];
    const flushOrder = mockFlush.mock.invocationCallOrder[0];
    const setIdOrder = mockSetSessionId.mock.invocationCallOrder[0];
    const afterOrder = hookAfterRotate.mock.invocationCallOrder[0];

    expect(stopOrder).toBeDefined();
    expect(flushOrder).toBeDefined();
    expect(setIdOrder).toBeDefined();
    expect(afterOrder).toBeDefined();
    expect(stopOrder!).toBeLessThan(flushOrder!);
    expect(flushOrder!).toBeLessThan(setIdOrder!);
    expect(setIdOrder!).toBeLessThan(afterOrder!);
  });

  it("flips the id first, then the start time — the flip resets the activity clock", () => {
    tripCap();
    sessionData.lastActivityMs = Date.now();

    getHook()({ type: "network" });

    // setSessionId → setSessionStartTime, and the birth reset leaves the new
    // session unconfirmed (a pre-gap lastActivity can't instantly gap-rotate it).
    const setIdOrder = mockSetSessionId.mock.invocationCallOrder[0];
    const setStartOrder = mockSetSessionStartTime.mock.invocationCallOrder[0];
    expect(setIdOrder!).toBeLessThan(setStartOrder!);
    expect(mockSetSessionId).toHaveBeenCalledWith("new-session-id");
    // network is not presence, so nothing re-stamped the clock after the flip.
    expect(sessionData.lastActivityMs).toBe(0);
  });

  it("captures the rotation context BEFORE beforeRotate and passes it to afterRotate", () => {
    recorderState.active = true;
    // beforeRotate stops the host's recorder — the captured context must
    // predate that.
    hookBeforeRotate.mockImplementationOnce(() => {
      recorderState.active = false;
    });
    tripCap();

    getHook()();

    expect(hookCaptureRotationContext).toHaveBeenCalledTimes(1);
    const captureOrder = hookCaptureRotationContext.mock.invocationCallOrder[0];
    const beforeOrder = hookBeforeRotate.mock.invocationCallOrder[0];
    expect(captureOrder!).toBeLessThan(beforeOrder!);
    expect(hookAfterRotate).toHaveBeenCalledTimes(1);
    expect(hookAfterRotate).toHaveBeenCalledWith(true);
  });

  it("passes the captured context to afterRotate when it was falsy at rotation time", () => {
    recorderState.active = false;
    tripCap();

    getHook()();

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(hookAfterRotate).toHaveBeenCalledWith(false);
  });

  it("still rotates ids if flush throws", () => {
    mockFlush.mockImplementationOnce(() => {
      throw new Error("flush failed");
    });
    tripCap();
    // Confirmed → the rotation takes the flush branch (the one that throws here).
    sessionData.lastActivityMs = Date.now();

    getHook()();

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockSetSessionStartTime).toHaveBeenCalledTimes(1);
  });

  it("still rotates ids if beforeRotate throws (step isolation)", () => {
    hookBeforeRotate.mockImplementationOnce(() => {
      throw new Error("beforeRotate failed");
    });
    tripCap();

    getHook()();

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(hookAfterRotate).toHaveBeenCalledTimes(1);
  });

  it("still rotates ids if captureRotationContext throws (step isolation)", () => {
    hookCaptureRotationContext.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    tripCap();

    getHook()();

    // The rotation completes; afterRotate still runs, with an undefined
    // context since the capture never produced one.
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(hookBeforeRotate).toHaveBeenCalledTimes(1);
    expect(hookAfterRotate).toHaveBeenCalledWith(undefined);
  });

  // `rotating` is set before the host hooks run, so an escape between the flag
  // and the `finally` would wedge it true forever and turn every later
  // reconcile()/rotate() into a silent no-op for the whole process lifetime.
  // The outer catches in EventsPool/user-presence-monitor
  // swallow the throw but cannot reset the flag.
  it("never strands `rotating` when a host hook throws", () => {
    const lifecycle = createLifecycle();
    lifecycle.install();
    hookCaptureRotationContext.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    tripCap();

    getHook()();

    expect(lifecycle.isRotating).toBe(false);

    // ...and a subsequent rotation still works rather than being skipped.
    mockSetSessionId.mockClear();
    tripCap();
    getHook()();
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("labels a gap rotation 'inactivity gap' and a cap rotation 'max session duration'", () => {
    openGap();
    getHook()({ type: "activity" });
    expect(mockLog).toHaveBeenCalledWith(
      "[session-lifecycle] session rotation start",
      expect.objectContaining({ reason: "inactivity gap" }),
    );

    mockLog.mockClear();
    tripCap();
    getHook()({ type: "network" });
    expect(mockLog).toHaveBeenCalledWith(
      "[session-lifecycle] session rotation start",
      expect.objectContaining({ reason: "max session duration" }),
    );
  });
});

// A rotated session must never start AFTER an event that belongs to it:
// consumers derive session duration from last event - session_start_time, so an
// inverted pair yields a negative duration.
//
// The new start is therefore the earliest trusted time that belongs to the new
// session — the rotation instant, the event that triggered the rotation, or an
// event the drain left behind — instead of a blind second Date.now() read.
describe("SessionLifecycle - rotated session start time", () => {
  beforeEach(() => {
    createLifecycle().install();
  });

  // EventEnricher stamps the event (Date.now() #1), then addEvent ->
  // onBeforeEnqueue -> reconcile -> rotate would stamp the start (Date.now() #2)
  // after logging, a drain, two host hooks and three storage writes, so a
  // clock-stamped start would postdate the event that OPENED the session.
  it("stamps a rotated session's start from the event that triggered it", () => {
    const nowMs = Date.now();
    const eventNs = msToNs(nowMs - 3);
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: eventNs });

    expect(mockSetSessionStartTime).toHaveBeenCalledWith(eventNs);
  });

  it("stamps from the current clock when the rotation was not driven by an event", () => {
    const lifecycle = createLifecycle();
    sessionData.lastActivityMs = Date.now();
    tripCap();

    lifecycle.rotateIfStale(Date.now(), "host start into stale session");

    expect(mockSetSessionStartTime).toHaveBeenCalledWith(msToNs(Date.now()));
  });

  it("stamps from a network event's start_timestamp, which carries no timestamp at all", () => {
    const nowMs = Date.now();
    const startNs = msToNs(nowMs - 40);
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: undefined, start_timestamp: startNs });

    expect(mockSetSessionStartTime).toHaveBeenCalledWith(startNs);
  });

  // See the browser SDK's docs/session-lifecycle.md: flush() returns WITHOUT draining when no
  // cluster is configured, so a rotation mid-hold strands events that will ship under the NEW id.
  it("backdates a rotated session's start to cover events the drain left behind", () => {
    const nowMs = Date.now();
    const strandedNs = msToNs(nowMs - 2_000);
    mockGetEarliestEventTimestamp.mockReturnValue(strandedNs);
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: msToNs(nowMs) });

    expect(mockSetSessionStartTime).toHaveBeenCalledWith(strandedNs);
  });

  it("prefers the earliest of the triggering event and the retained buffer", () => {
    const nowMs = Date.now();
    const eventNs = msToNs(nowMs - 5_000);
    mockGetEarliestEventTimestamp.mockReturnValue(msToNs(nowMs - 1_000));
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: eventNs });

    expect(mockSetSessionStartTime).toHaveBeenCalledWith(eventNs);
  });

  // A device clock years fast can stamp a start far ahead while the events are
  // real. A future start defeats the cap check (elapsed goes negative, so
  // isSessionExpired never fires), but a confirmed session still gap-rotates,
  // and that rotation must land on the returning event's time.
  it("stamps from the event when rotating out of a future-dated session", () => {
    const nowMs = Date.now();
    sessionData.startNs = msToNs(nowMs + TWELVE_YEARS_MS);
    sessionData.lastActivityMs = nowMs;
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS + 1);
    const eventNs = msToNs(Date.now() - 2);

    getHook()({ type: "activity", timestamp: eventNs });

    expect(mockSetSessionStartTime).toHaveBeenCalledWith(eventNs);
  });

  // Trust window. This writes the POLICY clock (cap + inactivity), not just a
  // wire value, so an untrusted candidate is far more dangerous than a wrong
  // attribute — see the rotation-storm test below.
  it("ignores an implausibly old event timestamp instead of stamping the session in 1970", () => {
    const nowMs = Date.now();
    tripCap();
    sessionData.lastActivityMs = nowMs;

    // An enrichEvent that forgot msToNs: milliseconds where nanoseconds belong,
    // which as a nanosecond value lands in January 1970.
    getHook()({ type: "network", timestamp: nowMs });

    expect(mockSetSessionStartTime).toHaveBeenCalledWith(msToNs(nowMs));
  });

  // Without the floor above, the bogus start puts the session instantly past
  // its cap, so the NEXT event rotates again — minting a new session id per
  // event. `rotating` guards re-entrancy within one rotation, not across
  // successive ones.
  it("does not rotate repeatedly when events carry bogus old timestamps", () => {
    const nowMs = Date.now();
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: nowMs });
    getHook()({ type: "network", timestamp: nowMs });
    getHook()({ type: "network", timestamp: nowMs });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("ignores future-dated, zero, negative and non-numeric event timestamps", () => {
    const untrusted = [
      msToNs(Date.now() + 60_000),
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "nope" as unknown as number,
    ];

    for (const timestamp of untrusted) {
      resetAll();
      createLifecycle().install();
      tripCap();
      sessionData.lastActivityMs = Date.now();

      expect(() => getHook()({ type: "network", timestamp })).not.toThrow();
      expect(mockSetSessionStartTime).toHaveBeenCalledWith(msToNs(Date.now()));
    }
  });

  // A derived start must never make the session it opens retroactively STALE.
  //
  // The window therefore can't just be the cap: adopting a candidate older than
  // the inactivity window would leave the fresh session already gap-stale, so
  // the next genuine interaction rotates again — and that rotation sees
  // wasConfirmed=false (birth reset the clock) and DISCARDS the buffer, losing
  // the events the first rotation had just queued.
  it("ignores a retained event old enough to make the rotated session instantly stale", () => {
    const nowMs = Date.now();
    mockGetEarliestEventTimestamp.mockReturnValue(msToNs(nowMs - INACTIVITY_TIMEOUT_MS - 1_000));
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: msToNs(nowMs) });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockSetSessionStartTime).toHaveBeenLastCalledWith(msToNs(nowMs));

    // The returning interaction must neither rotate again nor discard the buffer.
    getHook()({ type: "activity", timestamp: msToNs(Date.now()) });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockDiscardBuffer).not.toHaveBeenCalled();
  });

  // The window's lower bound is STRICT, and this is what pins that. A candidate
  // sitting exactly ON the floor is the one value where "safe to adopt" is
  // borderline — at exactly one idle window back, isSessionInactive's `>=`
  // comparison already reads as stale.
  //
  // Both sides are computed the same way the production code computes them
  // (msToNs of the frozen clock, minus msToNs of the window), so the comparison
  // is bit-identical rather than relying on ns arithmetic that would round: at
  // this magnitude the float64 step is 256ns.
  it("rejects a retained event sitting exactly on the window floor", () => {
    const nowNs = msToNs(Date.now());
    const maxAgeNs = msToNs(INACTIVITY_TIMEOUT_MS);
    mockGetEarliestEventTimestamp.mockReturnValue(nowNs - maxAgeNs);
    tripCap();
    sessionData.lastActivityMs = Date.now();

    getHook()({ type: "network", timestamp: nowNs });

    expect(mockSetSessionStartTime).toHaveBeenLastCalledWith(nowNs);
  });

  it("still adopts a retained event comfortably inside the window", () => {
    const nowMs = Date.now();
    const retainedNs = msToNs(nowMs - 2_000);
    mockGetEarliestEventTimestamp.mockReturnValue(retainedNs);
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: msToNs(nowMs) });

    expect(mockSetSessionStartTime).toHaveBeenLastCalledWith(retainedNs);
  });

  it("keeps the birth activity-clock reset intact (the rotated session stays unconfirmed)", () => {
    const nowMs = Date.now();
    tripCap();
    sessionData.lastActivityMs = nowMs;

    getHook()({ type: "network", timestamp: msToNs(nowMs - 3) });

    // network is not presence, so nothing re-stamped the clock after the flip —
    // the ghost-session send gate still holds for the new session.
    expect(sessionData.lastActivityMs).toBe(0);
  });
});

describe("SessionLifecycle - inactivity-gap rotation (lazy)", () => {
  beforeEach(() => {
    createLifecycle().install();
  });

  it("rotates on the first activity event after a gap", () => {
    openGap();
    expect(mockSetSessionId).not.toHaveBeenCalled();

    getHook()({ type: "activity" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("flushes under the old id before rotating on a gap", () => {
    // The pre-gap session was confirmed by prior activity → its stragglers
    // flush under the old id before the gap rotation swaps in a new one.
    // (openGap already stamped the clock, so the session is confirmed.)
    openGap();
    mockFlush.mockClear();

    getHook()({ type: "activity" });

    const flushOrder = mockFlush.mock.invocationCallOrder[0];
    const setIdOrder = mockSetSessionId.mock.invocationCallOrder[0];
    expect(flushOrder).toBeDefined();
    expect(setIdOrder).toBeDefined();
    expect(flushOrder!).toBeLessThan(setIdOrder!);
  });

  it("does not rotate on non-activity events after a gap", () => {
    openGap();

    getHook()({ type: "network" });
    getHook()({ type: "performance" });
    getHook()({ type: "log" });

    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it("does not rotate when no activity was ever recorded", () => {
    getHook()({ type: "activity" });

    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it("rotates exactly once per gap (the triggering event stamps a fresh activity clock)", () => {
    openGap();

    getHook()({ type: "activity" });
    getHook()({ type: "activity" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("stamps the activity clock for genuine activity only (the activity kind)", () => {
    getHook()({ type: "activity" });
    expect(mockSetLastActivityMs).toHaveBeenCalledTimes(1);

    mockSetLastActivityMs.mockClear();
    // Nothing else counts as presence: background/navigation fire unattended
    // or programmatically, and custom/network/performance/log/exception are
    // background traffic. Only the activity kind (or raw input) stamps the clock.
    getHook()({ type: "background" });
    getHook()({ type: "navigation" });
    getHook()({ type: "custom" });
    getHook()({ type: "network" });
    getHook()({ type: "performance" });
    getHook()({ type: "log" });
    getHook()({ type: "exception" });
    getHook()({ type: "heartbeat" });
    expect(mockSetLastActivityMs).not.toHaveBeenCalled();
  });

  it("does NOT gap-rotate on background / navigation after a gap — only genuine presence returns the user", () => {
    openGap();

    // background / navigation are not activity, so they can't stand in for
    // the user's return and rotate the session out of the gap.
    getHook()({ type: "background" });
    getHook()({ type: "navigation" });
    expect(mockSetSessionId).not.toHaveBeenCalled();

    // A genuine activity event does return the user → gap rotation fires.
    getHook()({ type: "activity" });
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("does not double-rotate when a gap and the cap expire together", () => {
    tripCap();
    openGap();

    getHook()({ type: "activity" });

    // Gap rotation runs first and refreshes the start time, so the cap check
    // in the same enqueue can't fire again.
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("classifies presence via custom activityEventTypes (another platform's taps plug into the same policy)", () => {
    // A platform whose interaction events use a different type swaps the set;
    // "activity" then stops being presence and the custom type takes over.
    createLifecycle({
      activityEventTypes: new Set(["ext.tap"]) as unknown as SessionLifecycleDeps["activityEventTypes"],
    }).install();
    openGap();

    getHook()({ type: "activity" });
    expect(mockSetSessionId).not.toHaveBeenCalled();

    getHook()({ type: "ext.tap" });
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockSetLastActivityMs).toHaveBeenCalled();
  });

  it("calls onReconcile with the presence verdict, and onPresenceStamped only after a genuine stamp", () => {
    const lifecycle = createLifecycle();
    const nowMs = Date.now();

    lifecycle.reconcile(nowMs, false);
    expect(hookOnReconcile).toHaveBeenLastCalledWith(false);
    expect(hookOnPresenceStamped).not.toHaveBeenCalled();
    expect(mockSetLastActivityMs).not.toHaveBeenCalled();

    lifecycle.reconcile(nowMs, true);
    expect(hookOnReconcile).toHaveBeenLastCalledWith(true);
    // The stamp precedes the hook — onPresenceStamped observes a stamped clock.
    expect(mockSetLastActivityMs).toHaveBeenCalledWith(nowMs);
    expect(hookOnPresenceStamped).toHaveBeenCalledWith(nowMs);
    const stampOrder = mockSetLastActivityMs.mock.invocationCallOrder[0];
    const hookOrder = hookOnPresenceStamped.mock.invocationCallOrder[0];
    expect(stampOrder!).toBeLessThan(hookOrder!);
  });

  it("reconcile short-circuits while a rotation is in progress", () => {
    const lifecycle = createLifecycle();
    tripCap();
    sessionData.lastActivityMs = Date.now();
    // A presence signal arriving mid-rotation (e.g. re-entrant flush) must not
    // reconcile — no stamp, no nested rotation.
    hookBeforeRotate.mockImplementationOnce(() => {
      lifecycle.reconcile(Date.now(), true);
    });
    mockSetLastActivityMs.mockClear();

    lifecycle.rotate({ reason: "max session duration" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockSetLastActivityMs).not.toHaveBeenCalled();
  });
});

describe("SessionLifecycle - ghost-session send gate", () => {
  beforeEach(() => {
    createLifecycle().install();
  });

  it("confirms the session (opens the gate) on an activity event", () => {
    getHook()({ type: "activity" });
    expect(sessionData.lastActivityMs > 0).toBe(true);
  });

  it("does NOT confirm on background or navigation (they fire unattended / programmatically)", () => {
    getHook()({ type: "background" });
    getHook()({ type: "navigation" });
    expect(sessionData.lastActivityMs > 0).toBe(false);
  });

  it("does NOT confirm on background traffic (network / custom / performance / log)", () => {
    getHook()({ type: "network" });
    getHook()({ type: "custom" });
    getHook()({ type: "performance" });
    getHook()({ type: "log" });
    expect(sessionData.lastActivityMs > 0).toBe(false);
  });

  it("stays confirmed across repeated interactions (idempotent, never un-confirms)", () => {
    getHook()({ type: "activity" });
    getHook()({ type: "activity" });
    getHook()({ type: "network" });
    expect(sessionData.lastActivityMs > 0).toBe(true);
  });

  it("discards (not flushes) the buffer when rotating out of an UNCONFIRMED session", () => {
    // Past the cap; a lone background network event triggers a cap rotation
    // while unconfirmed → the ghost buffer must be discarded, never sent.
    tripCap();

    getHook()({ type: "network" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockDiscardBuffer).toHaveBeenCalledTimes(1);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("flushes (not discards) the buffer when rotating out of a CONFIRMED session", () => {
    sessionData.lastActivityMs = Date.now();
    tripCap();

    getHook()({ type: "network" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockDiscardBuffer).not.toHaveBeenCalled();
  });

  it("discards (not flushes) when a genuine activity event rotates out of an UNCONFIRMED gapped session", () => {
    // Unconfirmed (clock 0) session whose gap is measured from sessionStartTime.
    // The returning activity event rotates FIRST (rotate sees wasConfirmed=false
    // → discards the ghost buffer), THEN setLastActivityMs confirms the fresh id.
    sessionData.startNs = msToNs(Date.now() - INACTIVITY_TIMEOUT_MS - 1);

    getHook()({ type: "activity" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockDiscardBuffer).toHaveBeenCalledTimes(1);
    expect(mockFlush).not.toHaveBeenCalled();
    expect(sessionData.lastActivityMs > 0).toBe(true);
  });
});

// releasesOnSuspend: the one exception to the ghost-session gate. A session no
// interaction confirmed is sent on the host's suspend flush when its buffer
// holds an event the platform names (the browser: an exception), so what it
// caught isn't lost when the user leaves untouched.
describe("SessionLifecycle - releasing an unconfirmed session on suspend", () => {
  const releasesExceptions = (event: BaseEvent) => event.type === "exception";
  const installedGate = (overrides: Partial<SessionLifecycleDeps<boolean>> = {}): FlushGate => {
    createLifecycle(overrides).install();
    return mockSetFlushGate.mock.calls[0]![0] as FlushGate;
  };
  const buffered = (...types: string[]) => types.map((type) => ({ type }) as BaseEvent);

  it("opens the suspend flush of an unconfirmed session holding a releasing event", () => {
    const gate = installedGate({ releasesOnSuspend: releasesExceptions });
    expect(gate({ lifecycle: true, events: buffered("pageload", "exception", "network") })).toBe(true);
  });

  it("holds every other send of that session (heartbeat, batch size, id flip)", () => {
    const gate = installedGate({ releasesOnSuspend: releasesExceptions });
    expect(gate({ lifecycle: false, events: buffered("pageload", "exception") })).toBe(false);
  });

  it("holds the suspend flush when nothing buffered releases it", () => {
    const gate = installedGate({ releasesOnSuspend: releasesExceptions });
    expect(gate({ lifecycle: true, events: buffered("pageload", "network", "log") })).toBe(false);
    expect(gate({ lifecycle: true, events: [] })).toBe(false);
  });

  it("without releasesOnSuspend the suspend flush stays held (a platform that hasn't adopted it)", () => {
    const gate = installedGate();
    expect(gate({ lifecycle: true, events: buffered("exception") })).toBe(false);
  });

  it("a throwing releasesOnSuspend releases nothing (the pool would fail a throwing gate open)", () => {
    const gate = installedGate({
      releasesOnSuspend: () => {
        throw new Error("bad predicate");
      },
    });
    expect(() => gate({ lifecycle: true, events: buffered("exception") })).not.toThrow();
    expect(gate({ lifecycle: true, events: buffered("exception") })).toBe(false);
  });

  it("a releasing event neither confirms the session nor counts as presence", () => {
    createLifecycle({ releasesOnSuspend: releasesExceptions }).install();

    getHook()({ type: "exception" });

    expect(sessionData.lastActivityMs > 0).toBe(false);
    expect(hookOnPresenceStamped).not.toHaveBeenCalled();
  });

  it("a confirmed session's sends are unaffected", () => {
    const gate = installedGate({ releasesOnSuspend: releasesExceptions });
    sessionData.lastActivityMs = Date.now();
    expect(gate({ lifecycle: false, events: buffered("pageload") })).toBe(true);
    expect(gate({ lifecycle: true, events: buffered("pageload") })).toBe(true);
  });

  it("an unconfirmed rotation still discards, releasing event or not", () => {
    createLifecycle({ releasesOnSuspend: releasesExceptions }).install();
    tripCap();

    getHook()({ type: "exception" });

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockDiscardBuffer).toHaveBeenCalledTimes(1);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("only the session current at install releases: one a rotation started does not", () => {
    const gate = installedGate({ releasesOnSuspend: releasesExceptions });
    // The cap passes in a tab nobody touches; background traffic rotates it.
    tripCap();
    getHook()({ type: "background" });
    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(sessionData.lastActivityMs > 0).toBe(false);

    expect(gate({ lifecycle: true, events: buffered("background", "exception") })).toBe(false);
  });

  it("a rotated session that interaction confirms sends as usual", () => {
    const gate = installedGate({ releasesOnSuspend: releasesExceptions });
    tripCap();
    getHook()({ type: "activity" });

    expect(gate({ lifecycle: true, events: buffered("activity") })).toBe(true);
    expect(gate({ lifecycle: false, events: buffered("activity") })).toBe(true);
  });
});

describe("SessionLifecycle - rotateIfStale", () => {
  it("rotates when the inactivity gap is open (stale = gap)", () => {
    const lifecycle = createLifecycle();
    sessionData.lastActivityMs = Date.now();
    vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS + 60_000);

    lifecycle.rotateIfStale(Date.now(), "host start into stale session");

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(
      "[session-lifecycle] session rotation start",
      expect.objectContaining({ reason: "host start into stale session" }),
    );
  });

  it("rotates when the session is past the cap (stale = gap OR cap)", () => {
    const lifecycle = createLifecycle();
    // Recent activity (no gap) but the session started >4h ago — over the cap.
    sessionData.lastActivityMs = Date.now();
    tripCap();

    lifecycle.rotateIfStale(Date.now(), "host start into stale session");

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
  });

  it("does not rotate a current session", () => {
    const lifecycle = createLifecycle();
    sessionData.lastActivityMs = Date.now();
    sessionData.startNs = msToNs(Date.now());

    lifecycle.rotateIfStale(Date.now(), "host start into stale session");

    expect(mockSetSessionId).not.toHaveBeenCalled();
  });
});
