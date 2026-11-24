import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventsPool, MAX_GATED_BUFFER_EVENTS, type FlushGate } from "./events-pool";
import type { ConfigManager } from "../config/config-manager";
import type { SessionState } from "../session/session-state";
import type { Transporter } from "../transporter/transporter";
import { BaseEvent, DedupeableEvent, ErrorEventAttributes } from "./types";
import { msToNs } from "../common/global";
import { EventEnricher } from "./event-enricher";
import { exceptionDedup } from "./errors/exception-dedup";
import { errorLogDedup } from "./logs/log-dedup";

// Create a mock send function that we can spy on
const mockSend = vi.fn();

// Session identity lives in SessionState — the pool only reads the id and
// start time when stamping a batch envelope.
const createSessionFake = () => ({
  getSessionId: vi.fn().mockReturnValue("existing-session-id"),
  getSessionStartTime: vi.fn().mockReturnValue(1700000000000),
});

// Plain constructor fake for ConfigManager — the pool receives it via DI.
const createConfigManagerFake = () => ({
  getConfig: vi.fn().mockReturnValue({
    options: {
      transport: {
        batchSize: 5,
        batchTimeout: 1000,
      },
    },
    appId: "test-app",
    user: null,
    cluster: "test-cluster",
    environment: "test-environment",
    namespace: "test-namespace",
    releaseId: "v1.2.3",
  }),
});

// Host device metadata provider (platform-injected; core never detects the
// device itself).
const mockDeviceAttributes = {
  device: {
    model: "test-device",
    os: "test-os",
    osVersion: "1.2.3",
    language: "en-US",
  },
};
const getDeviceAttributes = vi.fn(() => mockDeviceAttributes);

