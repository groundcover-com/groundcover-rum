import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";
import * as core from "@groundcover/rum-core";
import groundcover, { __resetForTest, __whenReady } from "./index";
import { RNSessionManager } from "./session-manager/session-manager";
import { HydratedStorage } from "./platform/hydrated-storage";
import { __reset as resetRN, __setNativeModule } from "./test-utils/react-native-stub";
import { RNInstrumentationManager } from "./events/instrumentation-manager";
import { NATIVE_MODULE_NAME } from "./platform/native-types";
import { getTouchHistory, recordTouchStart, reportPresence } from "./internal/touch-bridge";
import { EMPTY_WALK } from "./react/fiber-walk";

const CONFIG = {
  dsn: "ingest.example",
  apiKey: "k",
  cluster: "c",
  environment: "e",
  appId: "a",
};

describe("public API — pre-ready buffering & init lifecycle", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetRN();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    __resetForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("warns and no-ops when called before init()", () => {
    const spy = vi.spyOn(RNSessionManager.prototype, "sendCustomEvent");
    groundcover.sendCustomEvent({ event: "x", attributes: {} });
    expect(spy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("does not throw into the host when console.warn itself throws before init()", () => {
    // warnNotInitialized runs on the hottest pre-init path — every public call before
    // init(). A host that patched console.warn to throw (another monitor, a strict shim)
    // must not have the SDK's own advisory turn into a crash in its call.
    warn.mockImplementation(() => {
      throw new Error("patched console.warn");
    });

    expect(() => groundcover.sendCustomEvent({ event: "x", attributes: {} })).not.toThrow();
  });

  it("getSessionId returns '' with a warning before ready", () => {
    expect(groundcover.getSessionId()).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("buffers calls made after init() but before hydration completes, then drains in order", async () => {
    const spy = vi.spyOn(RNSessionManager.prototype, "sendCustomEvent");

    groundcover.init(CONFIG);
    // Synchronously after init(): manager not built yet (hydrate is async).
    groundcover.sendCustomEvent({ event: "first", attributes: {} });
    groundcover.sendCustomEvent({ event: "second", attributes: {} });
    expect(spy).not.toHaveBeenCalled();

    await __whenReady();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toEqual({ event: "first", attributes: {} });
    expect(spy.mock.calls[1]?.[0]).toEqual({ event: "second", attributes: {} });
  });

  it("delegates directly once ready", async () => {
    const spy = vi.spyOn(RNSessionManager.prototype, "identifyUser");
    groundcover.init(CONFIG);
    await __whenReady();

    groundcover.identifyUser({ id: "u1" });
    expect(spy).toHaveBeenCalledWith({ id: "u1" });
  });

  it.each(["a", "other-app"])("ignores init for %s during hydration and after readiness", async (appId) => {
    let finishHydration!: (keys: string[]) => void;
    const storage = {
      getAllKeys: vi.fn(() => new Promise<string[]>((resolve) => { finishHydration = resolve; })),
      multiGet: vi.fn().mockResolvedValue([]),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    };
    const hydrate = vi.spyOn(HydratedStorage, "hydrate");
    const initialize = vi.spyOn(core.ConfigManager.prototype, "initialize");
    const destroy = vi.spyOn(RNSessionManager.prototype, "destroy");
    const readInput = vi.fn((): never => { throw new Error("duplicate input read"); });
    const duplicate = new Proxy({ ...CONFIG, appId }, { get: readInput });
    const params = { ...CONFIG, sessionId: "first-session", storage };

    groundcover.init(params);
    const ready = __whenReady();
    params.appId = "mutated-after-init";
    groundcover.init({ ...CONFIG, appId, sessionId: "replacement-session" });
    expect(() => groundcover.init(duplicate)).not.toThrow();
    expect(() => groundcover.init(undefined as never)).not.toThrow();
    expect(__whenReady()).toBe(ready);
    expect(warn).not.toHaveBeenCalled();

    finishHydration([]);
    await ready;
    warn.mockClear();
    groundcover.init({ ...CONFIG, appId, sessionId: "replacement-session" });
    groundcover.init(duplicate);
    groundcover.init(undefined as never);

    expect(readInput).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ appId: CONFIG.appId }));
    expect(groundcover.getSessionId()).toBe("first-session");
  });

  it("requires initialization arguments and a nonblank appId before hydration", async () => {
    const hydrate = vi.spyOn(HydratedStorage, "hydrate");
    // @ts-expect-error init requires a configuration with appId.
    groundcover.init();
    // @ts-expect-error appId is required.
    groundcover.init({ dsn: "ingest.example", apiKey: "k", cluster: "c", environment: "e" });
    for (const appId of ["", " ", "\t\n", null, 42]) {
      groundcover.init({ ...CONFIG, appId } as typeof CONFIG);
    }
    expect(hydrate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(7);

    const initialize = vi.spyOn(core.ConfigManager.prototype, "initialize");
    groundcover.init({ ...CONFIG, appId: "  valid-app  " });
    await __whenReady();
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ appId: "  valid-app  " }));
  });

  it.each(["returns", "throws"])("preserves initialization started by an appId getter that %s", async (outcome) => {
    const hydrate = vi.spyOn(HydratedStorage, "hydrate");
    const getAppId = vi.fn(() => {
      groundcover.init({ ...CONFIG, appId: "nested-app", sessionId: "nested-session" });
      if (outcome === "throws") throw new Error("appId getter failed");
      return "outer-app";
    });
    expect(() => groundcover.init({ ...CONFIG, get appId() { return getAppId(); } })).not.toThrow();
    await __whenReady();

    expect(getAppId).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(groundcover.getSessionId()).toBe("nested-session");
    groundcover.init({ ...CONFIG, sessionId: "later-session" });
    expect(groundcover.getSessionId()).toBe("nested-session");
  });

  it("allows retry after a throwing options getter without accepting reentrant init", async () => {
    const hydrate = vi.spyOn(HydratedStorage, "hydrate");
    groundcover.init({
      ...CONFIG,
      get options(): never {
        groundcover.init({ ...CONFIG, sessionId: "nested-session" });
        throw new Error("options getter failed");
      },
    });
    await __whenReady();
    expect(hydrate).not.toHaveBeenCalled();

    groundcover.init({ ...CONFIG, appId: "retry-app", sessionId: "retry-session" });
    await __whenReady();
    expect(groundcover.getSessionId()).toBe("retry-session");
  });

  it("ignores reentrant init during instrumentation", async () => {
    const instrument = RNInstrumentationManager.prototype.instrument;
    const instrumentSpy = vi.spyOn(RNInstrumentationManager.prototype, "instrument")
      .mockImplementationOnce(function (this: RNInstrumentationManager) {
        instrument.call(this);
        groundcover.init({ ...CONFIG, appId: "nested-app", sessionId: "nested-session" });
      });
    groundcover.init({ ...CONFIG, sessionId: "first-session" });
    await __whenReady();

    expect(instrumentSpy).toHaveBeenCalledTimes(1);
    expect(groundcover.getSessionId()).toBe("first-session");
  });

  it("keeps sampled-out initialization claimed and warns on appId updates without collecting events", async () => {
    const instrument = vi.spyOn(RNInstrumentationManager.prototype, "instrument");
    const hydrate = vi.spyOn(HydratedStorage, "hydrate");
    groundcover.init({ ...CONFIG, options: { sessionSampleRate: 0 } });
    await __whenReady();
    warn.mockClear();

    groundcover.init({ ...CONFIG, options: { sessionSampleRate: 1 } });
    groundcover.init({ ...CONFIG, appId: "other-app" });
    expect(warn).not.toHaveBeenCalled();
    // @ts-expect-error appId is not updatable.
    groundcover.updateConfig({ appId: CONFIG.appId });
    // @ts-expect-error appId is not updatable, even when undefined.
    groundcover.updateConfig({ appId: undefined });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("updateConfig does not accept appId"));
    groundcover.sendCustomEvent({ event: "sampled-out", attributes: {} });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(instrument).not.toHaveBeenCalled();
    expect(groundcover.getSessionId()).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects appId updates buffered during initialization", async () => {
    const updateConfig = vi.spyOn(core.ConfigManager.prototype, "updateConfig");
    const beforeSend = vi.fn(() => true);
    groundcover.init({ ...CONFIG, options: { beforeSend } });
    // @ts-expect-error appId is not updatable.
    groundcover.updateConfig({ appId: "other-app", environment: "changed" });
    await __whenReady();

    expect(updateConfig).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("updateConfig does not accept appId"));
    expect(beforeSend).not.toHaveBeenCalled();
    groundcover.updateConfig({ environment: "updated" });
    expect(updateConfig).toHaveBeenCalledWith({ environment: "updated" });
  });

  it("preserves buffered events, session identity, and native state across duplicate init", async () => {
    let receiveBatch!: (batch: core.Batch) => void;
    const sent = new Promise<core.Batch>((resolve) => { receiveBatch = resolve; });
    const fetchMock = vi.fn((_endpoint: string, request: { headers: Record<string, string>; body: Uint8Array }) => {
      const body = request.headers["Content-Encoding"] === "gzip" ? gunzipSync(request.body) : request.body;
      receiveBatch(JSON.parse(strFromU8(body)) as core.Batch);
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const native = {
      nativeInit: vi.fn().mockResolvedValue("{}"),
      updateSessionSnapshot: vi.fn(),
      getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
      clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };
    __setNativeModule(NATIVE_MODULE_NAME, native as never);
    groundcover.init({
      ...CONFIG,
      sessionId: "first-session",
      options: { transport: { batchSize: 2, compression: false } },
    });
    await __whenReady();
    reportPresence(Date.now());
    groundcover.sendCustomEvent({ event: "before-duplicate", attributes: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    const snapshots = native.updateSessionSnapshot.mock.calls.slice();

    groundcover.init({ ...CONFIG, appId: "other-app", sessionId: "other-session" });
    expect(native.nativeInit).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();
    expect(native.updateSessionSnapshot.mock.calls).toEqual(snapshots);
    groundcover.sendCustomEvent({ event: "after-duplicate", attributes: {} });
    const batch = await sent;

    expect(batch.sessionAttributes).toMatchObject({
      "service.name": CONFIG.appId,
      session_id: "first-session",
      cluster: CONFIG.cluster,
    });
    expect(batch.events.map((event) => event.attributes?.custom_event_name)).toEqual([
      "before-duplicate", "after-duplicate",
    ]);
  });

  it("drops the pending queue if init fails (no replay against a half-built graph)", async () => {
    const spy = vi.spyOn(RNSessionManager.prototype, "sendCustomEvent");
    vi.spyOn(HydratedStorage, "hydrate").mockRejectedValueOnce(new Error("hydrate boom"));

    groundcover.init(CONFIG);
    groundcover.sendCustomEvent({ event: "lost", attributes: {} });
    await __whenReady();

    expect(spy).not.toHaveBeenCalled();
    groundcover.init({ ...CONFIG, sessionId: "retry-session" });
    await __whenReady();
    expect(groundcover.getSessionId()).toBe("retry-session");
  });

  it("cleans up failed construction, stops native, and allows retry", async () => {
    const stop = vi.fn();
    const native = {
      nativeInit: vi.fn().mockResolvedValue("{}"),
      updateSessionSnapshot: vi.fn(),
      getPendingCrashReports: vi.fn().mockResolvedValue("[]"),
      clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
      stop,
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };
    __setNativeModule(NATIVE_MODULE_NAME, native as never);

    const instrument = RNInstrumentationManager.prototype.instrument;
    vi.spyOn(RNInstrumentationManager.prototype, "instrument")
      .mockImplementationOnce(function (this: RNInstrumentationManager) {
        instrument.call(this);
        throw new Error("startup failed after installing listeners");
      });
    const uninstrument = vi.spyOn(RNInstrumentationManager.prototype, "uninstrument");
    const destroyPool = vi.spyOn(core.EventsPool.prototype, "destroy");
    groundcover.init(CONFIG);
    await __whenReady();
    expect(uninstrument).toHaveBeenCalledTimes(1);
    expect(destroyPool).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(groundcover.getSessionId()).toBe("");

    groundcover.init({ ...CONFIG, appId: "retry-app", sessionId: "retry-session" });
    await __whenReady();
    expect(groundcover.getSessionId()).toBe("retry-session");
    expect(native.nativeInit).toHaveBeenCalledTimes(1);
  });

  /**
   * The failure path must release the identity and drain pending calls:
   * without this, a call buffered during init waits behind a settled promise that never drains, so
   * an async waiter hangs FOREVER rather than resolving.
   *
   * Both of those lines sit BELOW the catch's error report. Reporting through a bare `handleError`
   * therefore hands the host's logger a veto over them — and `handleError` reaching a configured
   * logger that throws is exactly the case the SDK is supposed to survive. A hung `setSessionId`
   * is not a lost log line: the caller's `await` never returns.
   */
  it("a throwing logger cannot leave a failed init's buffered callers hanging", async () => {
    vi.spyOn(core, "handleError").mockImplementation(() => {
      throw new Error("broken host logger");
    });
    vi.spyOn(HydratedStorage, "hydrate").mockRejectedValueOnce(new Error("hydrate boom"));

    groundcover.init(CONFIG);
    const buffered = groundcover.setSessionId("sess-hang"); // buffered — manager not built yet
    await __whenReady();

    // Raced rather than awaited: if the failure path skips the drain this never settles, and a
    // bare await would hang the whole suite instead of failing this one case.
    const settled = await Promise.race([
      buffered.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("HUNG"), 50)),
    ]);
    expect(settled).toBe("resolved");
  });

  it("setSessionId resolves and delegates to the manager once ready", async () => {
    const spy = vi
      .spyOn(RNSessionManager.prototype, "setSessionId")
      .mockResolvedValue(undefined);
    groundcover.init(CONFIG);
    await __whenReady();

    await groundcover.setSessionId("sess-1");
    expect(spy).toHaveBeenCalledWith("sess-1");
  });

  it("setSessionId buffered before ready resolves after the queue drains", async () => {
    const spy = vi
      .spyOn(RNSessionManager.prototype, "setSessionId")
      .mockResolvedValue(undefined);

    groundcover.init(CONFIG);
    const p = groundcover.setSessionId("sess-2"); // buffered — manager not built yet
    expect(spy).not.toHaveBeenCalled();

    await __whenReady();
    await p; // must resolve (not hang) once the queue drains
    expect(spy).toHaveBeenCalledWith("sess-2");
  });

  it("setSessionId buffered before a FAILED init resolves rather than hanging", async () => {
    vi.spyOn(HydratedStorage, "hydrate").mockRejectedValueOnce(new Error("hydrate boom"));
    groundcover.init(CONFIG);
    const p = groundcover.setSessionId("sess-3");
    await __whenReady();
    await expect(p).resolves.toBeUndefined();
  });

  it("captureException buffers before ready then delegates to the manager", async () => {
    const spy = vi.spyOn(RNSessionManager.prototype, "captureException");

    groundcover.init(CONFIG);
    groundcover.captureException(new Error("early")); // buffered — manager not built yet
    expect(spy).not.toHaveBeenCalled();

    await __whenReady();
    expect(spy).toHaveBeenCalledTimes(1);

    groundcover.captureException(new Error("live"), { k: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[1]).toEqual({ k: 1 });
  });

  it("calls made AFTER a failed init don't hang/silently-buffer (init is terminal on failure)", async () => {
    vi.spyOn(HydratedStorage, "hydrate").mockRejectedValueOnce(new Error("hydrate boom"));
    groundcover.init(CONFIG);
    await __whenReady(); // init has now FAILED and settled

    // Async call AFTER the failure must resolve, not hang forever behind a
    // settled initialization promise that will never drain.
    const settled = await Promise.race([
      groundcover.setSessionId("after-failure").then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("HUNG"), 100)),
    ]);
    expect(settled).toBe("resolved");

    // Sync call AFTER the failure must warn-noop, not silently enqueue into a
    // buffer nothing will drain.
    const spy = vi.spyOn(RNSessionManager.prototype, "captureException");
    warn.mockClear();
    groundcover.captureException(new Error("after-failure"));
    expect(spy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled(); // "not initialized" warning
  });

  it("buffers logger.* calls made before ready, then emits them once the manager is up", async () => {
    const spy = vi.spyOn(RNSessionManager.prototype, "emitLog");
    groundcover.init(CONFIG);
    groundcover.logger.info("early log", { a: 1 }); // before hydration completes
    expect(spy).not.toHaveBeenCalled();

    await __whenReady();
    expect(spy).toHaveBeenCalledWith("early log", "info", { a: 1 });
  });

  it("a throwing manager method never escapes a public API into the host", async () => {
    groundcover.init(CONFIG);
    await __whenReady();
    vi.spyOn(RNSessionManager.prototype, "sendCustomEvent").mockImplementation(() => {
      throw new Error("manager boom");
    });
    // The public call must contain the error (route to handleError), not throw.
    expect(() => groundcover.sendCustomEvent({ event: "x", attributes: {} })).not.toThrow();
  });

  it("preserves gesture correlation when duplicate init is ignored", async () => {
    groundcover.init(CONFIG);
    await __whenReady();

    recordTouchStart({
      startedAtMs: Date.now(),
      x: 200,
      y: 400,
      target: { ...EMPTY_WALK, label: "Active context", componentPath: "Screen > List" },
    });
    expect(getTouchHistory()).toHaveLength(1);

    groundcover.init({ ...CONFIG, environment: "e2" });
    await __whenReady();

    expect(getTouchHistory()).toHaveLength(1);
  });

  it("caps the pre-ready buffer at 100, dropping oldest", async () => {
    const spy = vi.spyOn(RNSessionManager.prototype, "sendCustomEvent");
    groundcover.init(CONFIG);
    for (let i = 0; i < 105; i++) {
      groundcover.sendCustomEvent({ event: `e${i}`, attributes: {} });
    }
    await __whenReady();

    expect(spy).toHaveBeenCalledTimes(100);
    // Oldest 5 dropped: the first delivered event is e5.
    expect(spy.mock.calls[0]?.[0]).toEqual({ event: "e5", attributes: {} });
    expect(warn).toHaveBeenCalled();
  });
});
