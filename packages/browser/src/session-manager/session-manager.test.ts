import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { SessionManager } from "./session-manager";
import { SAMPLING_STORAGE_KEY } from "@groundcover/rum-core/config/constants";
import { WorkerClient } from "../worker/worker-client";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { SessionState } from "@groundcover/rum-core/session/session-state";
import { SafeStorage } from "@groundcover/rum-core/common/storage";
import { Logger } from "@groundcover/rum-core/common/logger";
import { msToNs } from "@groundcover/rum-core/common/global";
import type { UserIdentifiers } from "@groundcover/rum-core/events/types";
import type { SDKConfigInput } from "../config/types";
import { BROWSER_CONFIG_EXTENSION } from "../config/config-extension";

// SessionManager is the composition root, so the module mocks below replace each class with
// a constructor returning a shared, inspectable fake. vi.hoisted makes those visible to both
// the hoisted vi.mock factories and the test bodies.
//
// Session identity lives in SessionState, so the session API fake is the SessionState fake.
// bootstrapSession is NOT mocked: the real init-time resolution runs against the SessionState
// fake, so the rotation and continuation scenarios exercise the real policy.
const {
  configManagerInstance,
  sessionStateInstance,
  eventsPoolInstance,
  mockInstrument,
  mockUninstrument,
  mockSendCustomEvent,
  mockIsReplayRecording,
  mockStartReplayRecording,
  mockStopReplayRecording,
  mockFlushPendingReplay,
  mockRestartReplayForConfigChange,
} = vi.hoisted(() => {
  const session: Record<string, ReturnType<typeof vi.fn> | ((nowMs?: number) => boolean)> = {
    getSessionId: vi.fn().mockReturnValue("existing-session-id"),
    setSessionId: vi.fn(),
    // Return a fresh start time (ns) so the init-time-expired branch
    // doesn't fire by default. Tests that exercise that branch override.
    getSessionStartTime: vi.fn().mockImplementation(() => Date.now() * 1_000_000),
    setSessionStartTime: vi.fn(),
    getSessionMaxDuration: vi.fn().mockReturnValue(4 * 60 * 60 * 1000),
    // No recorded activity by default so the init-time gap branch doesn't
    // fire. Tests that exercise that branch override.
    getLastActivityMs: vi.fn().mockReturnValue(0),
    setLastActivityMs: vi.fn(),
    persistLastActivity: vi.fn(),
    clearSamplingDecision: vi.fn(),
    clearSessionState: vi.fn(),
    // Presence/confirmation signal — the flush gate is `() => hasUserActivity()`.
    // Default confirmed; tests override to exercise the unconfirmed path.
    hasUserActivity: vi.fn().mockReturnValue(true),
  };
  // Mirror the real cap rule off the instance's (test-reassignable) getters.
  session.isSessionExpired = (nowMs: number = Date.now()) => {
    const startNs = (session.getSessionStartTime as Mock<() => number>)();
    if (!startNs) return false;
    return nowMs - startNs / 1_000_000 >= (session.getSessionMaxDuration as Mock<() => number>)();
  };
  // Mirror the real inactivity-gap rule the same way.
  session.isSessionInactive = (nowMs: number = Date.now()) => {
    const lastActivityMs = (session.getLastActivityMs as Mock<() => number>)();
    const startNs = (session.getSessionStartTime as Mock<() => number>)();
    // Before the first stamp, measure the gap from birth (matches session-state).
    const baseline = lastActivityMs > 0 ? lastActivityMs : startNs / 1_000_000;
    return baseline > 0 && nowMs - baseline >= 30 * 60 * 1000;
  };

  return {
    configManagerInstance: {
      initialize: vi.fn(),
      updateConfig: vi.fn(),
      getConfig: vi.fn().mockReturnValue({
        options: {
          debug: false,
          sessionMaxDuration: 4 * 60 * 60 * 1000,
        },
      }),
    },
    sessionStateInstance: session,
    eventsPoolInstance: {
      initialize: vi.fn(),
      flush: vi.fn(),
      flushSync: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    },
    mockInstrument: vi.fn(),
    mockUninstrument: vi.fn(),
    mockSendCustomEvent: vi.fn(),
    mockIsReplayRecording: vi.fn().mockReturnValue(false),
    mockStartReplayRecording: vi.fn(),
    mockStopReplayRecording: vi.fn(),
    mockFlushPendingReplay: vi.fn(),
    mockRestartReplayForConfigChange: vi.fn(),
  };
});

