import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import type { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import type { BaseEvent } from "@groundcover/rum-core/events/types";

type BrowserSdk = (typeof import("./index"))["default"];

describe("SDK public API (index.ts)", () => {
  let sdk: BrowserSdk;
  let EventsPool: (typeof import("@groundcover/rum-core/events/events-pool"))["EventsPool"];

  // ConfigManager is not a singleton. Reach the live instance through the
  // SessionManager that init() wires into sdk.logger (its collaborators live on
  // the atomically-set `core` bundle).
  const getConfigManager = (): ConfigManager =>
    (sdk.logger.manager as unknown as { core: { config: ConfigManager } }).core.config;

  beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    delete window.groundcover;
    sdk = (await import("./index")).default;
    ({ EventsPool } = await import("@groundcover/rum-core/events/events-pool"));
  });

  afterEach(() => {
    sdk.logger.manager?.destroy();
    vi.restoreAllMocks();
    sessionStorage.clear();
    delete window.groundcover;
  });

  describe("public surface", () => {
    it("exposes the documented methods on the default export", () => {
      const methods = [
        "init",
        "identifyUser",
        "sendCustomEvent",
        "captureException",
        "updateConfig",
        "startNavigation",
        "endNavigation",
        "getSessionId",
        "setSessionId",
        "startReplayRecording",
        "stopReplayRecording",
      ] as const;
      for (const m of methods) {
        expect(typeof (sdk as unknown as Record<string, unknown>)[m]).toBe(
          "function"
        );
      }
      expect(sdk.logger).toBeDefined();
      expect(typeof sdk.logger.info).toBe("function");
    });

    it("exposes the SDK on window.groundcover", () => {
      const w = globalThis as unknown as { groundcover?: typeof sdk };
      expect(w.groundcover).toBeDefined();
      expect(typeof w.groundcover?.init).toBe("function");
    });
  });

  describe("pre-init: every public method is a safe no-op", () => {
    it("identifyUser does not throw", () => {
      expect(() => sdk.identifyUser({ id: "u" })).not.toThrow();
    });

    it("sendCustomEvent does not throw", () => {
      expect(() =>
        sdk.sendCustomEvent({ event: "x", attributes: {} })
      ).not.toThrow();
    });

    it("captureException does not throw", () => {
      expect(() => sdk.captureException(new Error("test"))).not.toThrow();
    });

    it("updateConfig does not throw", () => {
      expect(() => sdk.updateConfig({})).not.toThrow();
    });

    it("startNavigation does not throw", () => {
      expect(() => sdk.startNavigation({})).not.toThrow();
    });

    it("endNavigation does not throw", () => {
      expect(() => sdk.endNavigation({})).not.toThrow();
    });

    it("getSessionId returns an empty string", () => {
      expect(sdk.getSessionId()).toBe("");
    });

    it("setSessionId does not throw", async () => {
      await expect(sdk.setSessionId()).resolves.toBeUndefined();
    });

    it("startReplayRecording does not throw", () => {
      expect(() => sdk.startReplayRecording()).not.toThrow();
    });

    it("stopReplayRecording does not throw", () => {
      expect(() => sdk.stopReplayRecording()).not.toThrow();
    });

    it("logger.<level> does not throw", () => {
      expect(() => sdk.logger.info("hello")).not.toThrow();
      expect(() => sdk.logger.warn("hello", { x: 1 })).not.toThrow();
    });
  });

  describe("post-init: end-to-end event emission", () => {
    let addEventSpy: MockInstance<(event: BaseEvent) => void>;

    beforeEach(() => {
      addEventSpy = vi
        .spyOn(EventsPool.prototype, "addEvent")
        .mockImplementation(() => undefined);
      sdk.init({ appId: "test-app" });
      addEventSpy.mockClear();
    });

    const onlyEvent = (): BaseEvent => {
      expect(addEventSpy).toHaveBeenCalledTimes(1);
      return addEventSpy.mock.calls[0]![0] as BaseEvent;
    };

    it("updateConfig is contained AND fail-closed when a config getter throws", () => {
      // A hostile/throwing getter in caller config must not escape updateConfig
      // and crash the host app — and must not partially mutate live config.
      const before = getConfigManager().getConfig()?.options?.debug;

      const malicious: Record<string, unknown> = {};
      Object.defineProperty(malicious, "debug", {
        enumerable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      expect(() =>
        sdk.updateConfig({ options: malicious as never })
      ).not.toThrow();

      // No partial write: the stable option is unchanged.
      const after = getConfigManager().getConfig()?.options?.debug;
      expect(after).toBe(before);
    });

    it("sendCustomEvent emits a 'custom' event with the supplied attributes", () => {
      sdk.sendCustomEvent({
        event: "checkout",
        attributes: { orderId: 42, region: "us-east" },
      });

      expect(addEventSpy).toHaveBeenCalledTimes(1);
      const event = addEventSpy.mock.calls[0]![0] as BaseEvent;
      expect(event.type).toBe("custom");
      expect(event.attributes).toMatchObject({
        custom_event_name: "checkout",
        "custom_event_attributes.orderId": 42,
        "custom_event_attributes.region": "us-east",
      });
    });

    it("captureException emits an 'exception' event carrying error_metadata", () => {
      const err = new Error("boom");
      sdk.captureException(err, { feature: "checkout", attempt: 3 });

      expect(addEventSpy).toHaveBeenCalled();
      const event = addEventSpy.mock.calls[0]![0] as BaseEvent;
      expect(event.type).toBe("exception");
      expect(event.attributes?.error_message).toBe("boom");
      expect(event.attributes?.error_handled).toBe(true);
      expect(event.attributes).toMatchObject({
        "error_metadata.feature": "checkout",
        "error_metadata.attempt": 3,
      });
    });

    describe("captureException with a non-Error value", () => {
      it("reports a string as the error message", () => {
        sdk.captureException("plain string failure", { feature: "checkout" });

        const event = onlyEvent();
        expect(event.type).toBe("exception");
        expect(event.attributes).toMatchObject({
          error_type: "Error",
          error_message: "plain string failure",
          error_handled: true,
          "error_metadata.feature": "checkout",
        });
      });

      it("describes an object by its keys and sends the value as metadata", () => {
        sdk.captureException({ reason: "timeout", code: 500 }, { feature: "checkout" });

        expect(onlyEvent().attributes).toMatchObject({
          error_type: "Error",
          error_message: "Object captured as exception with keys: code, reason",
          "error_metadata.captured_value": '{"reason":"timeout","code":500}',
          "error_metadata.feature": "checkout",
        });
      });

      it("reports an object JSON.stringify cannot serialize", () => {
        const circular: Record<string, unknown> = { code: 500 };
        circular.self = circular;
        sdk.captureException(circular);

        expect(onlyEvent().attributes?.error_message).toBe("Object captured as exception with keys: code, self");
      });

      it("reports an object whose property reads throw", () => {
        const hostile = new Proxy({}, {
          get() {
            throw new Error("no reads");
          },
        });
        sdk.captureException(hostile);

        expect(onlyEvent().attributes?.error_message).toBe("Object captured as exception");
      });
    });

    describe("unhandled rejection with a non-Error reason", () => {
      // happy-dom has no PromiseRejectionEvent; stand one in so the listener's
      // rejection branch runs as it does in a browser.
      class FakePromiseRejectionEvent extends Event {
        constructor(readonly reason: unknown) {
          super("unhandledrejection");
        }
      }

      beforeEach(() => {
        vi.stubGlobal("PromiseRejectionEvent", FakePromiseRejectionEvent);
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      const rejectionEvent = (reason: unknown): BaseEvent => {
        window.dispatchEvent(new FakePromiseRejectionEvent(reason));
        return onlyEvent();
      };

      it("describes an object reason by its keys, as an UnhandledRejection", () => {
        expect(rejectionEvent({ code: 500 }).attributes).toMatchObject({
          error_type: "UnhandledRejection",
          error_message: "Object captured as promise rejection with keys: code",
          error_handled: false,
        });
      });

      it("reports a reason JSON.stringify cannot serialize", () => {
        const reason: Record<string, unknown> = { code: 500 };
        reason.self = reason;

        expect(rejectionEvent(reason).attributes).toMatchObject({
          error_type: "UnhandledRejection",
          error_message: "Object captured as promise rejection with keys: code, self",
        });
      });
    });

    describe("uncaught errors", () => {
      it("reports a thrown non-Error value at its throw site", () => {
        window.dispatchEvent(
          new ErrorEvent("error", {
            error: "boom",
            message: "Uncaught boom",
            filename: "https://app.example/main.js",
            lineno: 10,
            colno: 5,
          })
        );

        const event = onlyEvent();
        expect(event.attributes).toMatchObject({
          error_type: "Error",
          error_message: "boom",
          error_handled: false,
        });
        // One frame, at the throw site, and none from the SDK.
        const frames = JSON.stringify(event.attributes?.error_stacktrace);
        expect(event.attributes?.error_stacktrace).toHaveLength(1);
        expect(frames).toContain('"https://app.example/main.js"');
        expect(frames).toContain("10");
      });

      it("coerces a falsy thrown value instead of using the browser's own text", () => {
        window.dispatchEvent(new ErrorEvent("error", { error: 0, message: "Uncaught 0" }));

        expect(onlyEvent().attributes?.error_message).toBe("0");
      });

      it("keeps an Error-like thrown object's own name, message and stack", () => {
        window.dispatchEvent(
          new ErrorEvent("error", {
            error: {
              name: "ApiError",
              message: "quota exceeded",
              stack: "ApiError: quota exceeded\n    at load (https://app.example/api.js:3:7)",
            },
            filename: "https://app.example/main.js",
            lineno: 1,
            colno: 1,
          })
        );

        const event = onlyEvent();
        expect(event.attributes).toMatchObject({ error_type: "ApiError", error_message: "quota exceeded" });
        const frames = JSON.stringify(event.attributes?.error_stacktrace);
        expect(frames).toContain("api.js");
        expect(frames).not.toContain("main.js");
      });

      it("leaves the app's own Error object untouched", () => {
        const thrown = new Error("boom");
        window.dispatchEvent(
          new ErrorEvent("error", {
            error: thrown,
            message: "Uncaught Error: boom",
            filename: "https://app.example/main.js",
            lineno: 3,
            colno: 4,
          })
        );

        expect(onlyEvent().attributes?.error_message).toBe("boom");
        expect(Object.getOwnPropertyNames(thrown)).not.toContain("fileName");
      });

      it("reports an Error whose message only contains 'Script error'", () => {
        const thrown = new Error('Script error for "app/main"');
        window.dispatchEvent(new ErrorEvent("error", { error: thrown, message: `Uncaught ${thrown.message}` }));

        expect(onlyEvent().attributes?.error_message).toBe('Script error for "app/main"');
      });

      it("drops a muted cross-origin 'Script error.'", () => {
        window.dispatchEvent(new ErrorEvent("error", { error: null, message: "Script error." }));

        expect(addEventSpy).not.toHaveBeenCalled();
      });

      it("ignores an 'error' event on window that isn't an ErrorEvent", () => {
        window.dispatchEvent(new Event("error"));
        window.dispatchEvent(new CustomEvent("error", { bubbles: true }));

        expect(addEventSpy).not.toHaveBeenCalled();
      });
    });

    describe("rejection events that aren't PromiseRejectionEvents", () => {
      it("reports a Bluebird-style rejection by its reason", () => {
        const reason = new TypeError("quota exceeded");
        const event = new CustomEvent("unhandledrejection", { detail: { reason } });
        // Bluebird also puts the reason on the event as a non-enumerable property.
        Object.defineProperty(event, "reason", { value: reason });
        window.dispatchEvent(event);

        expect(onlyEvent().attributes).toMatchObject({
          error_type: "TypeError",
          error_message: "quota exceeded",
          error_handled: false,
        });
      });

      it("reads the reason from the event's detail", () => {
        window.dispatchEvent(new CustomEvent("unhandledrejection", { detail: { reason: { code: 7 } } }));

        expect(onlyEvent().attributes).toMatchObject({
          error_type: "UnhandledRejection",
          error_message: "Object captured as promise rejection with keys: code",
        });
      });

      it("ignores one that carries no reason", () => {
        window.dispatchEvent(new CustomEvent("unhandledrejection"));

        expect(addEventSpy).not.toHaveBeenCalled();
      });
    });

    describe("captureException with a DOM event", () => {
      it("describes an Event by its type and target, with the target's address as metadata", () => {
        const img = document.createElement("img");
        img.setAttribute("src", "https://cdn.example/a.png?sig=secret");
        img.addEventListener("error", (e) => sdk.captureException(e));
        img.dispatchEvent(new Event("error"));

        expect(onlyEvent().attributes).toMatchObject({
          error_type: "Error",
          error_message: "Event captured as exception (type=error, target=img)",
          error_handled: true,
          "error_metadata.captured_value": '{"type":"error","target":"img","src":"https://cdn.example/a.png"}',
        });
      });

      it("drops credentials from the target's address", () => {
        const img = document.createElement("img");
        img.setAttribute("src", "https://user:secret@cdn.example/a.png?sig=x#frag");
        img.addEventListener("error", (e) => sdk.captureException(e));
        img.dispatchEvent(new Event("error"));

        expect(onlyEvent().attributes?.["error_metadata.captured_value"]).toBe(
          '{"type":"error","target":"img","src":"https://cdn.example/a.png"}'
        );
      });

      it("keeps only the scheme of a data: address", () => {
        const img = document.createElement("img");
        img.setAttribute("src", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg");
        img.addEventListener("error", (e) => sdk.captureException(e));
        img.dispatchEvent(new Event("error"));

        expect(onlyEvent().attributes?.["error_metadata.captured_value"]).toBe(
          '{"type":"error","target":"img","src":"data:"}'
        );
      });

      it("reports an ErrorEvent by the error it carries", () => {
        sdk.captureException(new ErrorEvent("error", { error: new TypeError("bad input"), message: "x" }));

        expect(onlyEvent().attributes).toMatchObject({
          error_type: "TypeError",
          error_message: "bad input",
          error_handled: true,
        });
      });
    });

    it("logger.<level> emits a 'log' event end-to-end (wiring smoke test)", () => {
      sdk.logger.warn("post-init log", { route: "/checkout" });

      const logCall = addEventSpy.mock.calls.find(
        ([e]) => (e as BaseEvent).type === "log"
      );
      expect(logCall).toBeDefined();
      const event = logCall![0] as BaseEvent;
      expect(event.attributes).toMatchObject({
        message: "post-init log",
        level: "warn",
        route: "/checkout",
      });
    });

    it("identifyUser stores the supplied identifier on the SDK config", () => {
      sdk.identifyUser({
        id: "u_123",
        email: "u@example.com",
        name: "Alice",
      });

      const config = getConfigManager().getConfig();
      expect(config?.user).toMatchObject({
        id: "u_123",
        email: "u@example.com",
        name: "Alice",
      });
    });

    it("identifyUser merges partial updates without clobbering prior fields", () => {
      sdk.identifyUser({ id: "u_initial", email: "first@example.com" });
      sdk.identifyUser({ name: "Bob" });

      const config = getConfigManager().getConfig();
      expect(config?.user).toMatchObject({
        id: "u_initial",
        email: "first@example.com",
        name: "Bob",
      });
    });

    it("updateConfig applies options changes to the live config", () => {
      sdk.updateConfig({ options: { debug: true, transport: { batchSize: 25 } } });

      const config = getConfigManager().getConfig();
      expect(config?.options.debug).toBe(true);
      expect(config?.options.transport?.batchSize).toBe(25);
    });

    it("getSessionId returns a non-empty id that matches sessionStorage", () => {
      const id = sdk.getSessionId();
      expect(id).not.toBe("");
      expect(sessionStorage.getItem("gcId")).toBe(id);
    });

    it("setSessionId persists the supplied id to sessionStorage and getSessionId returns it", async () => {
      await sdk.setSessionId("custom-shared-session-id");

      expect(sdk.getSessionId()).toBe("custom-shared-session-id");
      expect(sessionStorage.getItem("gcId")).toBe("custom-shared-session-id");
    });

    it("setSessionId() with no argument generates a fresh non-empty id", async () => {
      const before = sdk.getSessionId();
      await sdk.setSessionId();
      const after = sdk.getSessionId();

      expect(after).not.toBe("");
      expect(after).not.toBe(before);
      expect(sessionStorage.getItem("gcId")).toBe(after);
    });

    it("init() wires the manager into the Logger instance", () => {
      expect(sdk.logger.manager).toBeDefined();
    });

    it.each(["test-app", "other-app"])("duplicate init for %s preserves the manager, session, and config", (appId) => {
      const firstManager = sdk.logger.manager;
      const firstSessionId = sdk.getSessionId();
      const config = getConfigManager().getConfig();
      const serializedConfig = JSON.stringify(config);
      expect(firstManager).toBeDefined();

      sdk.init({
        appId,
        sessionId: "replacement-session",
        cluster: "replacement-cluster",
        options: { debug: true, enabledEvents: ["dom"] },
      });

      expect(sdk.logger.manager).toBe(firstManager);
      expect(sdk.getSessionId()).toBe(firstSessionId);
      expect(getConfigManager().getConfig()).toBe(config);
      expect(JSON.stringify(config)).toBe(serializedConfig);
    });

    it.each(["test-app", "other-app"])("duplicate init for %s leaves instrumentation and the pool live", (appId) => {
      const firstManager = sdk.logger.manager as unknown as {
        core: {
          pool: { destroy: () => void };
          instrumentation: { uninstrument: () => void };
        } | null;
      };
      expect(firstManager.core).not.toBeNull();
      const poolDestroySpy = vi.spyOn(firstManager.core!.pool, "destroy");
      const uninstrumentSpy = vi.spyOn(
        firstManager.core!.instrumentation,
        "uninstrument"
      );

      const core = firstManager.core;
      sdk.init({ appId });

      expect(poolDestroySpy).not.toHaveBeenCalled();
      expect(uninstrumentSpy).not.toHaveBeenCalled();
      expect(firstManager.core).toBe(core);
    });

    it.each(["test-app", "other-app"])("duplicate init for %s keeps console capture working", (appId) => {
      sdk.init({ appId });
      addEventSpy.mockClear();
      console.info("console capture after duplicate init");
      const capturedLogs = addEventSpy.mock.calls.filter(
        ([event]) => (event as BaseEvent).type === "log"
      );
      expect(capturedLogs).toHaveLength(1);
    });

    it.each(["test-app", "other-app"])("duplicate init for %s does not flush a confirmed session", (appId) => {
      const core = (
        sdk.logger.manager as unknown as {
          core: {
            pool: { flush: (o?: unknown) => void };
          };
        }
      ).core;
      window.dispatchEvent(new Event("pointerdown"));
      const flushSpy = vi.spyOn(core.pool, "flush");
      sdk.init({ appId });
      expect(flushSpy).not.toHaveBeenCalled();
    });
  });
});
