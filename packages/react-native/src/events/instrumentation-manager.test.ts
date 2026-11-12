import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ConfigManager,
  EventEnricher,
  EventsPool,
  SafeStorage,
  SessionState,
  msToNs,
  type PlatformStorage,
} from "@groundcover/rum-core";
import * as core from "@groundcover/rum-core";
import { RNInstrumentationManager } from "./instrumentation-manager";
import { NetworkEventsListener } from "./listeners/network-events-listener";
import { InteractionListener } from "./listeners/interaction-listener";
import { AppStartListener } from "./listeners/app-start-listener";
import { VitalsEventsListener } from "./listeners/vitals-listener";
import { RNPresenceMonitor } from "./rn-presence-monitor";
import { createScreenHolder } from "../platform/rn-platform";
import type { RNEventType, ScreenAttributes, ScreenChange, ScreenHolder } from "./rn-event-types";
import type { RawGesture } from "../internal/touch-bridge";
import {
  __emitAppState,
  __emitNativeSignal,
  __failNextNativeRemove,
  __nativeListenerCount,
  __reset,
  __setAppState,
} from "../test-utils/react-native-stub";
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

/**
 * Wait until the manager's in-flight promise chain has settled.
 *
 * Not a callback on the outcome, because there is no outcome to hang one on: `flushFrameSegment` is
 * fired as `void ...then(...)` with no handle to await, and the behaviour under test is that a
 * late segment is DROPPED — so nothing is enqueued and no observable fires. Draining the microtask
 * queue is the boundary itself, and a macrotask is how you say that. Counting `Promise.resolve()`
 * ticks would encode the chain's current depth into the test.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function frameSegment(over: Record<string, unknown> = {}) {
  return {
    segmentStartMs: 1_000,
    segmentEndMs: 61_000,
    total: 300,
    slow: 30,
    frozen: 3,
    refreshRate: 60,
    delayMs: 240,
    budgetMs: 1000 / 60,
    // The safety close — the one that fires on elapsed time alone, with nobody there.
    reason: "safety" as const,
    ...over,
  };
}

function gesturePayload() {
  return {
    kind: "swipe" as const,
    startedAtMs: 1_000,
    endedAtMs: 1_200,
    startX: 10,
    startY: 20,
    endX: 110,
    endY: 20,
    direction: "right" as const,
    distanceDp: 100,
    velocityDpS: 500,
    pointerCount: 1,
  };
}

const swipe = { kind: "swipe" } as RawGesture;

function makeManager(
  opts: {
    nativeModule?: GroundcoverNativeModule | null;
    screenHolder?: ScreenHolder;
    options?: Record<string, unknown>;
  } = {}
) {
  const config = new ConfigManager();
  config.initialize({
    dsn: "d",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
    options: { transport: { batchSize: 0, compression: false }, ...opts.options },
  });
  const map = new Map<string, string>();
  const backing: PlatformStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  const session = new SessionState({ storage: new SafeStorage(backing) });
  const transporter = { send: vi.fn() };
  const pool = new EventsPool<RNEventType>({
    config,
    session,
    transporter: transporter as never,
    getDeviceAttributes: () => ({ source: "mobile-rum" }),
    eventsToSkipFlush: [],
  });
  pool.initialize();
  const enricher = new EventEnricher();
  const screenHolder = opts.screenHolder ?? createScreenHolder();
  const manager = new RNInstrumentationManager({
    config,
    session,
    eventsPool: pool,
    enricher,
    screenHolder,
    nativeModule: opts.nativeModule,
  });
  return { manager, screenHolder, pool, session, transporter };
}

describe("RNInstrumentationManager presence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __reset();
  });

  it.each(["active", "unknown"] as const)(
    "keeps events buffered after startup active notifications from %s until a touch",
    (initialState) => {
      __setAppState(initialState);
      const { manager, pool, session, transporter } = makeManager();
      try {
        manager.instrument();
        const event = {
          type: "performance" as const,
          id: "startup-event",
          spanId: "startup-span",
          parentSpanId: undefined,
          traceId: undefined,
          attributes: { performance_metric_name: "app_start_cold" },
        };
        pool.addEvent(event);
        expect(session.hasUserActivity()).toBe(false);
        expect(transporter.send).not.toHaveBeenCalled();

        __emitAppState("active");
        __emitAppState("active");
        pool.flush();

        expect(session.hasUserActivity()).toBe(false);
        expect(transporter.send).not.toHaveBeenCalled();

        manager.reportPresence(Date.now());
        pool.flush();

        expect(session.hasUserActivity()).toBe(true);
        expect(transporter.send).toHaveBeenCalledTimes(1);
        expect(transporter.send).toHaveBeenCalledWith(
          expect.objectContaining({ events: [event] })
        );
      } finally {
        manager.uninstrument();
        pool.destroy();
      }
    }
  );

  it.each(["background", "inactive"] as const)(
    "confirms presence when returning from %s without counting duplicate active notifications",
    (state) => {
      const { manager, pool, session } = makeManager();
      const stampPresence = vi.spyOn(session, "setLastActivityMs");
      try {
        manager.instrument();
        __emitAppState(state);
        expect(session.hasUserActivity()).toBe(false);
        expect(stampPresence).not.toHaveBeenCalled();

        __emitAppState("active");
        expect(session.hasUserActivity()).toBe(true);
        expect(stampPresence).toHaveBeenCalledTimes(1);

        __emitAppState("active");
        expect(stampPresence).toHaveBeenCalledTimes(1);
      } finally {
        manager.uninstrument();
        pool.destroy();
      }
    }
  );
});

describe("RNInstrumentationManager teardown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __reset();
  });

  it("isolates each teardown — one throwing destroy does not strand the others", () => {
    // presenceMonitor.destroy runs BEFORE networkEventsListener.destroy in
    // uninstrument. If they share one try/catch, presence's throw skips the XHR
    // restore and leaks the global patch. Isolated → the network destroy runs.
    vi.spyOn(RNPresenceMonitor.prototype, "destroy").mockImplementation(() => {
      throw new Error("presence teardown boom");
    });
    const netDestroy = vi.spyOn(NetworkEventsListener.prototype, "destroy");

    const { manager } = makeManager();
    manager.instrument();
    expect(() => manager.uninstrument()).not.toThrow();

    expect(netDestroy).toHaveBeenCalled();
  });

  it("instrument() is idempotent — a second call does not re-install listeners", () => {
    // Without a guard a second instrument() re-runs every listener.initialize()
    // and overwrites the listener references, orphaning the first set's global
    // patches (e.g. the XHR patch) so uninstrument() can no longer restore them.
    const netInit = vi.spyOn(NetworkEventsListener.prototype, "initialize");

    const { manager } = makeManager();
    manager.instrument();
    manager.instrument(); // must be a no-op

    expect(netInit).toHaveBeenCalledTimes(1);
    manager.uninstrument();
  });
});

// Reaching the app-start listener through a CAST to its union, `"Manual"` would select auto
// silently — `getInteractiveMark` reads the manual and auto marks from different places, so every
// `markAppInteractive()` call would be ignored. `resolveTtiSource` owns the check and
// is unit-tested in config/constants.test.ts; this asserts the MANAGER actually reads the option
// through it, which is the half a resolver test cannot prove.
describe("RNInstrumentationManager tti option", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __reset();
  });

  it("resolves an invalid tti value instead of casting it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // A native module is required: the app-start listener is armed by `instrumentNativeSignals`,
    // which no-ops on the Expo Go path.
    const { manager } = makeManager({
      nativeModule: nativeStub(),
      options: { native: { tti: "AUTO_DETECT" } },
    });
    manager.instrument();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("AUTO_DETECT");

    manager.uninstrument();
  });

  it("stays silent for a valid tti value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { manager } = makeManager({
      nativeModule: nativeStub(),
      options: { native: { tti: "manual" } },
    });
    manager.instrument();

    expect(warn).not.toHaveBeenCalled();

    manager.uninstrument();
  });
});

describe("RNInstrumentationManager native-signal lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __reset();
  });

  /**
   * The ghost-session guard, and THE reason `"performance"` is in `RN_IGNORED_EVENT_TYPES`.
   *
   * With both frame trackers armed, a frame segment can close with nobody there — the safety cap
   * fires on elapsed time alone. Counting that as a human being present is precisely the
   * ghost-session class of bug: a forgotten-but-foregrounded app (a kiosk, a phone on a desk)
   * rotating sessions forever.
   *
   * ROTATION is the mechanism, not the presence stamp: `reconcile` checks the wall-clock cap for
   * every signal that REACHES it, whatever `userPresent` says, and rotates when it has been
   * exceeded. So an unignored `performance` event is enough on its own to mint a new session with
   * nobody there — no presence, no interaction, just a segment closing on its safety cap.
   *
   * Asserted through the POOL rather than by reading the exported set, because the set is only half
   * the wiring — `RNInstrumentationManager` has to hand it to the lifecycle as `ignoredEventTypes`,
   * and a test that reads the constant passes with that wire cut. The `navigation` half is the
   * control: it proves the session really was rotatable at that moment, so the `performance` case
   * is a genuine exemption rather than a test that could not have failed.
   */
  it("an expired session is not rotated by a performance event, but is by a navigation event", () => {
    const { manager, pool, session } = makeManager();
    manager.instrument();
    const originalId = session.getSessionId();

    // Past the wall-clock cap. Nothing about this needs a user: on a
    // forgotten-but-foregrounded app the frame safety cap keeps closing segments
    // for as long as the screen is on.
    vi.spyOn(session, "getSessionElapsedMs").mockReturnValue(Number.MAX_SAFE_INTEGER);

    pool.addEvent({
      type: "performance",
      timestamp: 1,
      attributes: { performance_metric_name: "frames_delay_total" },
    } as never);
    expect(session.getSessionId()).toBe(originalId);

    pool.addEvent({ type: "navigation", timestamp: 2, attributes: {} } as never);
    expect(session.getSessionId()).not.toBe(originalId);

    manager.uninstrument();
  });

  /**
   * The other half of the test above: exempted from rotation, the heartbeat would be free to grow
   * the session forever instead, so it has to stop EMITTING. Driven through the real
   * SessionState and native router, since a test that built the listener itself passes with the wire cut.
   */
  it("stops emitting frame vitals once the session goes quiet, and resumes when the user returns", () => {
    const { manager, pool, session } = makeManager({ nativeModule: nativeStub() });
    manager.instrument();

    const addEvent = vi.spyOn(pool, "addEvent");
    const vitalsShipped = () =>
      addEvent.mock.calls.filter(
        ([event]) => (event as { type?: string } | null)?.type === "performance"
      ).length;
    const closeSegment = () =>
      __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "frame_segment", payload: frameSegment() });

    // A confirmed, current session: the heartbeat is a legitimate reading and ships.
    manager.reportPresence(Date.now());
    closeSegment();
    expect(vitalsShipped()).toBe(1);

    // Thirty-one minutes with nobody there. Native keeps closing segments on the safety cap
    // regardless, which is precisely the input this gate exists to swallow.
    session.setLastActivityMs(Date.now() - 31 * 60_000);
    closeSegment();
    closeSegment();
    expect(vitalsShipped()).toBe(1);

    // The user comes back: the gate is a live read, so the next segment ships with nothing re-armed.
    // (This tap also gap-rotates — ordinary inactivity-gap behaviour, independent of the gate.)
    const staleId = session.getSessionId();
    manager.reportPresence(Date.now());
    expect(session.getSessionId()).not.toBe(staleId);
    closeSegment();
    expect(vitalsShipped()).toBe(2);

    manager.uninstrument();
  });

  /**
   * Pre-rotation vitals must not enter the new session: the navigation pull captures the session
   * as well as `instrumentGeneration`. Without it, a segment answered by native after a rotation
   * would be batched under the id that succeeded the one whose frames it measured.
   */
  it("does not attribute a pre-rotation frame segment to the session that replaced it", async () => {
    const native = nativeStub();
    let answerSegment: (json: string) => void = () => {};
    native.flushFrameSegment = vi.fn(
      () => new Promise<string>((resolve) => (answerSegment = resolve))
    ) as never;

    const { manager, screenHolder, session, transporter, pool } = makeManager({
      nativeModule: native,
    });
    session.setSessionId("measured-in");
    session.setSessionStartTime(msToNs(Date.now()));
    manager.instrument();
    manager.reportPresence(Date.now());
    screenHolder.set({ name: "Feed", key: "Feed-1" });
    const measuredIn = session.getSessionId();

    // A screen change starts the pull; native has not answered yet.
    screenHolder.set({ name: "Checkout", key: "Checkout-9" });
    expect(native.flushFrameSegment).toHaveBeenCalled();

    // The session rotates while the pull is in flight. A navigation into a session that has just
    // passed its cap is exactly this interleave, and the window is one bridge round-trip wide.
    vi.spyOn(session, "getSessionElapsedMs").mockReturnValue(Number.MAX_SAFE_INTEGER);
    manager.reportPresence(Date.now());
    const rotatedTo = session.getSessionId();
    expect(rotatedTo).not.toBe(measuredIn);

    // Native answers now, with frames that belong to `measuredIn`.
    answerSegment(JSON.stringify(frameSegment({ reason: "navigation" })));
    await settled();

    // The rotated session is born unconfirmed, so the ghost gate holds its buffer. The user's next
    // touch confirms it — and that is what releases whatever is sitting in there. `flush()` hands
    // the batch to the transporter synchronously, so there is nothing to wait on after it.
    vi.spyOn(session, "getSessionElapsedMs").mockReturnValue(0);
    manager.reportPresence(Date.now());
    pool.flush();

    const misattributed = (transporter.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([batch]) =>
        (batch as { sessionAttributes?: { session_id?: string } })?.sessionAttributes
          ?.session_id === rotatedTo &&
        ((batch as { events?: Array<{ type: string }> })?.events ?? []).some(
          (event) => event.type === "performance"
        )
    );
    expect(
      misattributed,
      "the retired screen's frames must not ship under the session that replaced it"
    ).toHaveLength(0);

    manager.uninstrument();
  });

  it("a re-instrument does not suppress JS swipe/scroll with a stale attach flag", () => {
    // Native confirms its gesture tracker attached → JS movement is suppressed in favour of the
    // richer native measurement. If `uninstrument()` tore the native router down without clearing
    // the flag, then after a stop→start the tracker would be GONE yet every JS swipe/scroll still
    // dropped — a permanent hole in the timeline until (or unless) native re-broadcasts attach.
    const handleEvent = vi
      .spyOn(InteractionListener.prototype, "handleEvent")
      .mockImplementation(() => {});
    const { manager } = makeManager({ nativeModule: nativeStub() });
    manager.instrument();

    __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "gestures_attached", payload: {} });
    handleEvent.mockClear();
    manager.reportInteraction(swipe);
    expect(handleEvent).not.toHaveBeenCalled(); // suppressed while native is attached

    manager.uninstrument();
    manager.instrument();
    handleEvent.mockClear();
    manager.reportInteraction(swipe);
    // Native is gone after teardown; a JS swipe must report again, not be suppressed by a stale flag.
    expect(handleEvent).toHaveBeenCalledTimes(1);

    manager.uninstrument();
  });

  it("a native gesture whose reporting throws never escapes the emitter callback", () => {
    // The router catches a handler throw and routes it to handleError — but handleError itself can
    // throw (a broken host logger), and that would escape through the NativeEventEmitter callback
    // into React Native. Both the handling AND the reporting must be contained.
    const handleEvent = vi
      .spyOn(InteractionListener.prototype, "handleEvent")
      .mockImplementation(() => {
        throw new Error("handle boom");
      });
    const heSpy = vi.spyOn(core, "handleError").mockImplementation(() => {
      throw new Error("logger boom");
    });
    const { manager } = makeManager({ nativeModule: nativeStub() });
    manager.instrument();

    expect(() =>
      __emitNativeSignal(NATIVE_EVENT_CHANNEL, { kind: "gesture", payload: gesturePayload() })
    ).not.toThrow();

    // `not.toThrow()` ALONE is vacuous: an unregistered `gesture` route, or a nil
    // `interactionListener` behind the optional chain in handleNativeGesture, throws nothing and
    // passes just as well. These two pin that the containment ran on a real throw from a real
    // delivery — the signal reached the listener, and the ORIGINAL error is what got reported.
    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(handleEvent.mock.calls[0]?.[0]).toMatchObject({ kind: "swipe", captureSource: "native" });
    expect(heSpy).toHaveBeenCalledTimes(1);
    expect(heSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((heSpy.mock.calls[0]?.[0] as Error).message).toBe("handle boom");

    heSpy.mockImplementation(() => {}); // stop throwing so teardown stays clean
    manager.uninstrument();
  });

/**
   * A frame segment resolved AFTER a re-instrumentation must not be delivered to the replacement.
   *
   * `flushFrameSegmentForScreen` fires a promise and derefs `this.vitalsListener?` when it resolves
   * — a LIVE read. If `uninstrument()` then `instrument()` runs while native is still answering,
   * the resolve finds the new listener and reports the previous screen's frames under the new
   * session. A Metro reload makes that the common path rather than an exotic one.
   *
   * The same defect class as the one the iOS hang callback guards against with `startGeneration` /
   * `isCurrentRun`: work scheduled by one run, landing in the next. The guard is the same shape —
   * capture the generation before the hop, drop the result if it moved.
   */
  it("does not deliver a frame segment that resolved after a re-instrument", async () => {
    const handleEvent = vi
      .spyOn(VitalsEventsListener.prototype, "handleEvent")
      .mockImplementation(() => {});

    // A native stub whose flush we resolve by hand, so the re-instrument lands mid-flight.
    let releaseFlush: (json: string) => void = () => {};
    const native = nativeStub();
    (native.flushFrameSegment as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((resolve) => (releaseFlush = resolve))
    );

    const { manager, screenHolder } = makeManager({ nativeModule: native });
    manager.instrument();
    screenHolder.set({ name: "Home", key: "h1" });
    // A second change is what triggers the flush — the first landing has no outgoing screen.
    screenHolder.set({ name: "Detail", key: "d1" });
    expect(native.flushFrameSegment).toHaveBeenCalled();
    handleEvent.mockClear();

    // The reload happens while native is still answering.
    manager.uninstrument();
    manager.instrument();

    releaseFlush(
      JSON.stringify({
        segmentStartMs: 1_000,
        segmentEndMs: 2_000,
        total: 60,
        slow: 1,
        frozen: 0,
        refreshRate: 60,
        delayMs: 12,
        maxFrameMs: 40,
        reason: "navigation",
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The segment belongs to a screen and a session that are gone.
    expect(handleEvent).not.toHaveBeenCalled();

    manager.uninstrument();
    vi.restoreAllMocks();
  });

  it("a throwing screen-landed callback is contained, not thrown at the navigation caller", () => {
    // createScreenHolder.set already isolates listeners, but the manager's own screen-change
    // callback must self-contain (CONTRIBUTING.md: never break the host app). Proven against a BARE
    // holder that does NOT catch, so
    // only the callback's own guard stands between a thrown app-start callback and host navigation.
    const notifyScreenKnown = vi
      .spyOn(AppStartListener.prototype, "notifyScreenKnown")
      .mockImplementation(() => {
        throw new Error("tti boom");
      });
    const heSpy = vi.spyOn(core, "handleError").mockImplementation(() => {});
    let current: ScreenAttributes = { name: "", key: "" };
    const listeners = new Set<(c: ScreenChange) => void>();
    const bareHolder: ScreenHolder = {
      get: () => current,
      set: (s) => {
        const outgoing = current;
        const isFirstScreen = !outgoing.name;
        current = s;
        listeners.forEach((l) => l({ outgoing, incoming: s, isFirstScreen })); // deliberately unguarded
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const { manager } = makeManager({ nativeModule: nativeStub(), screenHolder: bareHolder });
    manager.instrument();

    expect(() => bareHolder.set({ name: "Home", key: "h1" })).not.toThrow();

    // Same reason as the native-gesture test above: if the manager never subscribed, `set` notifies
    // nobody and the no-throw holds trivially. Pin that the callback actually RAN and that its
    // guard is what absorbed the throw.
    expect(notifyScreenKnown).toHaveBeenCalledTimes(1);
    expect((heSpy.mock.calls[0]?.[0] as Error)?.message).toBe("tti boom");

    manager.uninstrument();
    vi.restoreAllMocks();
  });

  it("a failed native detach does not stack a second emitter subscription on re-instrument", () => {
    const { manager } = makeManager({ nativeModule: nativeStub() });
    manager.instrument();
    expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);

    __failNextNativeRemove(); // the next subscription.remove() throws (a failed removeListeners)
    manager.uninstrument();
    // The listener could not be detached, so it is still attached — count stays 1, not 0.
    expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);

    manager.instrument();
    // ...and the re-instrument must REUSE the still-live subscription rather than add a second.
    expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);

    manager.uninstrument();
  });
});