// Mock all dependencies: every `new X(...)` inside SessionManager returns the
// shared fake for that class.
vi.mock("@groundcover/rum-core/config/config-manager", () => ({
  ConfigManager: vi.fn(function () { return configManagerInstance; }),
}));

vi.mock("@groundcover/rum-core/session/session-state", () => ({
  SessionState: vi.fn(function () { return sessionStateInstance; }),
}));

vi.mock("@groundcover/rum-core/events/events-pool", () => ({
  EventsPool: vi.fn(function () { return eventsPoolInstance; }),
}));

vi.mock("@groundcover/rum-core/events/event-enricher", () => ({
  EventEnricher: vi.fn(function () { return {}; }),
}));

vi.mock("@groundcover/rum-core/transporter/transporter", () => ({
  Transporter: vi.fn(function () { return {}; }),
  encodeInline: vi.fn(),
}));

vi.mock("../events/instrumentation-manager", () => ({
  InstrumentationManager: vi.fn().mockImplementation(function () {
    return {
      instrument: mockInstrument,
      uninstrument: mockUninstrument,
      sendCustomEvent: mockSendCustomEvent,
      isReplayRecording: mockIsReplayRecording,
      startReplayRecording: mockStartReplayRecording,
      stopReplayRecording: mockStopReplayRecording,
      flushPendingReplay: mockFlushPendingReplay,
      restartReplayForConfigChange: mockRestartReplayForConfigChange,
    };
  }),
}));

vi.mock("../worker/worker-client", () => ({
  WorkerClient: {
    getInstance: vi.fn().mockReturnValue({
      isAvailable: false,
      packReplay: vi.fn(),
      encodeBatch: vi.fn(),
      terminate: vi.fn(),
    }),
    withFallback: vi.fn(async (_op: unknown, inline: () => unknown) => inline()),
  },
}));

vi.mock("@groundcover/rum-core/common/logger", () => ({
  Logger: {
    getInstance: vi.fn().mockReturnValue({ log: vi.fn() }),
    initialize: vi.fn().mockReturnValue({
      log: vi.fn(),
    }),
  },
}));

