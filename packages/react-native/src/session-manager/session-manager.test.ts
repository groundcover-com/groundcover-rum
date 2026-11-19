import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";
import { ConfigManager, SafeStorage, type Batch, type BaseEvent, type PlatformStorage } from "@groundcover/rum-core";

import { RNSessionManager } from "./session-manager";
import type { SDKConfigInput } from "../config/types";
import {
  __emitNativeSignal,
  __nativeListenerCount,
  __reset as resetRN,
  __setNativeModule,
  Platform,
} from "../test-utils/react-native-stub";
import {
  NATIVE_EVENT_CHANNEL,
  NATIVE_MODULE_NAME,
  type GroundcoverNativeModule,
} from "../platform/native-types";
import type { RawGesture } from "../internal/touch-bridge";
import { EMPTY_WALK } from "../react/fiber-walk";

// Composition-level session tests for RNSessionManager — the RN wiring AROUND
// core's session state machine (which is exhaustively unit-tested in
// packages/core/ts/src/session/*). These assert only the wiring: config →
// getMaxDurationMs, activity → reconcile/rotation, persistence across launches,
// and native session snapshots. All timing is driven by a
// fake clock (never real waits).

const BASE: SDKConfigInput = {
  dsn: "ingest.example",
  apiKey: "k",
  cluster: "c",
  environment: "e",
  appId: "a",
  options: { debug: false, transport: { batchSize: 0, compression: false } },
};

const T0 = "2026-01-01T00:00:00Z";
const tap = (): RawGesture => ({
  kind: "tap",
  x: 10,
  y: 20,
  target: EMPTY_WALK,
  captureSource: "js",
  startedAtMs: 0,
  distanceDp: 0,
  durationMs: 0,
  velocityDpS: 0,
  pointerCount: 1,
  partial: false,
});

