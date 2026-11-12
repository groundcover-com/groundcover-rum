import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { record } from "rrweb";
import { pack } from "@rrweb/packer";
import { SessionReplayListener } from "./session-replay-listener";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { SessionState } from "@groundcover/rum-core/session/session-state";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";

let mockEmitCallback: ((event: unknown, isCheckout?: boolean) => void) | null =
  null;
const mockStopFn = vi.fn();

vi.mock("rrweb", () => ({
  record: vi.fn((options: { emit: typeof mockEmitCallback }) => {
    mockEmitCallback = options.emit;
    return mockStopFn;
  }),
}));

// DI: config is a fake passed through the constructor deps.
const mockGetConfig = vi.fn();
const mockGetPrivacy = vi.fn();
const fakeConfig = {
  getConfig: mockGetConfig,
  getPrivacy: mockGetPrivacy,
} as unknown as ConfigManager;

// DI: fake SessionState — the listener's mid-pack rotation check reads the
// session id from here (session identity lives here, not in ConfigManager).
const mockGetSessionId = vi.fn().mockReturnValue("test-session-id");
const fakeSession = {
  getSessionId: mockGetSessionId,
} as unknown as SessionState;

// Default effective privacy used by most tests (mask-sensitive): only sensitive
// inputs masked; static text visible except data-private subtrees.
const defaultPrivacy = {
  level: "mask-sensitive" as const,
  maskTextSelector: "[data-private]",
  maskSelectors: [],
  maskInputs: true,
  maskNetworkBodies: true,
  maskNetworkQueryParams: true,
  maskLogs: true,
  maskErrors: true,
  sensitiveKeys: [],
};

vi.mock("@rrweb/packer", () => ({
  pack: vi.fn((event: unknown) => `packed:${event}`),
}));

vi.mock("@groundcover/rum-core/common/logger", () => ({
  Logger: {
    getInstance: () => ({
      log: vi.fn(),
    }),
  },
}));

// DI: events pool and enricher are fakes passed through the constructor deps.
// The identity enrich keeps each enqueued event exactly as the listener built it.
const mockAddEvent = vi.fn();
const fakeEventsPool = { addEvent: mockAddEvent } as unknown as EventsPool;
const fakeEnricher = {
  enrich: vi.fn((event: unknown) => event),
} as unknown as EventEnricher;

// Controllable WorkerClient — every test starts with isAvailable=false (inline
// path stays synchronous, matching production CSP-fallback / no-worker envs).
// Tests that exercise the worker branch flip isAvailable=true and stub
// packReplay with a resolved or deferred promise.
const mockWorker = {
  isAvailable: false,
  packReplay: vi.fn(),
};
vi.mock("@/worker/worker-client", () => ({
  WorkerClient: {
    getInstance: () => mockWorker,
  },
}));

const mockedPack = vi.mocked(pack);
const mockedRecord = vi.mocked(record);