describe("EventsPool", () => {
  let configManager: ReturnType<typeof createConfigManagerFake>;
  let session: ReturnType<typeof createSessionFake>;
  let eventsPool: EventsPool;

  const createPool = () =>
    new EventsPool({
      config: configManager as unknown as ConfigManager,
      session: session as unknown as SessionState,
      transporter: { send: mockSend } as unknown as Transporter,
      getDeviceAttributes,
      // Platform-injected (core ships no default list); "activity" stands in
      // for a platform's high-frequency activity kind.
      eventsToSkipFlush: ["navigation", "activity"],
    });

  const createMockEvent = (overrides = {}): BaseEvent => ({
    type: "custom",
    timestamp: Date.now(),
    id: "test-id",
    spanId: "test-span-id",
    parentSpanId: "test-parent-span-id",
    traceId: "test-trace-id",
    ...overrides,
  });

  beforeEach(() => {
    // Setup fake timers first
    vi.useFakeTimers();

    // Reset all mocks
    vi.clearAllMocks();

    // Fresh dependencies + pool per test — no shared instance to reset.
    configManager = createConfigManagerFake();
    session = createSessionFake();
    eventsPool = createPool();
  });

  afterEach(() => {
    // Tear down the pool so its heartbeat timer doesn't leak into the next
    // test.
    eventsPool.destroy();
    vi.useRealTimers();
  });

  // With constructor injection there is no shared instance: each pool is
  // independent.
  describe("construction", () => {
    it("creates independent instances with isolated buffers", () => {
      const poolA = createPool();
      const poolB = createPool();
      expect(poolA).not.toBe(poolB);

      poolA.initialize();
      poolB.initialize();

      poolA.addEvent(createMockEvent());

      // Pool B never saw the event — flushing it sends nothing.
      poolB.flush();
      expect(mockSend).not.toHaveBeenCalled();

      poolA.flush();
      expect(mockSend).toHaveBeenCalledTimes(1);

      poolA.destroy();
      poolB.destroy();
    });

    it("should not crash when constructed multiple times", () => {
      const pools: EventsPool[] = [];
      for (let i = 0; i < 100; i++) {
        expect(() => pools.push(createPool())).not.toThrow();
      }
    });
  });

  // The pool wires no host-suspend listener of its own — suspend wiring is
  // host-owned: the platform package listens for its host's suspend signal and
  // calls flush({ lifecycle: true }) itself (covered by that package's tests).
  // The pool's contract is the lifecycle flush itself: a synchronous
  // transporter.send with the lifecycle option.
  describe("initialize", () => {
    it("should initialize only once", () => {
      eventsPool.initialize();
      eventsPool.initialize();

      // Only one flush heartbeat is armed — the second initialize() no-ops.
      expect(vi.getTimerCount()).toBe(1);
    });

    it("should not send on a lifecycle flush when there are no events", () => {
      eventsPool.initialize();

      eventsPool.flush({ lifecycle: true });

      expect(mockSend).toHaveBeenCalledTimes(0);
    });

    it("flush({ lifecycle: true }) sends queued events synchronously", () => {
      eventsPool.initialize();
      eventsPool.addEvent(createMockEvent());

      eventsPool.flush({ lifecycle: true });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("passes lifecycle: true to transporter.send on a lifecycle flush", () => {
      eventsPool.initialize();
      eventsPool.addEvent(createMockEvent());

      eventsPool.flush({ lifecycle: true });

      // Second arg is the options object — must request the lifecycle (sync,
      // no worker round-trip) path so the send is queued before the host
      // suspends.
      expect(mockSend).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lifecycle: true }),
      );
    });
  });

  describe("addEvent", () => {
    beforeEach(() => {
      eventsPool.initialize();
    });

    it("should safely handle null events", () => {
      expect(() => eventsPool.addEvent(null)).not.toThrow();
    });

    it("should add valid events and flush when batch size is reached", () => {
      const mockEvent = createMockEvent();
      const batchSize =
        configManager.getConfig()?.options.transport?.batchSize;

      if (!batchSize) {
        throw new Error("Batch size is not defined");
      }

      for (let i = 0; i < batchSize; i++) {
        eventsPool.addEvent(mockEvent);
      }

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          events: expect.arrayContaining([mockEvent]),
        })
      );
    });

    it("should not crash when adding events rapidly", () => {
      const mockEvent = createMockEvent();

      expect(() => {
        for (let i = 0; i < 1000; i++) {
          eventsPool.addEvent(mockEvent);
        }
      }).not.toThrow();
    });
  });

  describe("flush", () => {
    beforeEach(() => {
      vi.clearAllTimers();
      eventsPool.initialize();
    });

    it("should not crash when flushing empty events", () => {
      expect(() => eventsPool.flush()).not.toThrow();
    });

    it("should flush events and reset the array", () => {
      const mockEvent = createMockEvent();
      eventsPool.addEvent(mockEvent);
      eventsPool.flush();

      expect(mockSend).toHaveBeenCalledTimes(1);

      eventsPool.addEvent(mockEvent);
      eventsPool.flush();
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("should handle scheduled flushes correctly", async () => {
      const mockEvent = createMockEvent();

      eventsPool.addEvent(mockEvent);

      expect(mockSend).not.toHaveBeenCalled();

      vi.runOnlyPendingTimers();

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          events: expect.arrayContaining([mockEvent]),
        })
      );
    });

    it("should reschedule flush after manual flush", () => {
      const mockEvent = createMockEvent();

      eventsPool.addEvent(mockEvent);
      eventsPool.flush();

      const anotherEvent = createMockEvent();
      eventsPool.addEvent(anotherEvent);

      vi.runOnlyPendingTimers();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("keeps the periodic flush armed across empty windows (idle gap)", () => {
      // The scheduled flush fires over an empty pool — e.g. a user idle gap.
      vi.runOnlyPendingTimers();
      expect(mockSend).not.toHaveBeenCalled();

      // Several quiet windows in a row must not kill the heartbeat either.
      vi.runOnlyPendingTimers();
      vi.runOnlyPendingTimers();

      // The user returns: a few events (below batchSize) must still leave on
      // the next batchTimeout tick, not wait for batchSize or a host suspend.
      eventsPool.addEvent(createMockEvent());
      vi.runOnlyPendingTimers();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("keeps the heartbeat armed while cluster is missing and ships the backlog once it arrives", () => {
      const fullConfig = configManager.getConfig()!;
      configManager.getConfig.mockReturnValue({ ...fullConfig, cluster: "" });

      const mockEvent = createMockEvent();
      eventsPool.addEvent(mockEvent);
      vi.runOnlyPendingTimers();

      // Unsendable while cluster is missing: nothing leaves, but the heartbeat
      // stays armed — cluster can still arrive later via updateConfig.
      expect(mockSend).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      configManager.getConfig.mockReturnValue(fullConfig);
      vi.runOnlyPendingTimers();

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ events: expect.arrayContaining([mockEvent]) })
      );
    });
  });

  describe("transport batch edge values (explicit 0)", () => {
    // These tests install a custom getConfig return value. The ConfigManager
    // fake is rebuilt in the file's beforeEach, so nothing leaks into later
    // suites — no restore needed.

    it("flushes every event when batchSize is explicitly 0 (not coerced to default)", () => {
      configManager.getConfig.mockReturnValue({
        options: { transport: { batchSize: 0, batchTimeout: 1000 } },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });
      eventsPool.initialize();

      // A single event must leave immediately, not buffer toward the default.
      eventsPool.addEvent(createMockEvent());

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("falls back to the shared default batch size (10) for an invalid batchSize", () => {
      configManager.getConfig.mockReturnValue({
        options: { transport: { batchSize: -1, batchTimeout: 1000 } },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });
      eventsPool.initialize();

      // 9 events: below the documented default (10), so nothing should flush yet.
      for (let i = 0; i < 9; i++) eventsPool.addEvent(createMockEvent());
      expect(mockSend).not.toHaveBeenCalled();

      // The 10th hits the shared default threshold.
      eventsPool.addEvent(createMockEvent());
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("keeps the flush timer armed when batchTimeout is explicitly 0 (events not stranded)", () => {
      configManager.getConfig.mockReturnValue({
        options: { transport: { batchSize: 5, batchTimeout: 0 } },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });
      eventsPool.initialize();

      // Below batchSize, so the only way this ever ships is the heartbeat.
      eventsPool.addEvent(createMockEvent());
      expect(mockSend).not.toHaveBeenCalled();

      vi.runOnlyPendingTimers();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("destroy", () => {
    beforeEach(() => {
      vi.clearAllTimers();
      eventsPool.initialize();
    });

    it("stops the flush heartbeat and rejects further events", () => {
      eventsPool.destroy();

      expect(vi.getTimerCount()).toBe(0);
      eventsPool.addEvent(createMockEvent());
      vi.advanceTimersByTime(10_000);
      expect(mockSend).not.toHaveBeenCalled();
    });

    // The pool registers no host-suspend listener at all. That listener (and
    // its removal on destroy) belongs to the platform package and is tested
    // there.

    it("re-initializes cleanly after destroy", () => {
      eventsPool.destroy();
      eventsPool.initialize();

      eventsPool.addEvent(createMockEvent());
      vi.runOnlyPendingTimers();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  // The pool does not detect the device itself — that is the platform's
  // injected provider, tested by the platform package. The pool's contract is
  // to spread the injected provider's result verbatim into every batch
  // envelope.
  describe("device attributes", () => {
    it("spreads getDeviceAttributes() into sessionAttributes", () => {
      eventsPool.initialize();
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();

      expect(getDeviceAttributes).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionAttributes: expect.objectContaining({
            device: expect.objectContaining({
              model: "test-device",
              os: "test-os",
              osVersion: "1.2.3",
              language: "en-US",
            }),
          }),
        })
      );
    });
  });

  describe("getSessionAttributes", () => {
    it("returns the same envelope the pool stamps on a flushed batch", () => {
      // A host that persists this envelope (or sends a batch the pool itself
      // cannot build) must get bytes identical to a live batch — that identity
      // is the whole reason the getter is public rather than reassembled.
      eventsPool.initialize();

      const envelope = eventsPool.getSessionAttributes();
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();

      const flushed = mockSend.mock.calls[0]![0].sessionAttributes;
      expect(envelope).toEqual(flushed);
    });

    it("does not let a throwing device-attributes provider escape into the host", () => {
      // `flush()` builds this envelope inside its own try/catch, so there a bad
      // provider costs only a batch. This accessor is public and called
      // directly by a host, so an unguarded throw would surface in the app. It
      // must report and degrade to the identity fields instead.
      eventsPool.initialize();
      const pool = eventsPool as unknown as { getDeviceAttributes: () => Record<string, unknown> };
      pool.getDeviceAttributes = () => {
        throw new Error("provider exploded");
      };

      let envelope: ReturnType<typeof eventsPool.getSessionAttributes> | undefined;
      expect(() => {
        envelope = eventsPool.getSessionAttributes();
      }).not.toThrow();
      expect(envelope?.session_id).toBeDefined();
    });

    it("keeps the configured session fields when only the device provider fails", () => {
      // A guard around the whole envelope would let a device-provider failure
      // also blank cluster/env/namespace/releaseId/user. `flush()` has already
      // verified a cluster exists by then, so it would send a batch with
      // incomplete session metadata and clear the buffer behind it. Only the
      // platform's own metadata is allowed to go missing.
      eventsPool.initialize();
      const pool = eventsPool as unknown as { getDeviceAttributes: () => Record<string, unknown> };
      pool.getDeviceAttributes = () => {
        throw new Error("provider exploded");
      };

      const envelope = eventsPool.getSessionAttributes();

      expect(envelope.cluster).toBe("test-cluster");
      expect(envelope.env).toBe("test-environment");
      expect(envelope.namespace).toBe("test-namespace");
      expect(envelope.releaseId).toBe("v1.2.3");
      expect(envelope.session_id).toBeDefined();
    });
  });

  describe("session attributes", () => {
    it("should generate new session ID when none exists", () => {
      // Session-id minting lives in SessionState/bootstrap; the pool
      // stamps whatever session.getSessionId() returns. Simulate the host
      // minting a fresh id for a session with no stored one.
      session.getSessionId.mockReturnValue("freshly-generated-id");

      eventsPool.initialize();
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionAttributes: expect.objectContaining({
            session_id: expect.any(String),
          }),
        })
      );
    });

    it("should use existing session ID when available", () => {
      const existingSessionId = "existing-session-id";
      session.getSessionId.mockReturnValue(existingSessionId);

      eventsPool.initialize();
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionAttributes: expect.objectContaining({
            session_id: existingSessionId,
          }),
        })
      );
    });

    it("should include releaseId in session attributes when configured", () => {
      eventsPool.initialize();
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionAttributes: expect.objectContaining({
            releaseId: "v1.2.3",
          }),
        })
      );
    });

    it("should include empty releaseId when not configured", () => {
      configManager.getConfig.mockReturnValue({
        options: {
          transport: {
            batchSize: 5,
            batchTimeout: 1000,
          },
        },
        appId: "test-app",
        user: null,
        cluster: "test-cluster",
        environment: "test-environment",
        namespace: "test-namespace",
        releaseId: undefined,
        dsn: "test-dsn",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });

      eventsPool.initialize();
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionAttributes: expect.objectContaining({
            releaseId: "",
          }),
        })
      );
    });
  });

  // SessionLifecycle asks the pool for the earliest event still buffered, so a
  // rotation can backdate the new session's start to cover events the drain
  // left behind (the no-cluster retention path). A rotated session must never
  // start after an event that ships under its id.
  //
  // Every scenario here uses "activity": it is in eventsToSkipFlush, so adding
  // several events can't trip the size-based flush and empty the buffer
  // mid-test.
  describe("getEarliestEventTimestamp", () => {
    const MAX_AGE_NS = msToNs(4 * 60 * 60 * 1000);
    let nowNs: number;

    beforeEach(() => {
      eventsPool.initialize();
      nowNs = msToNs(Date.now());
    });

    it("returns null for an empty buffer", () => {
      expect(eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).toBeNull();
    });

    it("reports the earliest trusted timestamp in the buffer", () => {
      eventsPool.addEvent(createMockEvent({ type: "activity", timestamp: nowNs - msToNs(10) }));
      eventsPool.addEvent(createMockEvent({ type: "activity", timestamp: nowNs - msToNs(500) }));
      eventsPool.addEvent(createMockEvent({ type: "activity", timestamp: nowNs - msToNs(20) }));

      expect(eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).toBe(nowNs - msToNs(500));
    });

    // EventEnricher's only branch: network gets a top-level start_timestamp and
    // no timestamp at all, so both shapes must be read. `timestamp ??
    // start_timestamp` would not do — it does not fall through on timestamp: 0.
    it("reads a network event's start_timestamp, which carries no timestamp at all", () => {
      eventsPool.addEvent(
        createMockEvent({
          type: "network",
          timestamp: undefined,
          start_timestamp: nowNs - msToNs(30),
        })
      );

      expect(eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).toBe(nowNs - msToNs(30));
    });

    // Some platform events also carry a start_timestamp, but INSIDE
    // attributes — and a platform listener may write that one in
    // MILLISECONDS. Reading it would date the session to 1970.
    it("ignores a start_timestamp buried in attributes", () => {
      eventsPool.addEvent(
        createMockEvent({
          type: "activity",
          timestamp: nowNs,
          attributes: { start_timestamp: Date.now() - 1_000 },
        })
      );

      expect(eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).toBe(nowNs);
    });

    it("ignores times that are zero, negative, non-numeric, future or older than the window", () => {
      const trusted = nowNs - msToNs(50);
      eventsPool.addEvent(createMockEvent({ type: "activity", timestamp: 0 }));
      eventsPool.addEvent(createMockEvent({ type: "activity", timestamp: -1 }));
      eventsPool.addEvent(createMockEvent({ type: "activity", timestamp: Number.NaN }));
      eventsPool.addEvent(
        createMockEvent({ type: "activity", timestamp: Number.POSITIVE_INFINITY })
      );
      eventsPool.addEvent(
        createMockEvent({ type: "activity", timestamp: nowNs + msToNs(60_000) })
      );
      // A millisecond past the floor, not a nanosecond: these values sit ~198x
      // above 2^53, where the float64 step is 256ns, so `- 1` would be a no-op
      // and the event would land ON the (inclusive) floor and be trusted.
      eventsPool.addEvent(
        createMockEvent({ type: "activity", timestamp: nowNs - MAX_AGE_NS - msToNs(1) })
      );
      eventsPool.addEvent(
        createMockEvent({ type: "activity", timestamp: "nope" as unknown as number })
      );
      eventsPool.addEvent(createMockEvent({ type: "activity", timestamp: trusted }));

      expect(eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).toBe(trusted);
    });

    // The buffer holds whatever a user's enrichEvent returned. This runs inside
    // a rotation, so an escaping throw would abort the id flip.
    it("does not throw when an event's timestamp getter throws", () => {
      const hostile = createMockEvent({ type: "activity" });
      Object.defineProperty(hostile, "timestamp", {
        get() {
          throw new Error("boom");
        },
      });
      eventsPool.addEvent(hostile);

      expect(() => eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).not.toThrow();
    });

    // Containment has to be per event, not per scan. Aborting the whole loop on
    // the first hostile getter would hide every event after it, so a rotation
    // would fall back to the clock and ship a start that postdates a buffered
    // event — the exact inversion this method exists to prevent.
    it("keeps scanning past an event whose timestamp getter throws", () => {
      const hostile = createMockEvent({ type: "activity" });
      Object.defineProperty(hostile, "timestamp", {
        get() {
          throw new Error("boom");
        },
      });
      eventsPool.addEvent(hostile);
      eventsPool.addEvent(
        createMockEvent({ type: "activity", timestamp: nowNs - msToNs(2_000) })
      );

      expect(eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).toBe(
        nowNs - msToNs(2_000)
      );
    });

    // Containment has to be per FIELD, not just per event. A network event
    // carries its time in start_timestamp; if a throwing `timestamp` getter on
    // the same object skipped it, that event's real time would be lost and the
    // rotation would fall back to the clock — the inversion again, one level
    // down from the per-event case above.
    it("still reads start_timestamp when the timestamp getter on the same event throws", () => {
      const hostile = createMockEvent({ type: "network" });
      Object.defineProperty(hostile, "timestamp", {
        configurable: true,
        get() {
          throw new Error("boom");
        },
      });
      hostile.start_timestamp = nowNs - msToNs(2_000);
      eventsPool.addEvent(hostile);

      expect(eventsPool.getEarliestEventTimestamp(nowNs, MAX_AGE_NS)).toBe(
        nowNs - msToNs(2_000)
      );
    });
  });

  describe("error handling", () => {
    it("should handle transporter failures gracefully", () => {
      mockSend.mockImplementationOnce(() => {
        throw new Error("Network error");
      });

      eventsPool.initialize();
      expect(() => {
        eventsPool.addEvent(createMockEvent());
        eventsPool.flush();
      }).not.toThrow();
    });

    it("should handle timer failures gracefully", () => {
      const mockSetTimeout = vi.spyOn(globalThis, "setTimeout");
      mockSetTimeout.mockImplementationOnce(() => {
        throw new Error("Timer error");
      });

      eventsPool.initialize();
      expect(() => {
        eventsPool.addEvent(createMockEvent());
      }).not.toThrow();
    });
  });

  describe("beforeSend", () => {
    beforeEach(() => {
      eventsPool.initialize();
    });

    it("should call beforeSend function when configured", () => {
      const beforeSend = vi.fn().mockReturnValue(true);
      configManager.getConfig.mockReturnValue({
        options: {
          beforeSend,
          transport: {
            batchSize: 5,
            batchTimeout: 1000,
          },
        },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });

      const mockEvent = createMockEvent();
      eventsPool.addEvent(mockEvent);
      eventsPool.flush();

      expect(beforeSend).toHaveBeenCalledWith(mockEvent);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          events: expect.arrayContaining([mockEvent]),
        })
      );
    });

    it("should not send event when beforeSend returns false", () => {
      const beforeSend = vi.fn().mockReturnValue(false);
      configManager.getConfig.mockReturnValue({
        options: {
          beforeSend,
          transport: {
            batchSize: 5,
            batchTimeout: 1000,
          },
        },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });

      const mockEvent = createMockEvent();
      eventsPool.addEvent(mockEvent);
      eventsPool.flush();

      expect(beforeSend).toHaveBeenCalledWith(mockEvent);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should handle beforeSend throwing an error", () => {
      const beforeSend = vi.fn().mockImplementation(() => {
        throw new Error("beforeSend error");
      });
      configManager.getConfig.mockReturnValue({
        options: {
          beforeSend,
          transport: {
            batchSize: 5,
            batchTimeout: 1000,
          },
        },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });

      const mockEvent = createMockEvent();
      expect(() => eventsPool.addEvent(mockEvent)).not.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should handle undefined beforeSend function", () => {
      configManager.getConfig.mockReturnValue({
        options: {
          transport: {
            batchSize: 5,
            batchTimeout: 1000,
          },
        },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });

      const mockEvent = createMockEvent();
      eventsPool.addEvent(mockEvent);
      eventsPool.flush();

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          events: expect.arrayContaining([mockEvent]),
        })
      );
    });
  });

  describe("enrichEvent", () => {
    beforeEach(() => {
      eventsPool.initialize();
    });

    it("should call enrichEvent function to override event attributes", () => {
      const enrichEvent = vi.fn().mockImplementation((event) => {
        return {
          ...event,
          view: { name: "overridden" },
        };
      });

      configManager.getConfig.mockReturnValue({
        options: {
          enrichEvent,
          transport: {
            batchSize: 5,
            batchTimeout: 1000,
          },
        },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });

      const mockEvent = createMockEvent({
        view: { name: "original" },
      });
      eventsPool.addEvent(mockEvent);
      eventsPool.flush();

      expect(enrichEvent).toHaveBeenCalledWith(mockEvent);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          events: expect.arrayContaining([
            expect.objectContaining({
              view: {
                name: "overridden",
              },
            }),
          ]),
        })
      );
    });

    it("should handle enrichEvent throwing an error gracefully", () => {
      const enrichEvent = vi.fn().mockImplementation(() => {
        throw new Error("enrichEvent error");
      });

      configManager.getConfig.mockReturnValue({
        options: {
          enrichEvent,
          transport: {
            batchSize: 5,
            batchTimeout: 1000,
          },
        },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });

      const mockEvent = createMockEvent();
      expect(() => {
        eventsPool.addEvent(mockEvent);
      }).not.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // Generic mechanism only — EventsPool stays unaware of session policy.
  // The rotation policy lives in SessionLifecycle.
  // Without a runtime check on the enrichEvent result, an unusable return value
  // would reach both the enqueue observer and the transporter.
  //
  // An unusable result DROPS the event. It must not fall back to the
  // pre-enrichment event: `enrichEvent` is the documented way to scrub
  // `sendCustomEvent` payloads, which the SDK does not auto-redact (see the
  // README note), so shipping the original is a privacy leak — the raw payload
  // is exactly what a failed scrubber was supposed to remove. It also matches
  // the throwing-hook path, which already drops.
  describe("enrichEvent returning an unusable value", () => {
    const unusable: Array<[string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["a string", "nope"],
      ["a number", 42],
      ["an object with no type", { id: "x" }],
      ["an object with a non-string type", { type: 7, id: "x" }],
    ];

    for (const [label, value] of unusable) {
      it(`drops the event when enrichEvent returns ${label}`, () => {
        configManager.getConfig.mockReturnValue({
          options: {
            enrichEvent: () => value,
            transport: { batchSize: 5, batchTimeout: 1000 },
          },
          cluster: "test-cluster",
          appId: "test-app",
        });
        const hook = vi.fn();
        eventsPool.setBeforeEnqueueHook(hook);
        eventsPool.initialize();

        const mockEvent = createMockEvent({ type: "custom", id: "leak-me" });
        expect(() => eventsPool.addEvent(mockEvent)).not.toThrow();

        // Dropped: neither the unusable value NOR the unscrubbed original may be
        // enqueued, and nothing reconciles for an event that was not accepted.
        expect(hook).not.toHaveBeenCalled();
        eventsPool.flush();
        expect(mockSend).not.toHaveBeenCalled();
      });
    }

    it("keeps a well-formed enrichEvent result, including a replaced object", () => {
      configManager.getConfig.mockReturnValue({
        options: {
          enrichEvent: (event: BaseEvent) => ({ ...event, type: "custom", id: "replaced" }),
          transport: { batchSize: 5, batchTimeout: 1000 },
        },
        cluster: "test-cluster",
        appId: "test-app",
      });
      eventsPool.initialize();

      eventsPool.addEvent(createMockEvent({ id: "original" }));
      eventsPool.flush();

      const batch = mockSend.mock.calls[0]![0];
      expect(batch.events[0].id).toBe("replaced");
    });

    it("drops the event, without throwing, when reading `type` off the result throws", () => {
      const hostile = {};
      Object.defineProperty(hostile, "type", {
        get() {
          throw new Error("boom");
        },
      });
      configManager.getConfig.mockReturnValue({
        options: {
          enrichEvent: () => hostile,
          transport: { batchSize: 5, batchTimeout: 1000 },
        },
        cluster: "test-cluster",
        appId: "test-app",
      });
      eventsPool.initialize();

      const mockEvent = createMockEvent({ id: "leak-me" });
      expect(() => eventsPool.addEvent(mockEvent)).not.toThrow();

      eventsPool.flush();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("beforeEnqueue hook", () => {
    beforeEach(() => {
      eventsPool.initialize();
    });

    it("fires once per accepted event, with the event", () => {
      const hook = vi.fn();
      eventsPool.setBeforeEnqueueHook(hook);

      eventsPool.addEvent(createMockEvent({ type: "custom" }));
      eventsPool.addEvent(createMockEvent());
      eventsPool.addEvent(createMockEvent());

      expect(hook).toHaveBeenCalledTimes(3);
      expect(hook).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "custom" }));
    });

    it("does not fire when beforeSend rejects the event", () => {
      const hook = vi.fn();
      const beforeSend = vi.fn().mockReturnValue(false);
      configManager.getConfig.mockReturnValue({
        options: { beforeSend, transport: { batchSize: 5, batchTimeout: 1000 } },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });
      eventsPool.setBeforeEnqueueHook(hook);

      eventsPool.addEvent(createMockEvent());

      expect(hook).not.toHaveBeenCalled();
    });

    it("fires after beforeSend acceptance", () => {
      const beforeSend = vi.fn().mockReturnValue(true);
      const hook = vi.fn();
      configManager.getConfig.mockReturnValue({
        options: { beforeSend, transport: { batchSize: 5, batchTimeout: 1000 } },
        appId: "test-app",
        user: null,
        dsn: "test-dsn",
        cluster: "test-cluster",
        environment: "test-environment",
        apiKey: "test-api-key",
        getEndpoint: vi.fn(),
        updateConfig: vi.fn(),
      });
      eventsPool.setBeforeEnqueueHook(hook);

      eventsPool.addEvent(createMockEvent());

      expect(beforeSend.mock.invocationCallOrder[0]!).toBeLessThan(
        hook.mock.invocationCallOrder[0]!
      );
    });

    it("fires before the event is enqueued", () => {
      // A flush() triggered inside the hook must NOT include the event being
      // added — this is what lets a rotation bucket pre-rotation events under
      // the old session id. The triggering event is enqueued after the hook.
      eventsPool.setBeforeEnqueueHook(() => eventsPool.flush());

      eventsPool.addEvent(createMockEvent());

      // The in-hook flush saw an empty pool, so nothing was sent yet.
      expect(mockSend).not.toHaveBeenCalled();
      // The event is now buffered; an explicit flush sends it.
      eventsPool.flush();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("isolates a throwing hook so the event still enqueues", () => {
      eventsPool.setBeforeEnqueueHook(() => {
        throw new Error("hook error");
      });

      const mockEvent = createMockEvent();
      expect(() => eventsPool.addEvent(mockEvent)).not.toThrow();

      eventsPool.flush();
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          events: expect.arrayContaining([mockEvent]),
        })
      );
    });

    it("stops firing once the hook is cleared", () => {
      const hook = vi.fn();
      eventsPool.setBeforeEnqueueHook(hook);
      eventsPool.addEvent(createMockEvent());
      expect(hook).toHaveBeenCalledTimes(1);

      eventsPool.setBeforeEnqueueHook(null);
      eventsPool.addEvent(createMockEvent());
      expect(hook).toHaveBeenCalledTimes(1);
    });
  });

  // Policy-free send gate. When closed, flush/flushSync/batch/lifecycle sends
  // hold instead of shipping; unset = every send goes out. The presence policy
  // lives in SessionLifecycle.
  describe("flush gate + bounded buffer", () => {
    beforeEach(() => {
      eventsPool.initialize();
    });

    it("gated flush() holds events, does not send, and keeps the heartbeat armed", () => {
      eventsPool.setFlushGate(() => false);
      eventsPool.addEvent(createMockEvent());

      eventsPool.flush();
      expect(mockSend).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      // A later heartbeat while still closed sends nothing either.
      vi.runOnlyPendingTimers();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("gated batch-size flush holds", () => {
      eventsPool.setFlushGate(() => false);
      for (let i = 0; i < 5; i++) eventsPool.addEvent(createMockEvent());
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("gated lifecycle (host suspend) flush holds", () => {
      // Call the lifecycle flush directly — what a platform's host-suspend
      // handler invokes on the pool.
      eventsPool.setFlushGate(() => false);
      eventsPool.addEvent(createMockEvent());

      eventsPool.flush({ lifecycle: true });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("drains the withheld buffer once the gate opens (explicit flush)", () => {
      let open = false;
      eventsPool.setFlushGate(() => open);
      eventsPool.addEvent(createMockEvent());
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();
      expect(mockSend).not.toHaveBeenCalled();

      open = true;
      eventsPool.flush();
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0].events).toHaveLength(2);
    });

    it("drains via the heartbeat after the gate opens (timer chain survived)", () => {
      let open = false;
      eventsPool.setFlushGate(() => open);
      eventsPool.addEvent(createMockEvent());

      vi.runOnlyPendingTimers();
      expect(mockSend).not.toHaveBeenCalled();

      open = true;
      vi.runOnlyPendingTimers();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("bounds the buffer while gated, dropping the NEWEST events past the cap", () => {
      let open = false;
      eventsPool.setFlushGate(() => open);

      for (let i = 0; i < MAX_GATED_BUFFER_EVENTS + 10; i++) {
        eventsPool.addEvent(createMockEvent({ id: `e${i}` }));
      }

      open = true;
      eventsPool.flush();

      const batch = mockSend.mock.calls[0]![0];
      expect(batch.events).toHaveLength(MAX_GATED_BUFFER_EVENTS);
      // Earliest kept (drop-newest), newest dropped.
      expect(batch.events[0].id).toBe("e0");
      expect(
        batch.events.some(
          (e: { id: string }) => e.id === `e${MAX_GATED_BUFFER_EVENTS + 9}`
        )
      ).toBe(false);
    });

    it("setFlushGate(null) restores immediate send", () => {
      eventsPool.setFlushGate(() => false);
      eventsPool.addEvent(createMockEvent());
      eventsPool.flush();
      expect(mockSend).not.toHaveBeenCalled();

      eventsPool.setFlushGate(null);
      eventsPool.flush();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("discardBuffer() clears the buffer without sending", () => {
      eventsPool.setFlushGate(() => false);
      eventsPool.addEvent(createMockEvent());

      eventsPool.discardBuffer();

      eventsPool.setFlushGate(null);
      eventsPool.flush();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("gated flushSync() discards instead of sending (setSessionId id-flip path)", async () => {
      eventsPool.setFlushGate(() => false);
      eventsPool.addEvent(createMockEvent());

      await eventsPool.flushSync();
      expect(mockSend).not.toHaveBeenCalled();

      // The buffer was discarded, not merely held: opening the gate sends nothing.
      eventsPool.setFlushGate(null);
      eventsPool.flush();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("open flushSync() sends normally", async () => {
      eventsPool.setFlushGate(() => true);
      eventsPool.addEvent(createMockEvent());

      await eventsPool.flushSync();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("a throwing gate predicate fails open (sends) and does not throw", () => {
      eventsPool.setFlushGate(() => {
        throw new Error("bad gate");
      });
      eventsPool.addEvent(createMockEvent());

      expect(() => eventsPool.flush()).not.toThrow();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    // The gate is told which kind of send it is asked about and what is
    // buffered, so a policy can make an exception for the last send before
    // the host is hidden or torn down (SessionLifecycle.releasesOnSuspend).
    describe("gate context", () => {
      it("tells the gate a lifecycle flush is one, and shows it the buffer", () => {
        const gate = vi.fn<FlushGate>(() => false);
        eventsPool.setFlushGate(gate);
        eventsPool.addEvent(createMockEvent({ id: "held" }));
        gate.mockClear();

        eventsPool.flush({ lifecycle: true });

        expect(gate).toHaveBeenCalledTimes(1);
        const context = gate.mock.calls[0]![0];
        expect(context.lifecycle).toBe(true);
        expect(context.events.map((e) => e.id)).toEqual(["held"]);
      });

      it("tells the gate every other send is not a lifecycle one", async () => {
        const gate = vi.fn<FlushGate>(() => false);
        eventsPool.setFlushGate(gate);
        // addEvent asks for the buffer cap.
        eventsPool.addEvent(createMockEvent());
        eventsPool.flush(); // explicit / batch-size
        vi.runOnlyPendingTimers(); // heartbeat
        await eventsPool.flushSync(); // id flip

        expect(gate.mock.calls.length).toBeGreaterThanOrEqual(4);
        for (const [context] of gate.mock.calls) {
          expect(context.lifecycle).toBe(false);
        }
      });

      it("a gate that opens only for the lifecycle flush sends the whole buffer then", () => {
        eventsPool.setFlushGate(({ lifecycle }) => lifecycle);
        eventsPool.addEvent(createMockEvent({ id: "a" }));
        eventsPool.addEvent(createMockEvent({ id: "b" }));

        eventsPool.flush();
        vi.runOnlyPendingTimers();
        expect(mockSend).not.toHaveBeenCalled();

        eventsPool.flush({ lifecycle: true });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0]![0].events.map((e: { id: string }) => e.id)).toEqual(["a", "b"]);
        // Sent with the lifecycle encoding, like any lifecycle flush.
        expect(mockSend.mock.calls[0]![1]).toEqual({ lifecycle: true });
      });
    });
  });

  // What makes two events the same is in errors/exception-dedup.test.ts,
  // logs/log-dedup.test.ts and event-enricher.test.ts; these cover what reaches
  // the transporter. Events are built the way the listeners build them, so they
  // carry the hidden `dedup` the enricher attaches.
  describe("error deduplication", () => {
    const enricher = new EventEnricher();
    const exceptionAttributes = (message = "Unable to decode file"): ErrorEventAttributes => ({
      error_type: "Error",
      error_message: message,
      error_fingerprint: `Error:${message}`,
      error_handled: false,
      error_stacktrace: [],
    });
    const exception = (attributes = exceptionAttributes()): DedupeableEvent =>
      enricher.enrich({ type: "exception", attributes, dedup: exceptionDedup(attributes) });
    const other = (message: string) => exception(exceptionAttributes(message));

    const sentEvents = (): BaseEvent[] =>
      mockSend.mock.calls.flatMap(([batch]) => (batch as { events: BaseEvent[] }).events);
    const sentExceptions = () => sentEvents().filter((event) => event.type === "exception");
    const repeatCounts = () => sentExceptions().map((event) => event.attributes?.error_repeat_count);
    const occurrences = () =>
      sentExceptions().reduce((sum, event) => sum + ((event.attributes?.error_repeat_count as number) ?? 1), 0);

    const setOptions = (options: Record<string, unknown>) => {
      const config = configManager.getConfig();
      configManager.getConfig.mockReturnValue({ ...config, options: { ...config.options, ...options } });
    };

    beforeEach(() => {
      eventsPool.initialize();
    });

    it("counts repeats in a batch on the first occurrence instead of buffering them", () => {
      const first = exception();
      eventsPool.addEvent(first);
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());

      eventsPool.flush();

      expect(sentExceptions()).toHaveLength(1);
      expect(sentExceptions()[0]!.id).toBe(first.id);
      expect(repeatCounts()).toEqual([4]);
    });

    it("writes the count on a copy, so the event a hook holds never changes", () => {
      const seen: BaseEvent[] = [];
      setOptions({ beforeSend: (event: BaseEvent) => (seen.push(event), true) });
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      eventsPool.flush();

      expect(repeatCounts()).toEqual([3]);
      expect(sentExceptions()[0]).not.toBe(seen[0]);
      for (const event of seen) expect(event.attributes).not.toHaveProperty("error_repeat_count");
    });

    it("sends its own count, whatever a hook left on the event", () => {
      setOptions({
        enrichEvent: (event: BaseEvent) => ({ ...event, attributes: { ...event.attributes, error_repeat_count: 99 } }),
      });
      for (let i = 0; i < 2; i++) eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([2]);
    });

    it("leaves a single occurrence unchanged", () => {
      eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(sentExceptions()[0]!.attributes).not.toHaveProperty("error_repeat_count");
    });

    it("starts again with each batch, and the counts add up across batches", () => {
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      eventsPool.flush();
      for (let i = 0; i < 4; i++) eventsPool.addEvent(exception());
      eventsPool.flush();

      expect(repeatCounts()).toEqual([3, 4]);
      expect(occurrences()).toBe(7);
    });

    it("keeps different errors apart", () => {
      eventsPool.addEvent(exception());
      eventsPool.addEvent(other("Other failure"));
      eventsPool.addEvent(exception());
      eventsPool.flush();

      expect(sentExceptions().map((event) => event.attributes?.error_message)).toEqual([
        "Unable to decode file",
        "Other failure",
      ]);
      expect(repeatCounts()).toEqual([2, undefined]);
    });

    it("never merges other event types", () => {
      for (let i = 0; i < 3; i++) eventsPool.addEvent(createMockEvent({ type: "custom" }));
      eventsPool.flush();
      expect(sentEvents()).toHaveLength(3);
    });

    it("merges error-level logs the same way, counting in log_repeat_count", () => {
      const message = "Network Error: timeout";
      const log = (level: string) =>
        enricher.enrich({ type: "log", attributes: { message, level }, dedup: errorLogDedup(message, level) });
      for (let i = 0; i < 3; i++) eventsPool.addEvent(log("error"));
      for (let i = 0; i < 2; i++) eventsPool.addEvent(log("warn"));
      eventsPool.flush();

      const logs = sentEvents().filter((event) => event.type === "log");
      expect(logs.map((event) => [event.attributes?.level, event.attributes?.log_repeat_count])).toEqual([
        ["error", 3],
        ["warn", undefined],
        ["warn", undefined],
      ]);
    });

    it("keeps repeats on different pages apart, since the enricher puts the page in the key", () => {
      let path = "/checkout";
      const onPage = new EventEnricher({ enrichAttributes: () => ({ location: { path } }) });
      const pageException = () => {
        const attributes = exceptionAttributes();
        return onPage.enrich({ type: "exception", attributes, dedup: exceptionDedup(attributes) });
      };

      eventsPool.addEvent(pageException());
      path = "/cart";
      eventsPool.addEvent(pageException());
      path = "/checkout";
      eventsPool.addEvent(pageException());
      eventsPool.flush();

      expect(repeatCounts()).toEqual([2, undefined]);
    });

    it("never merges a recovered hang, which its listener builds without dedup", () => {
      const stall = () =>
        enricher.enrich({
          type: "exception",
          attributes: {
            error_type: "AppHang",
            error_message: "Main thread blocked for 3000ms",
            error_fingerprint: "AppHang:3s",
            error_handled: false,
            error_stacktrace: [],
          },
        });
      for (let i = 0; i < 3; i++) eventsPool.addEvent(stall());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([undefined, undefined, undefined]);
    });

    it("counts a merged error as one event toward batchSize, so a loop alone goes out with the heartbeat", () => {
      // batchSize is 5 and batchTimeout 1000 in the fake config.
      for (let i = 0; i < 50; i++) eventsPool.addEvent(exception());
      expect(mockSend).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(repeatCounts()).toEqual([50]);
    });

    it("sends interleaved errors when the events to send reach batchSize, not their occurrences", () => {
      for (let i = 0; i < 5; i++) {
        eventsPool.addEvent(exception());
        eventsPool.addEvent(other("Other failure"));
      }
      expect(mockSend).not.toHaveBeenCalled(); // ten occurrences, two events

      for (let i = 0; i < 3; i++) eventsPool.addEvent(createMockEvent({ type: "custom" }));
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(repeatCounts()).toEqual([5, 5]);
    });

    it("a repeat into a buffer already at batchSize sends it, as any event would", () => {
      eventsPool.addEvent(exception());
      // "activity" skips the size send, so the buffer reaches 5 unsent.
      for (let i = 0; i < 4; i++) eventsPool.addEvent(createMockEvent({ type: "activity" }));
      expect(mockSend).not.toHaveBeenCalled();

      eventsPool.addEvent(exception());
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(repeatCounts()).toEqual([2]);
    });

    it("a fractional batchSize sends on the first event at or past it", () => {
      setOptions({ transport: { batchSize: 2.5, batchTimeout: 1000 } });
      eventsPool.addEvent(exception());
      eventsPool.addEvent(other("Second failure"));
      expect(mockSend).not.toHaveBeenCalled();

      eventsPool.addEvent(other("Third failure"));
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("sends a loop as each occurrence alone when batchSize is 0", () => {
      setOptions({ transport: { batchSize: 0, batchTimeout: 1000 } });
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      expect(repeatCounts()).toEqual([undefined, undefined, undefined]);
    });

    it("a lifecycle flush sends the merged event like any other", () => {
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      eventsPool.flush({ lifecycle: true });
      expect(mockSend.mock.calls[0]![1]).toEqual({ lifecycle: true });
      expect(repeatCounts()).toEqual([3]);
    });

    it("discardBuffer drops the merged event, and the next occurrence starts fresh", () => {
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      eventsPool.discardBuffer();
      eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([undefined]);
    });

    it("destroy forgets the merged event", () => {
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      eventsPool.destroy();
      eventsPool.initialize();
      eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([undefined]);
    });

    it("flushSync sends the merged event, and the next occurrence starts fresh", async () => {
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      await eventsPool.flushSync();
      eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([3, undefined]);
    });

    it("sends every exception when deduplication is off", () => {
      setOptions({ errors: { deduplication: { enabled: false } } });
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([undefined, undefined, undefined]);
    });

    it("reads the setting live, so turning it off stops merging at once", () => {
      eventsPool.addEvent(exception());
      eventsPool.addEvent(exception());
      setOptions({ errors: { deduplication: { enabled: false } } });
      eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([2, undefined]);
      expect(occurrences()).toBe(3);
    });

    it("beforeSend sees every occurrence, and one it drops is not counted", () => {
      let calls = 0;
      const beforeSend = vi.fn(() => calls++ % 2 === 0); // keeps the 1st, 3rd, 5th
      setOptions({ beforeSend });

      for (let i = 0; i < 6; i++) eventsPool.addEvent(exception());
      eventsPool.flush();

      expect(beforeSend).toHaveBeenCalledTimes(6);
      expect(repeatCounts()).toEqual([3]);
    });

    it("groups as the SDK built the event: a hook rewriting or replacing it can't change that", () => {
      let i = 0;
      setOptions({
        enrichEvent: (event: BaseEvent) => ({
          ...event,
          attributes: { ...event.attributes, error_fingerprint: `custom:${i++}` },
        }),
      });
      for (let n = 0; n < 3; n++) eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([3]);
      expect(sentExceptions()[0]!.attributes?.error_fingerprint).toBe("custom:0");
    });

    it("sends on its own an event a hook turned into another type", () => {
      setOptions({ enrichEvent: (event: BaseEvent) => ({ ...event, type: "custom" }) });
      for (let n = 0; n < 3; n++) eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(sentEvents().map((event) => [event.type, event.attributes?.error_repeat_count])).toEqual([
        ["custom", undefined],
        ["custom", undefined],
        ["custom", undefined],
      ]);
    });

    it("never sends dedup, and the hooks don't see it", () => {
      const seen: string[][] = [];
      setOptions({ beforeSend: (event: BaseEvent) => (seen.push(Object.keys(event)), true) });
      for (let n = 0; n < 2; n++) eventsPool.addEvent(exception());
      eventsPool.flush();

      expect(seen.flat()).not.toContain("dedup");
      expect(JSON.stringify(sentEvents())).not.toContain("dedup");
    });

    it("merges an event enrichEvent froze, since the count goes on a copy", () => {
      setOptions({
        enrichEvent: (event: BaseEvent) => Object.freeze({ ...event, attributes: Object.freeze({ ...event.attributes }) }),
      });
      for (let i = 0; i < 2; i++) eventsPool.addEvent(exception());
      eventsPool.flush();
      expect(repeatCounts()).toEqual([2]);
    });

    it("lets the session observer see every occurrence", () => {
      const observer = vi.fn();
      eventsPool.setBeforeEnqueueHook(observer);
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      expect(observer).toHaveBeenCalledTimes(3);
    });

    it("an error loop before presence takes one slot in the gated buffer", () => {
      eventsPool.setFlushGate(() => false);
      for (let i = 0; i < MAX_GATED_BUFFER_EVENTS + 100; i++) eventsPool.addEvent(exception());
      eventsPool.addEvent(createMockEvent({ type: "custom", id: "real-user-event" }));

      eventsPool.setFlushGate(null);
      eventsPool.flush();

      expect(sentEvents().map((event) => event.id)).toContain("real-user-event");
      expect(repeatCounts()).toEqual([MAX_GATED_BUFFER_EVENTS + 100]);
    });

    it("while sends are held, a loop alone never asks for a send, and the heartbeat sends it once allowed", () => {
      eventsPool.setFlushGate(() => false);
      const flush = vi.spyOn(eventsPool, "flush");
      for (let i = 0; i < 50; i++) eventsPool.addEvent(exception());
      expect(flush).not.toHaveBeenCalled();

      eventsPool.setFlushGate(null);
      vi.advanceTimersByTime(1000);
      expect(repeatCounts()).toEqual([50]);
    });

    it("a held buffer keeps counting until it is sent", () => {
      eventsPool.setFlushGate(() => false);
      for (let i = 0; i < 3; i++) eventsPool.addEvent(exception());
      vi.advanceTimersByTime(5000); // heartbeats while gated: held, not cleared
      for (let i = 0; i < 2; i++) eventsPool.addEvent(exception());

      eventsPool.setFlushGate(null);
      eventsPool.flush();
      expect(repeatCounts()).toEqual([5]);
    });
  });
});