function storage(map = new Map<string, string>()): SafeStorage {
  const backing: PlatformStorage = {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return new SafeStorage(backing);
}

function events(fetchMock: ReturnType<typeof vi.fn>): BaseEvent[] {
  return fetchMock.mock.calls.flatMap((call) => {
    const [, init] = call as [string, { headers: Record<string, string>; body: Uint8Array }];
    const bytes = init.headers["Content-Encoding"] === "gzip" ? gunzipSync(init.body) : init.body;
    return (JSON.parse(strFromU8(bytes)) as Batch).events;
  });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("RNSessionManager — session composition", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: RNSessionManager | null = null;

  beforeEach(() => {
    resetRN();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    sdk?.destroy();
    sdk = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── Removed options (0.0.1-rc.0 → rc.1 migration) ──
  // RN rc.0 shipped event-level sampling; rc.1 removed it. The README's migration
  // table promises the option warns and is ignored, on init and on updateConfig.
  it("warns about the removed eventSampleRate on init and on updateConfig", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withRemoved = { ...BASE.options, eventSampleRate: 0.5 } as SDKConfigInput["options"];

    sdk = new RNSessionManager({ ...BASE, options: withRemoved }, storage());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("`options.eventSampleRate` was removed"));

    warn.mockClear();
    sdk.updateConfig({ options: { eventSampleRate: 0.1 } as SDKConfigInput["options"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("`options.eventSampleRate` was removed"));
  });

  it("does not warn about the browser's 1.x removed options, which RN never had", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = new RNSessionManager(
      { ...BASE, options: { ...BASE.options, enableMasking: true } as SDKConfigInput["options"] },
      storage()
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("enableMasking"));
  });

  // ── Max-duration cap rotation (RN wiring of getMaxDurationMs) ──
  it("rotates at the configured max-duration cap, on the next activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    try {
      // 60_000 is the minimum accepted sessionMaxDuration (not clamped to default).
      sdk = new RNSessionManager(
        { ...BASE, options: { ...BASE.options, sessionMaxDuration: 60_000 } },
        storage()
      );
      sdk.reportInteraction(tap());
      const first = sdk.getSessionId();
      expect(first).not.toBe("");

      vi.setSystemTime(new Date("2026-01-01T00:01:01Z")); // 61s > 60s cap
      sdk.reportInteraction(tap()); // next activity triggers the lazy rotation
      expect(sdk.getSessionId()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Foreground inactivity rotation (no AppState change) ──
  it("rotates after a 30+ min inactivity gap with no AppState change (foreground idle)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    try {
      sdk = new RNSessionManager(BASE, storage());
      sdk.reportInteraction(tap());
      const first = sdk.getSessionId();

      vi.setSystemTime(new Date("2026-01-01T00:31:00Z")); // 31 min idle, still foreground
      sdk.reportInteraction(tap());
      expect(sdk.getSessionId()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT rotate before the inactivity window (29 min boundary)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    try {
      sdk = new RNSessionManager(BASE, storage());
      sdk.reportInteraction(tap());
      const first = sdk.getSessionId();

      vi.setSystemTime(new Date("2026-01-01T00:29:00Z")); // under the 30-min gap
      sdk.reportInteraction(tap());
      expect(sdk.getSessionId()).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Cross-launch ROTATION (not just continuity) through real storage ──
  it("mints a NEW session id on relaunch after a 30+ min gap (bootstrap over persisted storage)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    try {
      const persisted = new Map<string, string>();
      const first = new RNSessionManager(BASE, storage(persisted));
      first.reportInteraction(tap()); // confirm + persist activity
      const firstId = first.getSessionId();
      const saved = new Map(persisted);
      first.destroy();

      vi.setSystemTime(new Date("2026-01-01T00:31:00Z")); // relaunch 31 min later
      sdk = new RNSessionManager(BASE, storage(saved));
      expect(sdk.getSessionId()).not.toBe(firstId);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Sampling verdict persisted across launches (no re-roll) ──
  it("reuses the persisted sampling verdict across launches, ignoring a new dice roll", async () => {
    const persisted = new Map<string, string>();
    vi.spyOn(Math, "random").mockReturnValue(0.1); // < 0.5 → sampled IN, verdict persisted
    const first = new RNSessionManager(
      { ...BASE, options: { ...BASE.options, sessionSampleRate: 0.5 } },
      storage(persisted)
    );
    first.reportInteraction(tap());
    first.sendCustomEvent({ event: "before", attributes: {} });
    await drain();
    expect(fetchMock).toHaveBeenCalled(); // sampled in
    const saved = new Map(persisted);
    first.destroy();

    // Next launch: the dice would now say OUT, but the STORED verdict must win.
    (Math.random as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0.9);
    fetchMock.mockClear();
    sdk = new RNSessionManager(
      { ...BASE, options: { ...BASE.options, sessionSampleRate: 0.5 } },
      storage(saved)
    );
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "after", attributes: {} });
    await drain();
    expect(fetchMock).toHaveBeenCalled(); // verdict reused → still sending
  });

  it("re-rolls with no persisted verdict (fresh store) — proving persistence is the deciding factor", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9); // > 0.5 → sampled OUT
    sdk = new RNSessionManager(
      { ...BASE, options: { ...BASE.options, sessionSampleRate: 0.5 } },
      storage()
    );
    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "z", attributes: {} });
    await drain();
    expect(fetchMock).not.toHaveBeenCalled(); // not sampled → nothing sent
  });

  // ── Ingest rejections (RN's live sender passes the fetch response through to core) ──
  it("warns once, with debug off, when the endpoint refuses the credentials", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    sdk = new RNSessionManager(BASE, storage());

    sdk.reportInteraction(tap());
    sdk.sendCustomEvent({ event: "first", attributes: {} });
    sdk.sendCustomEvent({ event: "second", attributes: {} });
    await drain();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const rejections = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes("HTTP 401"));
    expect(rejections).toEqual([
      expect.stringContaining("https://ingest.example/json/rum rejected a batch with HTTP 401"),
    ]);
  });

  // ── Native session snapshot ──
  //
  // Native holds a copy of the session envelope so a crash — which kills the JS
  // runtime before anything can be composed — is still attributable. These
  // assert the copy is pushed wherever the envelope changes.
  describe("native session snapshot", () => {
    function installNative(): GroundcoverNativeModule {
      const native: GroundcoverNativeModule = {
        nativeInit: vi
          .fn()
          .mockResolvedValue(
            '{"crashes":true,"hangs":true,"appStart":true,"vitals":true,"gestures":true}'
          ),
        updateSessionSnapshot: vi.fn(),
        getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
        clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
        flushFrameSegment: vi.fn().mockResolvedValue("null"),
        stop: vi.fn(),
        addListener: vi.fn(),
        removeListeners: vi.fn(),
      };
      __setNativeModule(NATIVE_MODULE_NAME, native);
      return native;
    }

    const pushedSnapshots = (native: GroundcoverNativeModule) =>
      (native.updateSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.map(([json]) =>
        json === null ? null : (JSON.parse(json as string) as Record<string, unknown>)
      );

    it("pushes the envelope at init", () => {
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());

      const pushed = pushedSnapshots(native);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({
        session_id: sdk.getSessionId(),
        source: "mobile-rum",
        screen: { name: "", key: "" },
      });
    });

    it("re-pushes after a session rotation, carrying the NEW session id", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(T0));
      try {
        const native = installNative();
        sdk = new RNSessionManager(
          { ...BASE, options: { ...BASE.options, sessionMaxDuration: 60_000 } },
          storage()
        );
        sdk.reportInteraction(tap());
        const first = sdk.getSessionId();

        vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
        sdk.reportInteraction(tap()); // triggers the lazy cap rotation
        const rotated = sdk.getSessionId();

        expect(rotated).not.toBe(first);
        // A crash after the rotation belongs to the NEW session.
        const last = pushedSnapshots(native).at(-1);
        expect(last).toMatchObject({ session_id: rotated });
      } finally {
        vi.useRealTimers();
      }
    });

    // The drain reads records the harvest inside `nativeInit` creates — on iOS, where KSCrash
    // persists in its own format and only the harvest transcribes. Reading first finds an empty
    // directory and the crash surfaces one launch late, attached to the wrong launch with nothing
    // erroring. Android would not catch it (its handler needs no harvest), so the guard has to
    // live in a unit test rather than the device suite.
    it("does not read pending crash reports until nativeInit has settled", async () => {
      let settleNativeInit!: (status: string) => void;
      const native = installNative();
      (native.nativeInit as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<string>((resolve) => {
          settleNativeInit = resolve;
        })
      );

      sdk = new RNSessionManager(BASE, storage());
      await drain();

      // The harvest has not run yet, so there is nothing on disk to find.
      expect(native.getPendingCrashReports).not.toHaveBeenCalled();

      settleNativeInit('{"crashes":true,"hangs":false,"appStart":false,"vitals":false,"gestures":false}');
      await drain();

      expect(native.getPendingCrashReports).toHaveBeenCalledTimes(1);
    });

    /**
     * The same principle as the sampling rule above, one gate up: CONFIG GATES CAPTURE, NOT
     * DELIVERY. A record can only be on disk because a launch that had `crashes` enabled wrote
     * it — the Android handler and the ExitInfo harvester both live inside the engine's crashes
     * block — so every pending record was captured under consent. Turning the feature off says
     * "stop capturing", and refusing to ship what is already captured turns a config change into
     * silent data loss: the fatal sits on disk until the record cap evicts it.
     *
     * The arming assertion is the other half. Unlike the unsampled case, `crashes: false` here is
     * correct and must stay: an explicit opt-out must not install a process-wide crash handler.
     *
     * PLATFORM ASYMMETRY, and it is not fixable from here: on iOS the harvest that transcribes
     * KSCrash's store into pending records also lives in that arming block, so a crash whose next
     * launch has crashes disabled stays in KSCrash's own store, un-transcribed and invisible to
     * this drain. Harvesting it would mean installing KSCrash for a host that opted out. What this
     * covers is every Android record, and any iOS record an earlier enabled launch harvested but
     * failed to deliver.
     */
    it("drains records an earlier launch captured even when crashes are now disabled", async () => {
      const native = installNative();
      sdk = new RNSessionManager(
        { ...BASE, options: { ...BASE.options, enabledEvents: ["exceptions", "network"] } },
        storage()
      );

      await drain();
      expect(native.getPendingCrashReports).toHaveBeenCalledTimes(1);

      const initConfig = JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      );
      expect(initConfig.features.crashes).toBe(false);
    });

    // A bridge that rejects still leaves whatever an earlier, working run wrote.
    // Dropping those would turn one bad startup into permanent data loss.
    it("still drains when nativeInit fails", async () => {
      const native = installNative();
      (native.nativeInit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no engine"));

      sdk = new RNSessionManager(BASE, storage());
      await drain();

      expect(native.getPendingCrashReports).toHaveBeenCalledTimes(1);
    });

    it("re-pushes on identifyUser so a crash reports the identified user", () => {
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());

      sdk.identifyUser({ id: "user-42" });

      expect(pushedSnapshots(native).at(-1)).toMatchObject({ user: { id: "user-42" } });
    });

    it("re-pushes on a screen change so a crash carries the screen", () => {
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());

      sdk.startNavigation({ screen: "Checkout" });

      expect(pushedSnapshots(native).at(-1)).toMatchObject({
        screen: { name: "Checkout" },
      });
    });

    // The screen-holder wrapper is the single synchronous chokepoint for every
    // screen change, auto AND manual, which is why the frame-segment pull hangs
    // off it rather than off the navigation tracker.
    it("pulls the open frame segment on every screen change", () => {
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());

      // The FIRST screen has no outgoing screen to attribute anything to, and
      // native has had no time to count a frame — pulling would be noise.
      sdk.startNavigation({ screen: "Feed" });
      expect(native.flushFrameSegment).not.toHaveBeenCalled();

      sdk.startNavigation({ screen: "Checkout" });
      expect(native.flushFrameSegment).toHaveBeenCalledTimes(1);

      sdk.startNavigation({ screen: "Confirm" });
      expect(native.flushFrameSegment).toHaveBeenCalledTimes(2);
    });

    it("survives a rejected frame-segment pull — a screen change must not fail", () => {
      const native = installNative();
      (native.flushFrameSegment as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("bridge gone")
      );
      sdk = new RNSessionManager(BASE, storage());

      sdk.startNavigation({ screen: "Feed" });

      expect(() => sdk!.startNavigation({ screen: "Checkout" })).not.toThrow();
    });

    it("re-pushes on setSessionId", async () => {
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());

      await sdk.setSessionId("explicit-session-id");

      expect(pushedSnapshots(native).at(-1)).toMatchObject({
        session_id: "explicit-session-id",
      });
    });

    it("rejects appId-bearing and malformed updates without changing configuration or the native snapshot", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());
      const updateConfig = vi.spyOn(ConfigManager.prototype, "updateConfig");
      const originalSnapshots = pushedSnapshots(native);
      const rejected: unknown[] = [
        { appId: BASE.appId, environment: "changed" },
        { appId: "other-app", user: { id: "changed" } },
        { appId: undefined, options: { debug: true } },
        Object.assign(Object.create({ appId: "inherited" }), { cluster: "changed" }),
        null,
        undefined,
        "not-an-object",
      ];

      for (const update of rejected) {
        expect(() => sdk!.updateConfig(update as Parameters<RNSessionManager["updateConfig"]>[0])).not.toThrow();
      }

      expect(warn).toHaveBeenCalledTimes(rejected.length);
      expect(updateConfig).not.toHaveBeenCalled();
      expect(pushedSnapshots(native)).toEqual(originalSnapshots);

      sdk.updateConfig({ environment: "updated", user: { id: "updated-user" } });
      expect(updateConfig).toHaveBeenCalledTimes(1);
      expect(pushedSnapshots(native).at(-1)).toMatchObject({
        "service.name": BASE.appId,
        env: "updated",
        user: { id: "updated-user" },
      });
    });

    it("contains a throwing appId presence check before touching configuration", () => {
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());
      const updateConfig = vi.spyOn(ConfigManager.prototype, "updateConfig");
      const originalSnapshots = pushedSnapshots(native);
      const updates = new Proxy({ environment: "changed" }, {
        has() { throw new Error("presence check failed"); },
      });

      expect(() => sdk!.updateConfig(updates)).not.toThrow();
      expect(updateConfig).not.toHaveBeenCalled();
      expect(pushedSnapshots(native)).toEqual(originalSnapshots);
    });

    it("warns on each appId update even when the session is sampled out", () => {
      installNative();
      sdk = new RNSessionManager({ ...BASE, options: { sessionSampleRate: 0 } }, storage());
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const updateConfig = vi.spyOn(ConfigManager.prototype, "updateConfig");

      for (const appId of [BASE.appId, "other-app", undefined]) {
        // @ts-expect-error appId is fixed even for sampled-out sessions.
        sdk.updateConfig({ appId, options: { sessionSampleRate: 1 } });
      }

      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("updateConfig does not accept appId"));
      expect(updateConfig).not.toHaveBeenCalled();
      expect(sdk.getSessionId()).toBe("");
    });

    it("clears the snapshot and stops the engines on destroy", () => {
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());

      sdk.destroy();

      // The session is over — a later crash belongs to no session, and
      // attributing it to this one would silently extend it past its end.
      expect(pushedSnapshots(native).at(-1)).toBeNull();
      expect(native.stop).toHaveBeenCalled();
      sdk = null;
    });

    it("arms only crash capture and clears the snapshot for an unsampled session", async () => {
      const native = installNative();
      sdk = new RNSessionManager(
        { ...BASE, options: { ...BASE.options, sessionSampleRate: 0 } },
        storage()
      );

      const initConfig = JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      );
      expect(initConfig.features).toEqual({
        // CRASHES ARM EVEN UNSAMPLED, and this is the one feature that has to. On iOS the
        // HARVEST — transcribing KSCrash's store into our pending records — happens inside the
        // engine's crashes block, so a `false` here means an unsampled launch never harvests and a
        // crash from a previous SAMPLED session is not delivered at all. At a 10% sample rate that
        // is nine launches out of ten, not an edge case, and KSCrash's 10-report cap can evict the
        // report before a sampled launch ever comes round. The device suite covers the harvest
        // itself (`zz-perturbing/unsampled-drain.spec.ts`); this assertion is what catches it here,
        // because a stubbed native module harvests nothing either way.
        crashes: true,
        // Everything else stays sampled-gated: they capture live signals, and an unsampled session
        // must not produce any.
        hangs: false,
        appStart: false,
        vitals: false,
        gestures: false,
      });

      // ...but the drain still runs. A fatal from an EARLIER, sampled session is
      // already on disk, and this session's sampling decision says nothing about
      // whether that one should ship. Dropping it here would silently lose the
      // crash for every user who rolled unsampled on their next launch.
      //
      // The drain chains off the armNative promise, so it needs a tick.
      await drain();
      expect(native.getPendingCrashReports).toHaveBeenCalledTimes(1);

      // And the snapshot is CLEARED — never pushed, and actively dropped. This is what makes
      // arming crashes above safe: with no envelope on disk, a crash in THIS session is
      // unattributable, so the drain's `parseSnapshot` returns null and it acks-and-drops.
      //
      // Clearing rather than merely not-pushing, because an unsampled launch inherits whatever
      // envelope the PREVIOUS run left. Left in place, a crash here would be paired with the
      // previous session — misattribution, which is a worse failure than a delayed delivery.
      //
      // AFTER the init settles, not before: on iOS the harvest runs inside `nativeInit` and reads
      // that same snapshot to attribute the previous run's crash. Clearing first would destroy the
      // envelope the harvest exists to pair.
      expect(native.updateSessionSnapshot).toHaveBeenCalledTimes(1);
      expect((native.updateSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeNull();
      sdk = null;
    });

    /**
     * The `updateSessionSnapshot(null)` asserted above is asynchronous — it lands a tick
     * after `nativeInit` resolves — and in that window the PREVIOUS run's envelope is still on disk
     * while this run is already capturing, so a fatal there is attributed to a session it did not
     * happen in.
     *
     * The instruction to clear therefore has to ride the init call itself, which is where the
     * harvest that reads the envelope runs. Asserted on the JSON actually crossing the bridge
     * rather than on a spy call count, because the whole point is WHICH native call does the work —
     * a test that only checked "the SDK asked for a clear" would pass without the flag too.
     */
    it("asks native to clear the envelope inside nativeInit itself, not only afterwards", () => {
      const native = installNative();
      sdk = new RNSessionManager(
        { ...BASE, options: { ...BASE.options, sessionSampleRate: 0 } },
        storage()
      );

      const initConfig = JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      );
      expect(initConfig.clearSnapshotAfterHarvest).toBe(true);
      // No envelope is handed in on this path, so the flag is unambiguous — native's tie-break
      // (an explicit `snapshotJson` wins) is never reached here.
      expect(initConfig.snapshotJson).toBeUndefined();
      sdk = null;
    });

    it("never asks a sampled session to clear its envelope", () => {
      // The control, and the half that would break loudly: a sampled launch that cleared would
      // leave every crash in a live session unattributable.
      const native = installNative();
      sdk = new RNSessionManager({ ...BASE }, storage());

      const initConfig = JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      );
      expect(initConfig.clearSnapshotAfterHarvest).toBe(false);
      sdk = null;
    });

    it("passes the resolved thresholds to native, falling back on a nonsense value", () => {
      const native = installNative();
      sdk = new RNSessionManager(
        {
          ...BASE,
          options: {
            ...BASE.options,
            native: { hangThresholdMs: Number.NaN, vitalsMaxSegmentMs: 20_000 },
          },
        },
        storage()
      );

      const initConfig = JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      );
      // NaN falls back to the platform default (iOS in the stub); the valid
      // segment cap is passed through.
      expect(initConfig.thresholds.hangThresholdMs).toBe(2_000);
      expect(initConfig.thresholds.vitalsMaxSegmentMs).toBe(20_000);
    });

    // Every other test in this file runs under the stub's default Platform.OS
    // of "ios", so without this the Android half of the documented "2s on iOS,
    // 5s on Android" contract (README, and the NativeOptions JSDoc) would have no
    // coverage at all.
    //
    // Without an Android case here, wiring that did not pass `Platform.OS` through
    // would pass every test in this file while Android shipped a 2s
    // watchdog, which on a cold-starting mid-range device reports routine startup
    // jank as a hang.
    it("defaults the hang threshold to the Android value when running on Android", () => {
      Platform.OS = "android";
      const native = installNative();
      sdk = new RNSessionManager(BASE, storage());

      const initConfig = JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      );
      expect(initConfig.thresholds.hangThresholdMs).toBe(5_000);
    });

    /** The threshold native was actually armed with. */
    const armedHangThresholdMs = (native: GroundcoverNativeModule): number =>
      JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      ).thresholds.hangThresholdMs;

    const withHangThreshold = (value: unknown): SDKConfigInput => ({
      ...BASE,
      options: { ...BASE.options, native: { hangThresholdMs: value as never } },
    });

    // A bare number applies to both platforms; the per-platform object form below
    // must not change that.
    it("applies a bare hangThresholdMs to whichever platform is running", () => {
      Platform.OS = "android";
      const native = installNative();
      sdk = new RNSessionManager(withHangThreshold(3_000), storage());

      expect(armedHangThresholdMs(native)).toBe(3_000);
    });

    it("arms each platform with its own value when hangThresholdMs is per-platform", () => {
      const native = installNative(); // stub defaults to ios
      sdk = new RNSessionManager(
        withHangThreshold({ ios: 1_500, android: 8_000 }),
        storage()
      );

      expect(armedHangThresholdMs(native)).toBe(1_500);
    });

    /**
     * What the per-platform form exists for. With a single shared number, tuning
     * iOS down to 2s would arm a 2s watchdog on ANDROID as well, below the
     * platform's own 5s ANR bar — so a host tuning the signal it can see would
     * silently flood itself on the one it cannot, with the documented 5s default
     * gone and nothing saying so.
     */
    it("leaves Android on its default when only iOS is tuned", () => {
      Platform.OS = "android";
      const native = installNative();
      sdk = new RNSessionManager(withHangThreshold({ ios: 1_500 }), storage());

      expect(armedHangThresholdMs(native)).toBe(5_000);
    });

    it("falls back to the platform default when a per-platform value is nonsense", () => {
      Platform.OS = "android";
      const native = installNative();
      sdk = new RNSessionManager(withHangThreshold({ android: 5 }), storage());

      expect(armedHangThresholdMs(native)).toBe(5_000);
    });

    /**
     * `crashes: false` cannot distinguish "the host never asked" from "we asked and could not
     * install" — which happens whenever another KSCrash user owns the iOS singleton or
     * another SDK owns the Android chain. Refusing is correct; doing it silently leaves an app
     * reporting no native crashes with nothing to say so. console.warn rather than
     * Logger.log, which only prints under `debug`.
     */
    it("warns when native reports crash capture is unavailable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const native = installNative();
      (native.nativeInit as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({
          crashes: false,
          hangs: true,
          appStart: true,
          vitals: true,
          gestures: true,
          crashesUnavailable: "KSCrash is already installed",
        })
      );

      sdk = new RNSessionManager(BASE, storage());
      await drain();

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain("KSCrash is already installed");
      // The SDK's own console output must never be re-captured by its log
      // listener, or a warning becomes an event becomes a warning.
      expect(message).toContain("groundcoverIgnore");
    });

    it("stays quiet when native reports crash capture is healthy", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      installNative(); // resolves with every feature armed and no reason

      sdk = new RNSessionManager(BASE, storage());
      await drain();

      expect(warn).not.toHaveBeenCalled();
    });

    /** A host that never asked for crashes has nothing to be warned about. */
    it("stays quiet when crashes were never requested", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const native = installNative();
      (native.nativeInit as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({ crashes: false, crashesUnavailable: "KSCrash is already installed" })
      );

      sdk = new RNSessionManager(
        { ...BASE, options: { ...BASE.options, enabledEvents: ["network"] } },
        storage()
      );
      await drain();

      expect(warn).not.toHaveBeenCalled();
    });

    it("gates each native feature on its own enabledEvents name", () => {
      const native = installNative();
      sdk = new RNSessionManager(
        { ...BASE, options: { ...BASE.options, enabledEvents: ["crashes", "interaction"] } },
        storage()
      );

      const initConfig = JSON.parse(
        (native.nativeInit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
      );
      expect(initConfig.features).toEqual({
        crashes: true,
        hangs: false,
        appStart: false,
        vitals: false,
        // Gestures ride the interaction gate — same signal as taps.
        gestures: true,
      });
    });

    it("works unchanged with no native module (Expo Go)", () => {
      sdk = new RNSessionManager(BASE, storage());

      expect(sdk.getSessionId()).not.toBe("");
    });

    it("leaves no emitter subscription behind after teardown", async () => {
      installNative();
      const store = storage();
      sdk = new RNSessionManager(BASE, store);
      await drain();
      expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);

      sdk.destroy();
      expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(0);
      sdk = new RNSessionManager(BASE, store);
      await drain();

      expect(__nativeListenerCount(NATIVE_EVENT_CHANNEL)).toBe(1);
    });

    it("emits one hang event per native signal", async () => {
      installNative();
      sdk = new RNSessionManager(BASE, storage());
      sdk.reportInteraction(tap()); // presence opens the send gate
      await drain();
      fetchMock.mockClear();

      __emitNativeSignal(NATIVE_EVENT_CHANNEL, {
        kind: "hang",
        payload: { kind: "anr", startedAtMs: Date.now(), durationMs: 5_210 },
      });
      await drain();

      const hangs = events(fetchMock).filter(
        (e) =>
          e.type === "exception" &&
          (e.attributes as Record<string, unknown>)["error_type"] === "ANR"
      );
      expect(hangs).toHaveLength(1);
    });
  });
});

/**
 * The SDK must never take the host down, and a warning is the last thing that should manage it.
 * `console` is patched by other monitoring libraries — and by this SDK's own log listener — so a
 * throwing sink is a real shape, not a hypothetical. Core contains its config warnings for exactly
 * this reason (`safeWarn`, used by sdk-config.ts); the cleartext-DSN warning runs BEFORE the
 * constructor's try/catch, so an unguarded throw there would abort init outright and leave the
 * public `init()` with no manager at all.
 */
describe("RNSessionManager — a hostile console cannot abort init", () => {
  it("initializes despite a console.warn that throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("host replaced console.warn");
    });

    // An http:// DSN in a non-dev bundle is what triggers the warning at all.
    const sdk = new RNSessionManager(
      { ...BASE, dsn: "http://ingest.example.com" },
      storage()
    );

    // Initialization completed: the session is live and taps still reach it.
    expect(() => sdk.reportInteraction(tap())).not.toThrow();
    sdk.destroy();
  });
});
