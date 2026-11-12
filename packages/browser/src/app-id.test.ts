import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";
import type { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import type { Batch } from "@groundcover/rum-core/events/types";

type BrowserSdk = (typeof import("./index"))["default"];

type FetchRequest = {
  headers: Record<string, string>;
  body: Uint8Array;
};

describe("browser appId contract", () => {
  let sdk: BrowserSdk;
  let fetchMock: ReturnType<typeof vi.fn>;
  let requestPromise: Promise<FetchRequest>;
  let resolveRequest: (request: FetchRequest) => void;
  let responsePromise: Promise<unknown>;
  let resolveResponse: (response: unknown) => void;

  beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    delete window.groundcover;
    requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    responsePromise = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    fetchMock = vi.fn((_endpoint: string, request: FetchRequest) => {
      resolveRequest(request);
      return responsePromise;
    });
    vi.stubGlobal("fetch", fetchMock);
    sdk = (await import("./index")).default;
  });

  afterEach(() => {
    resolveResponse({ ok: true });
    sdk.logger.manager?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    delete window.groundcover;
  });

  it("rejects init without an appId before creating a manager", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // @ts-expect-error appId is required at init
    sdk.init({ cluster: "missing-app-id-cluster" });
    expect(sdk.logger.manager).toBeUndefined();

    sdk.init(undefined as never);
    expect(sdk.logger.manager).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("init requires a nonblank appId"));
  });

  it.each(["", " ", "\t", "\n", " \t\n "])(
    "rejects blank appId %j before creating a manager",
    (appId) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      sdk.init({ appId, cluster: "empty-app-id-cluster" });
      expect(sdk.logger.manager).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("init requires a nonblank appId")
      );
    }
  );

  it.each([null, 42, false, {}])("warns when appId is not a string: %j", (appId) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    sdk.init({ appId: appId as never, options: { debug: true } });

    expect(sdk.logger.manager).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("init requires a nonblank appId")
    );
  });

  it("preserves a valid appId exactly as supplied", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const appId = "  app-id-with-padding  ";
    sdk.init({ appId, cluster: "valid-app-id-cluster" });

    expect(
      (sdk.logger.manager as unknown as { core: { config: ConfigManager } }).core.config
        .getConfig()?.appId
    ).toBe(appId);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["first-app", "second-app"])("ignores duplicate init for %s without reading inputs or reporting an error", async (appId) => {
    sdk.init({
      appId: "first-app",
      cluster: "same-app-cluster",
      sessionId: "same-app-session",
    });
    const firstManager = sdk.logger.manager;
    const { SessionManager } = await import("./session-manager/session-manager");
    const destroySpy = vi.spyOn(SessionManager.prototype, "destroy");
    const errors = await import("@groundcover/rum-core/common/error-handler");
    const handleErrorSpy = vi.spyOn(errors, "handleError");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readInput = vi.fn((): never => {
      throw new Error("duplicate init must not read inputs");
    });

    sdk.init({
      appId,
      cluster: "replacement-cluster",
      sessionId: "replacement-session",
    });
    expect(() => sdk.init(new Proxy({ appId }, { get: readInput }))).not.toThrow();
    expect(() => sdk.init(undefined as never)).not.toThrow();

    expect(readInput).not.toHaveBeenCalled();
    expect(handleErrorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
    expect(sdk.logger.manager).toBe(firstManager);
    expect(sdk.getSessionId()).toBe("same-app-session");
  });

  it("ignores reentrant init from the real synchronous page-load callback", () => {
    const readyStateDescriptor = Object.getOwnPropertyDescriptor(document, "readyState");
    Object.defineProperty(document, "readyState", {
      configurable: true,
      get: () => "complete",
    });

    try {
      const callbackEvents: string[] = [];
      const callbackState: Array<{
        appId: string;
        phase: "before" | "after";
        manager: BrowserSdk["logger"]["manager"];
        sessionId: string | null;
      }> = [];
      const firstAppId = "outer-app";
      const params: Parameters<BrowserSdk["init"]>[0] = {
        appId: firstAppId,
        sessionId: "outer-session",
        options: {
          enabledEvents: ["pageload"],
          beforeSend: (event) => {
            callbackEvents.push(event.type);
            params.appId = "mutated-app";
            for (const appId of [firstAppId, "inner-app"]) {
              callbackState.push({
                appId,
                phase: "before",
                manager: sdk.logger.manager,
                sessionId: sessionStorage.getItem("gcId"),
              });
              sdk.init({
                appId,
                sessionId: "inner-session",
                options: { enabledEvents: ["navigation"] },
              });
              callbackState.push({
                appId,
                phase: "after",
                manager: sdk.logger.manager,
                sessionId: sessionStorage.getItem("gcId"),
              });
            }
            return true;
          },
        },
      };
      sdk.init(params);

      expect(callbackEvents).toEqual(["pageload"]);
      expect(callbackState).toEqual([
        { appId: firstAppId, phase: "before", manager: undefined, sessionId: "outer-session" },
        { appId: firstAppId, phase: "after", manager: undefined, sessionId: "outer-session" },
        { appId: "inner-app", phase: "before", manager: undefined, sessionId: "outer-session" },
        { appId: "inner-app", phase: "after", manager: undefined, sessionId: "outer-session" },
      ]);
      expect(params.appId).toBe("mutated-app");
      expect(sdk.getSessionId()).toBe("outer-session");
      expect(sessionStorage.getItem("gcId")).toBe("outer-session");
      expect(
        (sdk.logger.manager as unknown as { core: { config: ConfigManager } }).core.config
          .getConfig()?.appId
      ).toBe(firstAppId);

      const firstManager = sdk.logger.manager;
      sdk.init({
        appId: firstAppId,
        sessionId: "later-outer-session",
        options: { enabledEvents: ["navigation"] },
      });
      expect(sdk.logger.manager).toBe(firstManager);
      expect(sdk.getSessionId()).toBe("outer-session");
      expect(sessionStorage.getItem("gcId")).toBe("outer-session");

      sdk.init({
        appId: "inner-app",
        sessionId: "later-inner-session",
        options: { enabledEvents: ["navigation"] },
      });
      expect(sdk.logger.manager).toBe(firstManager);
      expect(sdk.getSessionId()).toBe("outer-session");
      expect(sessionStorage.getItem("gcId")).toBe("outer-session");
    } finally {
      if (readyStateDescriptor) {
        Object.defineProperty(document, "readyState", readyStateDescriptor);
      } else {
        Reflect.deleteProperty(document, "readyState");
      }
    }
  });

  it("releases the init guard after early rejection and a thrown input getter", () => {
    sdk.init({ appId: "\t\n" });

    const nestedManagers: BrowserSdk["logger"]["manager"][] = [];
    const throwingParams = {
      appId: "failed-app",
      get options(): never {
        sdk.init({ appId: "nested-during-failure", sessionId: "blocked-session" });
        nestedManagers.push(sdk.logger.manager);
        throw new Error("options getter failed during init");
      },
    };
    expect(() => sdk.init(throwingParams)).not.toThrow();
    expect(nestedManagers).toEqual([undefined]);
    expect(sdk.logger.manager).toBeUndefined();

    sdk.init({ appId: "after-failed-init", sessionId: "after-failure" });
    expect(sdk.getSessionId()).toBe("after-failure");
    expect(
      (sdk.logger.manager as unknown as { core: { config: ConfigManager } }).core.config
        .getConfig()?.appId
    ).toBe("after-failed-init");
  });

  it.each(["returns", "throws"])("preserves an init completed by an appId getter that %s", (outcome) => {
    let nestedManager: BrowserSdk["logger"]["manager"];
    const getAppId = vi.fn(() => {
      sdk.init({ appId: "getter-app", sessionId: "getter-session" });
      nestedManager = sdk.logger.manager;
      if (outcome === "throws") {
        throw new Error("appId getter failed after nested init");
      }
      return "outer-app";
    });
    const params = {
      get appId() {
        return getAppId();
      },
      sessionId: "outer-session",
    };

    expect(() => sdk.init(params)).not.toThrow();
    expect(getAppId).toHaveBeenCalledTimes(1);
    expect(nestedManager).toBeDefined();
    expect(sdk.logger.manager).toBe(nestedManager);
    expect(sdk.getSessionId()).toBe("getter-session");

    sdk.init({ appId: "later-app", sessionId: "later-session" });
    expect(sdk.logger.manager).toBe(nestedManager);
    expect(sdk.getSessionId()).toBe("getter-session");
  });

  it("cleans up a failed construction and allows a successful retry", async () => {
    const { InstrumentationManager } = await import("./events/instrumentation-manager");
    const { EventsPool } = await import("@groundcover/rum-core/events/events-pool");
    const instrument = InstrumentationManager.prototype.instrument;
    const instrumentSpy = vi.spyOn(InstrumentationManager.prototype, "instrument")
      .mockImplementationOnce(function (this: InstanceType<typeof InstrumentationManager>) {
        instrument.call(this);
        throw new Error("startup failed after installing listeners");
      });
    const uninstrumentSpy = vi.spyOn(InstrumentationManager.prototype, "uninstrument");
    const destroyPoolSpy = vi.spyOn(EventsPool.prototype, "destroy");

    expect(() => sdk.init({ appId: "failed-app", sessionId: "retry-session" })).not.toThrow();
    expect(instrumentSpy).toHaveBeenCalledTimes(1);
    expect(uninstrumentSpy).toHaveBeenCalledTimes(1);
    expect(destroyPoolSpy).toHaveBeenCalledTimes(1);
    expect(sdk.logger.manager).toBeUndefined();
    expect(sessionStorage.getItem("gcId")).toBe("retry-session");

    sdk.init({ appId: "retry-app" });
    expect(instrumentSpy).toHaveBeenCalledTimes(2);
    expect(sdk.logger.manager).toBeDefined();
    expect(sdk.getSessionId()).toBe("retry-session");
    expect(
      (sdk.logger.manager as unknown as { core: { config: ConfigManager } }).core.config
        .getConfig()?.appId
    ).toBe("retry-app");

    const addEventSpy = vi.spyOn(EventsPool.prototype, "addEvent");
    sdk.sendCustomEvent({ event: "after-retry", attributes: {} });
    expect(addEventSpy).toHaveBeenCalledTimes(1);
    expect(addEventSpy.mock.calls[0]?.[0]?.attributes?.custom_event_name).toBe("after-retry");
  });

  it.each(["sampled-out-app", "other-app"])("keeps sampled-out initialization claimed against a later init for %s", async (appId) => {
    const { InstrumentationManager } = await import("./events/instrumentation-manager");
    const instrumentSpy = vi.spyOn(InstrumentationManager.prototype, "instrument");
    sdk.init({
      appId: "sampled-out-app",
      sessionId: "sampled-out-session",
      options: { sessionSampleRate: 0 },
    });
    const firstManager = sdk.logger.manager;
    expect(firstManager).toBeDefined();
    expect(instrumentSpy).not.toHaveBeenCalled();
    expect(sdk.getSessionId()).toBe("");

    sdk.init({ appId, sessionId: "sampled-in-session", options: { sessionSampleRate: 1 } });
    sdk.sendCustomEvent({ event: "still-sampled-out", attributes: {} });

    expect(sdk.logger.manager).toBe(firstManager);
    expect(instrumentSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("gcId")).toBe("sampled-out-session");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["SDK", "manager"] as const)("warns on appId-bearing %s updates for a sampled-out session", async (route) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { InstrumentationManager } = await import("./events/instrumentation-manager");
    const instrumentSpy = vi.spyOn(InstrumentationManager.prototype, "instrument");
    sdk.init({
      appId: "sampled-out-app",
      sessionId: "sampled-out-session",
      options: { debug: false, sessionSampleRate: 0 },
    });
    const liveManager = sdk.logger.manager;
    if (!liveManager) {
      throw new Error("expected a live SessionManager");
    }
    const updateConfig = route === "SDK"
      ? sdk.updateConfig
      : liveManager.updateConfig.bind(liveManager);

    for (const appId of ["sampled-out-app", "other-app", undefined]) {
      warnSpy.mockClear();
      updateConfig({ appId, options: { sessionSampleRate: 1 } } as never);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("updateConfig does not accept appId; the entire update was ignored")
      );
    }

    warnSpy.mockClear();
    updateConfig({ options: { sessionSampleRate: 1 } });
    sdk.sendCustomEvent({ event: "still-sampled-out", attributes: {} });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(sdk.logger.manager).toBe(liveManager);
    expect(sdk.getSessionId()).toBe("");
    expect(sessionStorage.getItem("gcId")).toBe("sampled-out-session");
    expect(instrumentSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects appId-bearing and malformed updates through both public and manager routes", () => {
    sdk.init({
      appId: "first-app",
      cluster: "initial-cluster",
      environment: "initial-environment",
      namespace: "initial-namespace",
      releaseId: "initial-release",
      options: { debug: false, transport: { batchSize: 10 } },
    });

    const liveManager = sdk.logger.manager;
    if (!liveManager) {
      throw new Error("expected a live SessionManager");
    }
    const config = (liveManager as unknown as { core: { config: ConfigManager } }).core.config;
    const initialConfig = config.getConfig();
    if (!initialConfig) {
      throw new Error("expected initialized config");
    }
    const serializedConfig = JSON.stringify(initialConfig);

    const inheritedAppIdUpdate = Object.create({ appId: "inherited-app" }) as Record<
      string,
      unknown
    >;
    inheritedAppIdUpdate.cluster = "inherited-cluster";
    inheritedAppIdUpdate.options = { debug: true };

    const throwingHasUpdate = new Proxy(
      { options: { debug: true }, cluster: "proxy-cluster" },
      {
        has() {
          throw new Error("appId presence check failed");
        },
      }
    );
    const throwingGetterUpdate: Record<string, unknown> = {};
    Object.defineProperty(throwingGetterUpdate, "options", {
      get() {
        throw new Error("options getter failed");
      },
    });

    const rejectedUpdates: unknown[] = [
      { appId: "first-app", cluster: "changed-cluster", options: { debug: true } },
      { appId: "second-app", cluster: "changed-cluster", options: { debug: true } },
      { appId: undefined, environment: "changed-environment", options: { debug: true } },
      inheritedAppIdUpdate,
      throwingHasUpdate,
      throwingGetterUpdate,
      null,
      undefined,
      "not-an-object",
    ];

    for (const update of rejectedUpdates) {
      expect(() => sdk.updateConfig(update as never)).not.toThrow();
      expect(JSON.stringify(config.getConfig())).toBe(serializedConfig);

      expect(() => liveManager.updateConfig(update as never)).not.toThrow();
      expect(JSON.stringify(config.getConfig())).toBe(serializedConfig);
    }
  });

  it.each(["SDK", "manager"] as const)("warns when %s updates are rejected without applying fields or capturing SDK warnings", (route) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const beforeSend = vi.fn(() => true);
    sdk.init({
      appId: "first-app",
      dsn: "old.example",
      apiKey: "old-key",
      cluster: "old-cluster",
      options: { debug: false, enabledEvents: ["logs"], beforeSend },
    });
    const liveManager = sdk.logger.manager;
    if (!liveManager) {
      throw new Error("expected a live SessionManager");
    }
    const config = (liveManager as unknown as { core: { config: ConfigManager } }).core.config;
    const initialConfig = JSON.stringify(config.getConfig());
    const updateConfig = route === "SDK"
      ? sdk.updateConfig
      : liveManager.updateConfig.bind(liveManager);

    for (const appId of ["first-app", "other-app", undefined]) {
      warnSpy.mockClear();
      updateConfig({ appId, dsn: "new.example", apiKey: "new-key", cluster: "new-cluster" } as never);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("updateConfig does not accept appId; the entire update was ignored")
      );
      expect(JSON.stringify(config.getConfig())).toBe(initialConfig);
      expect(beforeSend).not.toHaveBeenCalled();
    }

    for (const params of [null, undefined, "not-an-object"]) {
      warnSpy.mockClear();
      updateConfig(params as never);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("updateConfig requires a configuration object")
      );
      expect(JSON.stringify(config.getConfig())).toBe(initialConfig);
      expect(beforeSend).not.toHaveBeenCalled();
    }

    console.warn("application warning");
    expect(warnSpy).toHaveBeenCalledWith("application warning");
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(beforeSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "log",
      attributes: expect.objectContaining({ message: "application warning" }),
    }));
  });

  it("contains throwing warnings without blocking init retry or applying rejected updates", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("patched console.warn");
    });

    expect(() => sdk.init({ appId: " " })).not.toThrow();
    expect(sdk.logger.manager).toBeUndefined();
    sdk.init({
      appId: "first-app",
      cluster: "original-cluster",
      options: { enabledEvents: ["navigation"] },
    });
    const liveManager = sdk.logger.manager;
    if (!liveManager) {
      throw new Error("expected a live SessionManager");
    }
    const config = (liveManager as unknown as { core: { config: ConfigManager } }).core.config;
    const initialConfig = JSON.stringify(config.getConfig());

    expect(() => sdk.updateConfig({ appId: "other-app", cluster: "changed-cluster" } as never)).not.toThrow();
    expect(() => liveManager.updateConfig({ appId: "other-app", cluster: "changed-cluster" } as never)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(config.getConfig())).toBe(initialConfig);
  });

  it("allows normal options, user, and cluster updates through both routes", () => {
    sdk.init({
      appId: "first-app",
      cluster: "initial-cluster",
      options: { debug: false, transport: { batchSize: 10 } },
    });

    sdk.updateConfig({
      cluster: "public-cluster",
      user: { id: "public-user" },
      options: { debug: true },
    });

    const liveManager = sdk.logger.manager;
    if (!liveManager) {
      throw new Error("expected a live SessionManager");
    }
    const config = (liveManager as unknown as { core: { config: ConfigManager } }).core.config;
    expect(config.getConfig()?.cluster).toBe("public-cluster");
    expect(config.getConfig()?.user).toMatchObject({ id: "public-user" });
    expect(config.getConfig()?.options.debug).toBe(true);

    liveManager.updateConfig({
      cluster: "manager-cluster",
      user: { email: "manager@example.com" },
      options: { transport: { batchSize: 25 } },
    });

    expect(config.getConfig()?.cluster).toBe("manager-cluster");
    expect(config.getConfig()?.user).toMatchObject({
      id: "public-user",
      email: "manager@example.com",
    });
    expect(config.getConfig()?.options.transport?.batchSize).toBe(25);
  });

  it.each(["first-app", "second-app"])("ignores duplicate init for %s and preserves buffered events through the next request", async (appId) => {
    sdk.init({
      dsn: "ingest.example",
      apiKey: "key",
      appId: "first-app",
      cluster: "original-cluster",
      options: { transport: { batchSize: 10, compression: false } },
    });
    window.dispatchEvent(new Event("pointerdown"));
    const oldSessionId = sdk.getSessionId();
    const firstManager = sdk.logger.manager;
    sdk.sendCustomEvent({ event: "buffered-before-duplicate-init", attributes: {} });
    expect(fetchMock).not.toHaveBeenCalled();

    sdk.init({
      dsn: "ingest.example",
      apiKey: "key",
      appId,
      cluster: "replacement-cluster",
      options: { transport: { batchSize: 10, compression: false } },
    });
    expect(sdk.logger.manager).toBe(firstManager);
    expect(sdk.getSessionId()).toBe(oldSessionId);
    expect(fetchMock).not.toHaveBeenCalled();

    for (let i = 0; i < 9; i += 1) {
      sdk.sendCustomEvent({ event: `threshold-event-${i}`, attributes: {} });
    }

    const request = await requestPromise;
    const body = request.headers["Content-Encoding"] === "gzip"
      ? gunzipSync(request.body)
      : request.body;
    const batch = JSON.parse(strFromU8(body)) as Batch;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batch.sessionAttributes.session_id).toBe(oldSessionId);
    expect(batch.sessionAttributes.cluster).toBe("original-cluster");
    expect(batch.sessionAttributes["service.name"]).toBe("first-app");
    expect(
      batch.events.some(
        (event) => event.attributes?.custom_event_name === "buffered-before-duplicate-init"
      )
    ).toBe(true);
  });
});
