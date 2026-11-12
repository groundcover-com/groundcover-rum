import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LogEventsListener } from "./logs-events-listener";
import { EventsPool } from "../events-pool";
import { ConfigManager } from "../../config/config-manager";
import { EventEnricher } from "../event-enricher";
import { BaseEvent } from "../types";

describe("LogEventsListener", () => {
  let listener: LogEventsListener;
  let addEventSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const config = new ConfigManager();
    const enricher = new EventEnricher({
      enrichAttributes: () => ({ view: { name: "checkout" } }),
      reservedAttributeKeys: ["view"],
    });
    addEventSpy = vi.fn();
    listener = new LogEventsListener({
      config,
      eventsPool: { addEvent: addEventSpy } as unknown as EventsPool,
      enricher,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const capturedEvent = (): BaseEvent => {
    expect(addEventSpy).toHaveBeenCalledTimes(1);
    return addEventSpy.mock.calls[0]![0] as BaseEvent;
  };

  describe("extractAttributes", () => {
    it("returns undefined when no plain objects are present", () => {
      listener.handleEvent(["just a string", 42, true], "log");
      const event = capturedEvent();
      expect(event.attributes).toMatchObject({
        message: 'just a string 42 true',
        level: "log",
      });
      // No promoted keys
      expect(Object.keys(event.attributes ?? {})).toEqual(
        expect.arrayContaining(["message", "level", "view"])
      );
    });

    it("promotes a plain object arg to structured attributes", () => {
      listener.handleEvent(
        ["checkout failed", { appId: "web", environment: "prod" }],
        "log"
      );
      const event = capturedEvent();
      expect(event.attributes).toMatchObject({
        appId: "web",
        environment: "prod",
        level: "log",
      });
      expect(event.attributes?.message).toContain("checkout failed");
      expect(event.attributes?.message).toContain('"appId":"web"');
    });

    it("merges multiple object args with later-wins semantics", () => {
      listener.handleEvent(
        [{ a: 1, shared: "first" }, { b: 2, shared: "second" }],
        "info"
      );
      const event = capturedEvent();
      expect(event.attributes).toMatchObject({
        a: 1,
        b: 2,
        shared: "second",
        level: "info",
      });
    });

    it("flattens nested objects to dotted keys via enrichEvent", () => {
      listener.handleEvent(
        ["nested", { user: { id: 42, profile: { plan: "pro" } } }],
        "log"
      );
      const event = capturedEvent();
      expect(event.attributes).toMatchObject({
        "user.id": 42,
        "user.profile.plan": "pro",
      });
    });

    it("does not promote arrays, Errors, primitives, or null", () => {
      listener.handleEvent(
        ["mixed", [1, 2, 3], new Error("boom"), 42, null, undefined],
        "error"
      );
      const event = capturedEvent();
      const attrKeys = Object.keys(event.attributes ?? {});
      // Only reserved + the platform stamp should be present (no promoted keys from these args)
      expect(attrKeys.sort()).toEqual(["level", "message", "view"]);
    });

    it("reserved keys (message/level) win over user-supplied keys", () => {
      listener.handleEvent(
        ["hello", { message: "OVERRIDE_MESSAGE", level: "warn" }],
        "log"
      );
      const event = capturedEvent();
      expect(event.attributes?.level).toBe("log");
      expect(event.attributes?.message).toContain("hello");
      expect(event.attributes?.message).not.toBe("OVERRIDE_MESSAGE");
    });

    it("strips the platform's reserved keys so the enriched stamp wins", () => {
      listener.handleEvent(
        ["nav", { view: { name: "spoofed", step: 2 }, appId: "web" }],
        "log"
      );
      const event = capturedEvent();
      // The user object must neither replace the stamp nor leak alongside it
      // as flattened `view.*` keys.
      expect(event.attributes?.view).toEqual({ name: "checkout" });
      expect(event.attributes).not.toHaveProperty(["view.name"]);
      expect(event.attributes).not.toHaveProperty(["view.step"]);
      // sibling user keys still pass through
      expect(event.attributes?.appId).toBe("web");
    });

    it("does not reserve any key the platform did not declare", () => {
      listener.handleEvent(["nav", { location: "checkout-step-2" }], "log");
      expect(capturedEvent().attributes?.location).toBe("checkout-step-2");
    });

    it("intercepts console.debug and promotes object args", () => {
      listener.handleEvent(["debug msg", { appId: "web" }], "debug");
      const event = capturedEvent();
      expect(event.attributes?.level).toBe("debug");
      expect(event.attributes?.appId).toBe("web");
    });

    it("drops events whose stringified message contains groundcoverIgnore", () => {
      listener.handleEvent(
        ["please skip", { token: "groundcoverIgnore" }],
        "log"
      );
      expect(addEventSpy).not.toHaveBeenCalled();
    });

    it("stringifies an Error arg for console.error", () => {
      const err = new Error("boom");
      listener.handleEvent([err], "error");
      const event = capturedEvent();
      expect(event.attributes?.level).toBe("error");
      expect(String(event.attributes?.message)).toContain("Error: boom");
    });
  });

  describe("destroy — host wrapper preservation", () => {
    it("does not restore over a host wrapper installed on top of ours", () => {
      const preSdk = console.info;
      listener.initialize();
      const sdkWrapper = console.info;
      expect(sdkWrapper).not.toBe(preSdk); // sanity: we actually patched

      try {
        // A host (another monitoring lib / router) wraps console.info AFTER us,
        // delegating to the current (our) implementation.
        const hostWrapper = ((...args: unknown[]) =>
          (sdkWrapper as (...a: unknown[]) => void)(...args)) as typeof console.info;
        console.info = hostWrapper;

        listener.destroy();

        // destroy() must leave the host's wrapper in place — restoring the
        // pre-SDK original here would silently uninstall another library's
        // console instrumentation.
        expect(console.info).toBe(hostWrapper);
      } finally {
        console.info = preSdk;
      }
    });

    it("does not capture after destroy when reached via a host wrapper", () => {
      const preSdk = console.info;
      listener.initialize();
      const sdkWrapper = console.info;

      try {
        // Host wraps us and delegates to our wrapper; guarded restore leaves the
        // host wrapper in place on destroy, so calls still reach OUR retired
        // wrapper. It must delegate to the original but capture nothing.
        const hostWrapper = ((...args: unknown[]) =>
          (sdkWrapper as (...a: unknown[]) => void)(...args)) as typeof console.info;
        console.info = hostWrapper;

        listener.destroy();

        addEventSpy.mockClear();
        console.info("after destroy via host", { appId: "web" });
        expect(addEventSpy).not.toHaveBeenCalled();
      } finally {
        console.info = preSdk;
      }
    });

    it("unwraps our own layer on a clean destroy (no host on top)", () => {
      const preSdk = console.info;
      listener.initialize();
      const sdkWrapper = console.info;

      try {
        listener.destroy();

        // Our wrapper is gone and capture is off — a clean destroy still fully
        // detaches when nothing was layered on top of us.
        expect(console.info).not.toBe(sdkWrapper);
        addEventSpy.mockClear();
        console.info("after destroy", { appId: "web" });
        expect(addEventSpy).not.toHaveBeenCalled();
      } finally {
        console.info = preSdk;
      }
    });
  });
});