vi.mock("@groundcover/rum-core/common/id-generator", () => ({
  RandomIdGenerator: class MockRandomIdGenerator {
    generateId = vi.fn().mockReturnValue("test-session-id");
  },
}));

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let mockRandom: ReturnType<typeof vi.spyOn>;

  const validConfig: SDKConfigInput = {
    apiKey: "test-api-key",
    cluster: "test-cluster",
    environment: "test-environment",
    dsn: "https://test.com",
    appId: "test-app",
    options: {
      debug: false,
      transport: {
        batchSize: 10,
        batchTimeout: 5000,
      },
      enabledEvents: [],
      sessionSampleRate: 1,
      privacy: { maskSelectors: ["password"] },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRandom = vi.spyOn(Math, 'random');

    // Reset session storage with mock functions that can be spied on.
    // SessionManager wraps this in SafeStorage via getSessionStoragePlatform().
    const sessionStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };
    Object.defineProperty(window, "sessionStorage", {
      value: sessionStorageMock,
      writable: true,
    });

    // Create new instance for each test with config
    sessionManager = new SessionManager(validConfig);
  });

  afterEach(() => {
    mockRandom.mockRestore();
  });

  describe("constructor", () => {
    it("tears down live resources and rethrows when startup throws mid-constructor", () => {
      // If instrument() (or any startup step after resources go live) throws,
      // the already-armed pool heartbeat timer and hide listener must not
      // leak: `core` is assigned last, so destroy() alone can't reach them.
      mockInstrument.mockImplementationOnce(() => {
        throw new Error("instrument failed");
      });

      // Rethrows so init()'s `manager = new SessionManager(...)` assignment
      // never completes; init() contains the error and permits a later retry.
      expect(() => new SessionManager(validConfig)).toThrow("instrument failed");

      // The half-started instrumentation and pool are torn down…
      expect(mockUninstrument).toHaveBeenCalled();
      expect(eventsPoolInstance.destroy).toHaveBeenCalled();
      // …but the SHARED worker is not terminated during rollback — a
      // still-healthy manager may be using it mid-flight.
      expect(
        vi.mocked(WorkerClient.getInstance)().terminate
      ).not.toHaveBeenCalled();
    });

    it("should initialize successfully with valid config", () => {
      // Create a new instance to verify constructor behavior
      new SessionManager(validConfig);

      // DI wiring: ConfigManager is config-only (no constructor args);
      // SessionState owns session identity over SafeStorage; the pool is
      // built over both through constructor injection.
      expect(vi.mocked(ConfigManager)).toHaveBeenCalledWith(BROWSER_CONFIG_EXTENSION);
      expect(vi.mocked(SessionState)).toHaveBeenCalledWith({
        storage: expect.any(SafeStorage),
        getMaxDurationMs: expect.any(Function),
      });
      expect(vi.mocked(EventsPool)).toHaveBeenCalledWith({
        config: configManagerInstance,
        session: sessionStateInstance,
        transporter: expect.anything(),
        getDeviceAttributes: expect.any(Function),
        // Platform-owned flush policy: core's pool does not hardcode which
        // event types skip the batch flush; the browser passes its own set.
        eventsToSkipFlush: ["navigation", "dom.event"],
      });

      expect(configManagerInstance.initialize).toHaveBeenCalledWith(
        validConfig
      );
      expect(eventsPoolInstance.initialize).toHaveBeenCalled();

      expect(mockInstrument).toHaveBeenCalled();
    });

    it("should initialize logger with correct debug setting", () => {
      const debugConfig = {
        ...validConfig,
        options: { ...validConfig.options, debug: true },
      };

      new SessionManager(debugConfig);

      expect(Logger.initialize).toHaveBeenCalledWith({
        debug: true,
        prefix: "[groundcover]",
      });
    });

    it("should use provided sessionId when available", () => {
      const providedSessionId = "provided-session-id-123";
      const configWithSessionId = {
        ...validConfig,
        sessionId: providedSessionId,
      };

      new SessionManager(configWithSessionId);

      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith(providedSessionId);
    });

    it("should generate new sessionId when no sessionId provided and no existing session", () => {
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue(""); // No existing session

      new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith("test-session-id");
    });

    it("should not override existing session when no sessionId provided", () => {
      const existingSessionId = "existing-session-id";
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue(existingSessionId);

      // Clear any previous calls to setSessionId
      vi.clearAllMocks();

      new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionId).not.toHaveBeenCalled();
    });

    it("should prioritize provided sessionId over existing session", () => {
      const providedSessionId = "provided-session-id-456";
      const existingSessionId = "existing-session-id";
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue(existingSessionId);

      const configWithSessionId = {
        ...validConfig,
        sessionId: providedSessionId,
      };

      new SessionManager(configWithSessionId);

      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith(providedSessionId);
    });

    it("should set session start time on first init", () => {
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(0);

      vi.clearAllMocks();

      new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionStartTime).toHaveBeenCalledWith(expect.any(Number));
    });

    it("should not overwrite session start time if already set (e.g. after refresh)", () => {
      // Fresh start time (ns) so the init-time-expired branch doesn't trip.
      const existingStartTime = msToNs(Date.now());
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(existingStartTime);

      vi.clearAllMocks();

      new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionStartTime).not.toHaveBeenCalled();
    });
  });

  describe("identifyUser", () => {
    const userIdentifier: Partial<UserIdentifiers> = {
      id: "user123",
      email: "test@example.com",
    };

    it("should update config with user identifier", () => {
      sessionManager.identifyUser(userIdentifier);

      expect(configManagerInstance.updateConfig).toHaveBeenCalledWith({
        user: userIdentifier,
      });
    });
  });

  describe("updateConfig", () => {
    it("should call ConfigManager updateConfig when initialized", () => {
      const updateParams = {
        options: {
          debug: true,
          transport: {
            batchSize: 20,
          },
        },
        user: {
          id: "new-user",
          email: "new@example.com",
        },
      };

      sessionManager.updateConfig(updateParams);

      expect(configManagerInstance.updateConfig).toHaveBeenCalledWith(updateParams);
    });

    it("should not update config when not initialized", () => {
      // Create a new session manager but don't initialize it
      const uninitializedManager = new SessionManager(validConfig);
      // Manually set initialized to false to simulate uninitialized state
      // The initialized flag is the atomically-set `core` bundle.
      Object.defineProperty(uninitializedManager, 'core', {
        value: null,
        writable: true,
        configurable: true
      });

      const updateParams = {
        options: {
          debug: true,
        },
      };

      uninitializedManager.updateConfig(updateParams);

      // Should not call updateConfig on ConfigManager
      expect(configManagerInstance.updateConfig).not.toHaveBeenCalledWith(updateParams);
    });

    it("should handle options-only updates", () => {
      const optionsUpdate = {
        options: {
          debug: false,
          transport: {
            batchSize: 50,
          },
        },
      };

      sessionManager.updateConfig(optionsUpdate);

      expect(configManagerInstance.updateConfig).toHaveBeenCalledWith(optionsUpdate);
    });

    it("should handle user-only updates", () => {
      const userUpdate = {
        user: {
          id: "updated-user",
          email: "updated@example.com",
        },
      };

      sessionManager.updateConfig(userUpdate);

      expect(configManagerInstance.updateConfig).toHaveBeenCalledWith(userUpdate);
    });

    // rrweb mask/block selectors and canvas options are fixed at record() time,
    // so a runtime change to any of them only takes effect once recording restarts.
    it("restarts replay when privacy changes", () => {
      sessionManager.updateConfig({ options: { privacy: { level: "mask-all" } } });
      expect(mockRestartReplayForConfigChange).toHaveBeenCalledTimes(1);
    });

    it("restarts replay when replay.blockedSelectors changes", () => {
      sessionManager.updateConfig({
        options: { replay: { blockedSelectors: [".ad", ".widget"] } },
      });
      expect(mockRestartReplayForConfigChange).toHaveBeenCalledTimes(1);
    });

    it("restarts replay when replay.canvas changes", () => {
      sessionManager.updateConfig({
        options: { replay: { canvas: { enabled: true, fps: 2 } } },
      });
      expect(mockRestartReplayForConfigChange).toHaveBeenCalledTimes(1);
    });

    // SDKConfig merges own properties only, so an inherited key never changes the
    // effective config — restarting for it would just split the recording.
    it("does not restart replay for inherited (non-own) record()-time keys", () => {
      const replay = Object.create({ canvas: { enabled: true }, blockedSelectors: [".ad"] });
      sessionManager.updateConfig({ options: { replay } });

      const options = Object.create({ privacy: { level: "mask-all" } });
      sessionManager.updateConfig({ options });

      expect(mockRestartReplayForConfigChange).not.toHaveBeenCalled();
    });

    it("does not restart replay for updates that don't affect record()-time config", () => {
      sessionManager.updateConfig({
        options: { transport: { batchSize: 20 }, debug: true },
      });
      expect(mockRestartReplayForConfigChange).not.toHaveBeenCalled();
    });
  });

  describe("sendCustomEvent", () => {
    it("should send custom event", () => {
      sessionManager.sendCustomEvent({
        event: "test-event",
        attributes: {
          key: "value",
        },
      });

      expect(mockSendCustomEvent).toHaveBeenCalledWith({
        event: "test-event",
        attributes: { key: "value" },
      });
    });

    it("should handle event without attributes", () => {
      const simpleEvent = { event: "test-event", attributes: {} };
      sessionManager.sendCustomEvent(simpleEvent);

      expect(mockSendCustomEvent).toHaveBeenCalledWith(simpleEvent);
    });
  });

  describe("destroy", () => {
    it("should cleanup resources", () => {
      sessionManager.destroy();

      expect(mockUninstrument).toHaveBeenCalled();
      // Session-scoped state teardown is SessionState's job (storage keys +
      // in-memory mirrors); the pool stops its flush heartbeat.
      expect(sessionStateInstance.clearSessionState).toHaveBeenCalled();
      expect(eventsPoolInstance.destroy).toHaveBeenCalled();
    });
  });

  describe("sampling decision", () => {
    it("should store sampling decision as 0 or 1", () => {
      mockRandom.mockReturnValue(0.4);
      const config = { ...validConfig, options: { ...validConfig.options, sessionSampleRate: 0.3 }};

      new SessionManager(config);

      expect(window.sessionStorage.setItem).toHaveBeenCalledWith(SAMPLING_STORAGE_KEY, "0");

      mockRandom.mockReturnValue(0.2);
      new SessionManager(config);

      expect(window.sessionStorage.setItem).toHaveBeenCalledWith(SAMPLING_STORAGE_KEY, "1");
    });

    it("should reuse existing sampling decision", () => {
      (window.sessionStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue("1");
      mockRandom.mockReturnValue(0.9);

      const config = { ...validConfig, options: { ...validConfig.options, sessionSampleRate: 0.3 }};
      new SessionManager(config);

      expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
      expect(mockInstrument).toHaveBeenCalled();
    });

    it("should handle session storage access failure gracefully", () => {
      (window.sessionStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Storage access denied");
      });

      mockRandom.mockReturnValue(0.2);
      const config = { ...validConfig, options: { ...validConfig.options, sessionSampleRate: 0.3 }};

      new SessionManager(config);

      expect(mockInstrument).toHaveBeenCalled();
    });

    it("re-rolls a stored sample-out verdict when a different sessionId starts a new session", () => {
      // Ordering: if the sampling verdict were read BEFORE bootstrapSession, a
      // persisted "0" would return from the constructor before a different
      // provided sessionId could clear and re-roll it — pinning that browser
      // sampled-out for the storage lifetime instead of once per session.
      // bootstrap must run first.
      //
      // Map-backed sessionStorage so the real resolveSamplingDecision and the
      // (mocked) SessionState.clearSamplingDecision talk through ONE store —
      // otherwise the mock can't clear what resolveSamplingDecision reads.
      const store = new Map<string, string>([[SAMPLING_STORAGE_KEY, "0"]]);
      Object.defineProperty(window, "sessionStorage", {
        value: {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
          clear: () => store.clear(),
        },
        writable: true,
      });
      sessionStateInstance.clearSamplingDecision = vi.fn(() =>
        store.delete(SAMPLING_STORAGE_KEY)
      );
      // Existing session differs from the one we provide → bootstrap treats it
      // as a new session, clears the stale verdict, and the roll below re-runs.
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("old-session");
      // The post-clear roll lands "sampled in" (0 < 0.5) so a correct impl inits.
      mockRandom.mockReturnValue(0);

      new SessionManager({
        ...validConfig,
        sessionId: "new-session",
        options: { ...validConfig.options, sessionSampleRate: 0.5 },
      });

      // The new session must be adopted and the SDK must come up: the early
      // return on a stored "0" must not skip either.
      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith("new-session");
      expect(mockInstrument).toHaveBeenCalled();
    });
  });

  describe("getSessionId", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should return empty string when not initialized", () => {
      const uninitializedManager = new SessionManager(validConfig);
      // The initialized flag is the atomically-set `core` bundle.
      Object.defineProperty(uninitializedManager, 'core', {
        value: null,
        writable: true,
        configurable: true,
      });

      (sessionStateInstance.getSessionId as ReturnType<typeof vi.fn>).mockClear();

      const result = uninitializedManager.getSessionId();

      expect(result).toBe("");
      expect(sessionStateInstance.getSessionId).not.toHaveBeenCalled();
    });

    it("should return value from SessionState when initialized", () => {
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("active-session-id");

      const result = sessionManager.getSessionId();

      expect(result).toBe("active-session-id");
      expect(sessionStateInstance.getSessionId).toHaveBeenCalled();
    });
  });

  describe("setSessionId", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should flush events and generate new session ID when called without parameter", async () => {
      await sessionManager.setSessionId();

      expect(eventsPoolInstance.flushSync).toHaveBeenCalled();
      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith("test-session-id");
    });

    it("should flush events and use provided session ID when called with parameter", async () => {
      const customSessionId = "custom-session-id-123";

      await sessionManager.setSessionId(customSessionId);

      expect(eventsPoolInstance.flushSync).toHaveBeenCalled();
      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith(customSessionId);
    });

    it("should not set session ID when not initialized", async () => {
      // Create a new session manager but don't initialize it
      const uninitializedManager = new SessionManager(validConfig);
      // Manually set initialized to false to simulate uninitialized state
      // The initialized flag is the atomically-set `core` bundle.
      Object.defineProperty(uninitializedManager, 'core', {
        value: null,
        writable: true,
        configurable: true
      });

      await uninitializedManager.setSessionId("new-session-id");

      expect(eventsPoolInstance.flushSync).not.toHaveBeenCalled();
      expect(sessionStateInstance.setSessionId).not.toHaveBeenCalledWith("new-session-id");
    });

    it("should handle errors gracefully during session ID change", async () => {
      eventsPoolInstance.flushSync.mockRejectedValueOnce(
        new Error("Flush failed")
      );

      // Should not throw even if flush fails
      await expect(sessionManager.setSessionId("error-test-id")).resolves.not.toThrow();
    });
  });

  // Max-duration rotation is lazy (driven by InstrumentationManager's
  // beforeEnqueue hook — tested in instrumentation-manager.test.ts). The only
  // max-duration responsibility at init is bootstrapSession's init-time
  // check (running for real against the SessionState fake): rotate before
  // instrument() if the persisted session is already expired.
  describe("init-time expiry rotation", () => {
    it("rotates at init when persisted session is already expired", () => {
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("stale-id");
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(
        msToNs(Date.now() - 5 * 60 * 60 * 1000)
      );

      vi.clearAllMocks();
      const manager = new SessionManager(validConfig);

      // setSessionId called with the fresh generated id during init-time rotation
      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith("test-session-id");
      // instrument runs after the rotation, exactly once
      expect(mockInstrument).toHaveBeenCalledTimes(1);

      manager.destroy();
    });

    it("preserves provided sessionId and resets start time (no init-time rotation)", () => {
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("");
      // Stateful start time: it begins stale (would trip init-time rotation),
      // but the provided-id branch resets it to "now", so the init-time-expiry
      // check below must see a fresh time and NOT rotate. (Without the stateful
      // read, a fixed stale value masks a spurious second rotation.)
      let storedStartNs = msToNs(Date.now() - 10 * 60 * 60 * 1000);
      sessionStateInstance.getSessionStartTime = vi.fn(() => storedStartNs);
      sessionStateInstance.setSessionStartTime = vi.fn((v: number) => {
        storedStartNs = v;
      });

      vi.clearAllMocks();
      const manager = new SessionManager({ ...validConfig, sessionId: "provided-fixed-id" });

      const setSessionIdMock = sessionStateInstance.setSessionId as ReturnType<typeof vi.fn>;
      // Adopt the provided id exactly once — no second (init-expiry) rotation.
      expect(setSessionIdMock).toHaveBeenCalledTimes(1);
      expect(setSessionIdMock).toHaveBeenCalledWith("provided-fixed-id");

      manager.destroy();
    });

    it("keeps the stored start time when the same id is re-provided (continuation)", () => {
      // Re-syncing the SAME id (reload / sibling MFE) is a continuation: adopt
      // the id but do NOT reset the clock, so session_start_time keeps marking
      // the true start. Within the cap, no rotation happens.
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("synced-id");
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(
        msToNs(Date.now() - 5 * 60 * 1000) // 5 min ago — within the 4h cap
      );
      sessionStateInstance.setSessionStartTime = vi.fn();

      vi.clearAllMocks();
      const manager = new SessionManager({ ...validConfig, sessionId: "synced-id" });

      const setSessionIdMock = sessionStateInstance.setSessionId as ReturnType<typeof vi.fn>;
      expect(setSessionIdMock).toHaveBeenCalledTimes(1);
      expect(setSessionIdMock).toHaveBeenCalledWith("synced-id");
      // Clock not reset — true start preserved.
      expect(sessionStateInstance.setSessionStartTime).not.toHaveBeenCalled();

      manager.destroy();
    });

    it("rotates a re-provided same id whose stored start time is past the cap", () => {
      // Continuation keeps the stale start time, so a session genuinely past
      // the cap rotates honestly to a fresh generated id (cap wins over the
      // re-synced id — the deliberate policy choice).
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("synced-id");
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(
        msToNs(Date.now() - 5 * 60 * 60 * 1000) // 5h ago — past the 4h cap
      );

      vi.clearAllMocks();
      const manager = new SessionManager({ ...validConfig, sessionId: "synced-id" });

      const calls = (sessionStateInstance.setSessionId as ReturnType<typeof vi.fn>).mock.calls;
      // Adopts the provided id, then init-time expiry rotates it to a fresh one.
      expect(calls).toContainEqual(["synced-id"]);
      expect(calls).toContainEqual(["test-session-id"]);

      manager.destroy();
    });

    it("does not rotate at init when the persisted start time is in the future", () => {
      // A future timestamp (clock skew / corruption) is treated as invalid, not
      // expired: reset to a fresh start time, keep the existing id (no rotation).
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("existing-id");
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(
        msToNs(Date.now() + 60 * 60 * 1000)
      );

      vi.clearAllMocks();
      const manager = new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionId).not.toHaveBeenCalled();
      expect(sessionStateInstance.setSessionStartTime).toHaveBeenCalled();

      manager.destroy();
    });

    it("rotates at init when the persisted session has an inactivity gap (reload after a long break)", () => {
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("stale-id");
      // Start time is fresh enough (within the cap) but the last recorded
      // activity is older than the 30-minute idle window.
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(
        msToNs(Date.now() - 60 * 60 * 1000) // 1h ago — within the 4h cap
      );
      sessionStateInstance.getLastActivityMs = vi.fn().mockReturnValue(
        Date.now() - 45 * 60 * 1000 // 45 min ago — past the 30 min idle window
      );

      vi.clearAllMocks();
      const manager = new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith("test-session-id");
      expect(mockInstrument).toHaveBeenCalledTimes(1);

      manager.destroy();
    });

    it("rotates at init when an UNCONFIRMED reloaded session is past the idle window (gap measured from birth)", () => {
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("stale-unconfirmed-id");
      // Never confirmed → clock unstamped (0); the gap is measured from the start
      // via the fallback, so a session born past the idle window still rotates.
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(
        msToNs(Date.now() - 45 * 60 * 1000) // 45 min ago — within the cap, past the idle window
      );
      sessionStateInstance.getLastActivityMs = vi.fn().mockReturnValue(0);

      vi.clearAllMocks();
      const manager = new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionId).toHaveBeenCalledWith("test-session-id");
      expect(mockInstrument).toHaveBeenCalledTimes(1);

      manager.destroy();
    });

    it("does not rotate at init when the activity gap is within the idle window", () => {
      sessionStateInstance.getSessionId = vi.fn().mockReturnValue("recent-id");
      sessionStateInstance.getSessionStartTime = vi.fn().mockReturnValue(
        msToNs(Date.now() - 60 * 60 * 1000) // 1h ago — within the cap
      );
      sessionStateInstance.getLastActivityMs = vi.fn().mockReturnValue(
        Date.now() - 10 * 60 * 1000 // 10 min ago — within the idle window
      );

      vi.clearAllMocks();
      const manager = new SessionManager(validConfig);

      expect(sessionStateInstance.setSessionId).not.toHaveBeenCalled();

      manager.destroy();
    });
  });

  // App-hide wiring lives in SessionManager, not EventsPool: it owns the
  // document visibilitychange listener and, on hidden, persists the exact
  // activity timestamp (steady-state writes are throttled) before the
  // lifecycle flush. The listener registry is stubbed locally so leftover
  // listeners from other tests' undestroyed managers can't contaminate the
  // call counts — invoking the captured handlers IS the dispatch.
  describe("app-hide wiring (visibilitychange)", () => {
    let visibilityListeners: Set<EventListener>;
    let addSpy: ReturnType<typeof vi.spyOn>;
    let removeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      visibilityListeners = new Set();
      addSpy = vi
        .spyOn(document, "addEventListener")
        .mockImplementation((type: string, handler: unknown) => {
          if (type === "visibilitychange") {
            visibilityListeners.add(handler as EventListener);
          }
        });
      removeSpy = vi
        .spyOn(document, "removeEventListener")
        .mockImplementation((type: string, handler: unknown) => {
          if (type === "visibilitychange") {
            visibilityListeners.delete(handler as EventListener);
          }
        });
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
    });

    afterEach(() => {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    const dispatchHide = () => {
      for (const listener of [...visibilityListeners]) {
        (listener as (event: Event) => void)(new Event("visibilitychange"));
      }
    };

    it("persists the last activity and lifecycle-flushes the pool when the document becomes hidden", () => {
      const manager = new SessionManager(validConfig);

      dispatchHide();

      expect(sessionStateInstance.persistLastActivity).toHaveBeenCalledTimes(1);
      expect(eventsPoolInstance.flush).toHaveBeenCalledWith({ lifecycle: true });

      manager.destroy();
    });

    it("destroy() removes the visibilitychange listener (no calls after destroy)", () => {
      const manager = new SessionManager(validConfig);
      expect(visibilityListeners.size).toBe(1);

      manager.destroy();
      expect(visibilityListeners.size).toBe(0);

      vi.clearAllMocks();
      dispatchHide();

      expect(sessionStateInstance.persistLastActivity).not.toHaveBeenCalled();
      expect(eventsPoolInstance.flush).not.toHaveBeenCalled();
    });
  });
});