describe("SessionReplayListener", () => {
  let listener: SessionReplayListener;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEmitCallback = null;
    mockStopFn.mockClear();
    // mockReset (not mockClear) so test-set implementations don't leak.
    mockAddEvent.mockReset();
    mockedPack.mockClear();
    mockedRecord.mockClear();
    mockGetConfig.mockReset();
    mockGetConfig.mockReturnValue(null);
    mockGetPrivacy.mockReset();
    mockGetPrivacy.mockReturnValue(defaultPrivacy);
    mockGetSessionId.mockReset();
    mockGetSessionId.mockReturnValue("test-session-id");
    mockWorker.isAvailable = false;
    mockWorker.packReplay.mockReset();
    listener = new SessionReplayListener({
      config: fakeConfig,
      session: fakeSession,
      eventsPool: fakeEventsPool,
      enricher: fakeEnricher,
    });
  });

  afterEach(() => {
    listener.destroy();
    vi.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Lifecycle paths
  // ────────────────────────────────────────────────────────────────────────
  describe("lifecycle", () => {
    it("initialize starts rrweb recording", () => {
      listener.initialize();
      expect(mockedRecord).toHaveBeenCalledTimes(1);
      // @ts-expect-error private state
      expect(listener.isRecording).toBe(true);
    });

    it("initialize twice is a no-op (no second record() call)", () => {
      listener.initialize();
      listener.initialize();
      expect(mockedRecord).toHaveBeenCalledTimes(1);
    });

    it("cleans up internal state even when rrweb returns no stop handle", () => {
      mockedRecord.mockReturnValueOnce(undefined as never);
      listener.initialize();
      // @ts-expect-error private state
      expect(listener.isRecording).toBe(true);
      // @ts-expect-error private state
      expect(listener.stopFn).toBeNull();

      listener.stopRecording();
      // @ts-expect-error private state
      expect(listener.isRecording).toBe(false);
    });

    it("destroy() stops the recording and drains buffered events", () => {
      listener.initialize();
      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");

      listener.destroy();

      expect(mockStopFn).toHaveBeenCalledTimes(1);
      expect(mockAddEvent).toHaveBeenCalledTimes(1);
    });

    it("routes rrweb recorder errors through handleError and suppresses them", async () => {
      // rrweb's async observers (incl. the canvas snapshot loop) throw AFTER
      // record() returns — record()'s errorHandler must keep them in the SDK.
      const errorHandlerMod = await import("@groundcover/rum-core/common/error-handler");
      const spy = vi
        .spyOn(errorHandlerMod, "handleError")
        .mockImplementation(() => {});

      listener.initialize();
      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      const errorHandler = options.errorHandler as (e: unknown) => boolean;
      expect(typeof errorHandler).toBe("function");

      const boom = new Error("rrweb observer boom");
      // Returning true tells rrweb the error is handled (don't rethrow).
      expect(errorHandler(boom)).toBe(true);
      expect(spy).toHaveBeenCalledWith(boom);

      spy.mockRestore();
    });

    it("emit while not recording does not buffer or schedule", () => {
      listener.initialize();
      listener.stopRecording();
      mockAddEvent.mockClear();

      // After stop, isRecording=false; emit returns early.
      mockEmitCallback!("event-after-stop");
      vi.advanceTimersByTime(100);
      expect(mockAddEvent).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Deferred batch (async timer) path — no worker available
  // ────────────────────────────────────────────────────────────────────────
  describe("deferred batch — inline (no worker)", () => {
    it("does not call addEvent synchronously on emit", () => {
      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");

      expect(mockAddEvent).not.toHaveBeenCalled();
    });

    it("drains the batch on the next tick", () => {
      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");

      vi.advanceTimersByTime(0);

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      expect(mockAddEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "replay",
          attributes: expect.objectContaining({
            _gc_replay_data: expect.objectContaining({
              events: ["packed:event-1", "packed:event-2", "packed:event-3"],
            }),
          }),
        }),
      );
    });

    it("coalesces multiple over-threshold emits into one deferred send", () => {
      listener.initialize();
      mockAddEvent.mockClear();

      for (let i = 1; i <= 6; i++) mockEmitCallback!(`event-${i}`);
      expect(mockAddEvent).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      const call = mockAddEvent.mock.calls[0]![0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((call as any).attributes._gc_replay_data.events).toEqual([
        "packed:event-1", "packed:event-2", "packed:event-3",
        "packed:event-4", "packed:event-5", "packed:event-6",
      ]);
    });

    it("packs events inside the deferred batch, not at emit time", () => {
      listener.initialize();
      mockedPack.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");
      expect(mockedPack).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);
      expect(mockedPack).toHaveBeenCalledTimes(3);
    });

    it("preserves the full-snapshot flag across the deferred drain", () => {
      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("snapshot-event", true);
      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");

      vi.advanceTimersByTime(0);

      expect(mockAddEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            replay_is_full_snapshot: true,
          }),
        }),
      );
    });

    it("drops the deferred batch if the session id rotates during pack", async () => {
      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");

      // First call (capturedSessionId) returns the pre-rotation id; subsequent
      // calls (the post-pack guard) return the rotated id → drop.
      mockGetSessionId
        .mockReturnValueOnce("test-session-id")
        .mockReturnValue("rotated-id");

      vi.advanceTimersByTime(0);
      await vi.runAllTicks();

      expect(mockAddEvent).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Deferred batch via Web Worker — async path through WorkerClient
  // ────────────────────────────────────────────────────────────────────────
  describe("deferred batch — worker available", () => {
    it("routes the pack through worker.packReplay and enqueues the worker's bytes", async () => {
      mockWorker.isAvailable = true;
      mockWorker.packReplay.mockResolvedValue([
        "worker:event-1",
        "worker:event-2",
        "worker:event-3",
      ]);

      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");

      vi.advanceTimersByTime(0);
      // packReplay is async — flush the microtask queue before asserting.
      // Flush several microtask hops so the awaited worker promise resumes
      // and sendBatchAsync's tail runs.
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(mockWorker.packReplay).toHaveBeenCalledTimes(1);
      // Worker received the raw (unpacked) events, not the inline-packed ones.
      expect(mockWorker.packReplay).toHaveBeenCalledWith([
        "event-1", "event-2", "event-3",
      ]);
      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      const call = mockAddEvent.mock.calls[0]![0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((call as any).attributes._gc_replay_data.events).toEqual([
        "worker:event-1", "worker:event-2", "worker:event-3",
      ]);
    });

    it("falls back to inline pack when worker rejects", async () => {
      mockWorker.isAvailable = true;
      mockWorker.packReplay.mockRejectedValue(new Error("worker busy"));

      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");

      vi.advanceTimersByTime(0);
      // Flush several microtask hops so the awaited worker promise resumes
      // and sendBatchAsync's tail runs.
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(mockWorker.packReplay).toHaveBeenCalledTimes(1);
      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      // Inline-packed (pack mock prefixes "packed:").
      const call = mockAddEvent.mock.calls[0]![0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((call as any).attributes._gc_replay_data.events).toEqual([
        "packed:event-1", "packed:event-2", "packed:event-3",
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Sync drain — stopRecording / flushPendingSync
  // ────────────────────────────────────────────────────────────────────────
  describe("sync drain", () => {
    it("stopRecording flushes remaining buffered events synchronously", () => {
      listener.initialize();
      mockEmitCallback!("event-1");
      mockAddEvent.mockClear();

      listener.stopRecording();

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      expect(mockAddEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            _gc_replay_data: expect.objectContaining({
              events: ["packed:event-1"],
            }),
          }),
        }),
      );
    });

    it("stopRecording cancels a pending scheduled batch (no double drain)", () => {
      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");

      listener.stopRecording(); // sync drain — empties this.events

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      mockAddEvent.mockClear();

      // The previously scheduled setTimeout(0) must be cancelled.
      vi.advanceTimersByTime(100);
      expect(mockAddEvent).not.toHaveBeenCalled();
    });

    it("flushPendingSync drains buffered events and cancels the pending timer", () => {
      listener.initialize();
      mockAddEvent.mockClear();

      mockEmitCallback!("event-1");
      mockEmitCallback!("event-2");
      mockEmitCallback!("event-3");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (listener as any).flushPendingSync();

      expect(mockAddEvent).toHaveBeenCalledTimes(1);
      mockAddEvent.mockClear();

      vi.advanceTimersByTime(100);
      expect(mockAddEvent).not.toHaveBeenCalled();
    });

    it("stopRecording with no buffered events does not call addEvent", () => {
      listener.initialize();
      mockAddEvent.mockClear();

      listener.stopRecording();
      expect(mockAddEvent).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Full-snapshot checkouts
  // ────────────────────────────────────────────────────────────────────────
  describe("full-snapshot checkouts", () => {
    it("asks rrweb for a checkout every 5 minutes", () => {
      // Act
      listener.initialize();

      // Assert
      expect(mockedRecord.mock.calls[0]![0]).toMatchObject({
        checkoutEveryNms: 5 * 60_000,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // blockedSelectors config plumbing
  // ────────────────────────────────────────────────────────────────────────
  describe("blockedSelectors option", () => {
    it("does not pass blockSelector to rrweb by default", () => {
      listener.initialize();
      const options = mockedRecord.mock.calls[0]![0];
      expect(options).not.toHaveProperty("blockSelector");
    });

    it("joins blockedSelectors and passes them as rrweb's blockSelector", () => {
      mockGetConfig.mockReturnValue({
        options: {
          replay: { blockedSelectors: ["grammarly-extension", "[data-gramm]"] },
        },
      });
      listener.initialize();
      const options = mockedRecord.mock.calls[0]![0];
      expect(options).toMatchObject({
        blockSelector: "grammarly-extension, [data-gramm]",
      });
    });

    it("does not pass blockSelector when blockedSelectors is empty or only falsy", () => {
      mockGetConfig.mockReturnValue({
        options: { replay: { blockedSelectors: ["", ""] } },
      });
      listener.initialize();
      const options = mockedRecord.mock.calls[0]![0];
      expect(options).not.toHaveProperty("blockSelector");
    });

    it("filters out falsy entries before joining", () => {
      mockGetConfig.mockReturnValue({
        options: {
          replay: { blockedSelectors: ["grammarly-extension", "", "[data-gramm]"] },
        },
      });
      listener.initialize();
      const options = mockedRecord.mock.calls[0]![0];
      expect(options).toMatchObject({
        blockSelector: "grammarly-extension, [data-gramm]",
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Opt-in canvas capture (recordCanvas / sampling.canvas / dataURLOptions)
  // ────────────────────────────────────────────────────────────────────────
  describe("canvas recording", () => {
    const bootWithCanvas = (canvas: unknown) => {
      mockGetConfig.mockReturnValue({ options: { replay: { canvas } } });
      listener.initialize();
      return mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
    };

    it("does not enable canvas recording by default (no canvas config)", () => {
      listener.initialize();
      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      expect(options).not.toHaveProperty("recordCanvas");
      expect(options).not.toHaveProperty("dataURLOptions");
      expect(options.sampling).not.toHaveProperty("canvas");
      // Existing sampling knobs stay intact.
      expect(options.sampling).toMatchObject({
        mousemove: 100,
        input: "last",
        scroll: 150,
      });
    });

    it("does not enable canvas recording when enabled is false", () => {
      const options = bootWithCanvas({ enabled: false, fps: 10 });
      expect(options).not.toHaveProperty("recordCanvas");
      expect(options).not.toHaveProperty("dataURLOptions");
      expect(options.sampling).not.toHaveProperty("canvas");
    });

    it("enables canvas with conservative defaults when only enabled is set", () => {
      const options = bootWithCanvas({ enabled: true });
      expect(options.recordCanvas).toBe(true);
      expect(options.dataURLOptions).toEqual({
        type: "image/webp",
        quality: 0.6,
      });
      expect((options.sampling as Record<string, unknown>).canvas).toBe(1);
    });

    it("passes explicit fps / imageType / imageQuality through to rrweb", () => {
      const options = bootWithCanvas({
        enabled: true,
        fps: 10,
        imageType: "image/jpeg",
        imageQuality: 0.5,
      });
      expect(options.recordCanvas).toBe(true);
      expect((options.sampling as Record<string, unknown>).canvas).toBe(10);
      expect(options.dataURLOptions).toEqual({
        type: "image/jpeg",
        quality: 0.5,
      });
    });

    it("clamps an out-of-range fps to the max and warns", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const options = bootWithCanvas({ enabled: true, fps: 60 });
      expect((options.sampling as Record<string, unknown>).canvas).toBe(15);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("clamps an fps below the minimum up to the min and warns", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const options = bootWithCanvas({ enabled: true, fps: 0 });
      expect((options.sampling as Record<string, unknown>).canvas).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("falls back to the default fps and warns on a non-finite fps", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const options = bootWithCanvas({ enabled: true, fps: Number.NaN });
      expect((options.sampling as Record<string, unknown>).canvas).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("applies canvas options alongside blockSelector and privacy masking", () => {
      mockGetConfig.mockReturnValue({
        options: {
          replay: {
            blockedSelectors: ["[data-gramm]"],
            canvas: { enabled: true, fps: 6 },
          },
        },
      });
      listener.initialize();
      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      // Canvas capture is additive — it never displaces block/mask options.
      expect(options.recordCanvas).toBe(true);
      expect((options.sampling as Record<string, unknown>).canvas).toBe(6);
      expect(options.blockSelector).toBe("[data-gramm]");
      expect(options.maskAllInputs).toBe(true);
      expect(typeof options.maskInputFn).toBe("function");
    });
  });

  describe("privacy masking", () => {
    it("masks only sensitive inputs but not all text by default (mask-sensitive)", () => {
      listener.initialize();

      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      // maskAllInputs stays ON so rrweb invokes our maskInputFn for every input…
      expect(options.maskAllInputs).toBe(true);
      // …and data-private subtrees are masked in the replay text stream too.
      expect(options.maskTextSelector).toBe("[data-private]");

      // …and the gate captures non-secret inputs verbatim while masking secrets.
      const maskInputFn = options.maskInputFn as (
        t: string,
        el: HTMLElement
      ) => string;
      expect(typeof maskInputFn).toBe("function");

      const search = document.createElement("input");
      search.type = "text";
      search.id = "search";
      expect(maskInputFn("widget name", search)).toBe("widget name");

      const password = document.createElement("input");
      password.type = "password";
      expect(maskInputFn("hunter2", password)).toBe("*".repeat("hunter2".length));
    });

    // rrweb masking resolves from the raw provided options
    // (privacy/replay-masking.ts), not from EffectivePrivacy — these scenarios
    // drive the real resolution through getConfig().providedOptions.
    it("masks all text when level is mask-all", () => {
      mockGetConfig.mockReturnValue({
        providedOptions: { privacy: { level: "mask-all" } },
      });
      mockGetPrivacy.mockReturnValue({
        ...defaultPrivacy,
        level: "mask-all",
      });

      listener.initialize();

      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.maskAllInputs).toBe(true);
      expect(options.maskTextSelector).toBe("*");
    });

    it("disables masking when level is allow", () => {
      mockGetConfig.mockReturnValue({
        providedOptions: { privacy: { level: "allow" } },
      });
      mockGetPrivacy.mockReturnValue({
        ...defaultPrivacy,
        level: "allow",
      });

      listener.initialize();

      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.maskAllInputs).toBe(false);
      expect(options).not.toHaveProperty("maskTextSelector");
      // No selective gate under `allow` — nothing is masked.
      expect(options).not.toHaveProperty("maskInputFn");
    });

    it("passes maskSelectors through as maskTextSelector", () => {
      mockGetConfig.mockReturnValue({
        providedOptions: { privacy: { maskSelectors: [".secret"] } },
      });

      listener.initialize();

      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      // mask-sensitive default prepends the data-private guard.
      expect(options.maskTextSelector).toBe("[data-private], .secret");
    });

    it("forwards custom maskTextFn / maskInputFn to rrweb record()", () => {
      const maskTextFn = (t: string) => `t:${t}`;
      const maskInputFn = (t: string) => `i:${t}`;
      mockGetConfig.mockReturnValue({
        providedOptions: { privacy: { replay: { maskTextFn, maskInputFn } } },
      });

      listener.initialize();

      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.maskTextFn).toBe(maskTextFn);
      expect(options.maskInputFn).toBe(maskInputFn);
    });

    it("omits maskTextFn when not configured, but installs the default maskInputFn gate", () => {
      listener.initialize();

      const options = mockedRecord.mock.calls[0]![0] as Record<string, unknown>;
      expect(options).not.toHaveProperty("maskTextFn");
      // The selective input gate is always present unless level is `allow`.
      expect(typeof options.maskInputFn).toBe("function");
    });
  });
});
