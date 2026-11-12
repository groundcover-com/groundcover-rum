import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BaseEvent } from "@groundcover/rum-core/events/types";

describe("SDK logger", () => {
  let addEventSpy: ReturnType<typeof vi.spyOn>;
  let sdk: (typeof import("../index"))["default"];

  beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    delete window.groundcover;
    sdk = (await import("../index")).default;
    const { EventsPool } = await import("@groundcover/rum-core/events/events-pool");
    addEventSpy = vi
      .spyOn(EventsPool.prototype, "addEvent")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    sdk.logger.manager?.destroy();
    vi.restoreAllMocks();
    sessionStorage.clear();
    delete window.groundcover;
  });

  it("is a no-op before init()", () => {
    expect(typeof sdk.logger.info).toBe("function");
    expect(() => sdk.logger.info("hello")).not.toThrow();
  });

  const levels = ["log", "info", "warn", "error", "debug", "trace"] as const;

  for (const level of levels) {
    it(`logger.${level} emits a log event with level="${level}"`, () => {
      sdk.init({ appId: "test-app" });
      addEventSpy.mockClear();

      sdk.logger[level]("msg via " + level, { foo: "bar" });

      expect(addEventSpy).toHaveBeenCalledTimes(1);
      const event = addEventSpy.mock.calls[0]![0] as BaseEvent;
      expect(event.type).toBe("log");
      expect(event.attributes).toMatchObject({
        message: "msg via " + level,
        level,
        foo: "bar",
      });
    });
  }

  it("works without attributes", () => {
    sdk.init({ appId: "test-app" });
    addEventSpy.mockClear();

    sdk.logger.info("bare message");

    const event = addEventSpy.mock.calls[0]![0] as BaseEvent;
    expect(event.attributes?.message).toBe("bare message");
    expect(event.attributes?.level).toBe("info");
  });

  it("flattens nested attribute objects via enrichEvent", () => {
    sdk.init({ appId: "test-app" });
    addEventSpy.mockClear();

    sdk.logger.info("with nested", {
      user: { id: 1, profile: { plan: "pro" } },
    });

    const event = addEventSpy.mock.calls[0]![0] as BaseEvent;
    expect(event.attributes).toMatchObject({
      "user.id": 1,
      "user.profile.plan": "pro",
    });
  });

  it("reserved keys (message/level) win over user-supplied attributes", () => {
    sdk.init({ appId: "test-app" });
    addEventSpy.mockClear();

    sdk.logger.warn("real message", {
      message: "USER_OVERRIDE",
      level: "error",
    });

    const event = addEventSpy.mock.calls[0]![0] as BaseEvent;
    expect(event.attributes?.message).toBe("real message");
    expect(event.attributes?.level).toBe("warn");
  });

  it("strips user-supplied 'location' so the enriched browser location wins", () => {
    sdk.init({ appId: "test-app" });
    addEventSpy.mockClear();

    sdk.logger.info("nav event", {
      location: "checkout-step-2",
      appId: "web",
    });

    const event = addEventSpy.mock.calls[0]![0] as BaseEvent;
    expect(event.attributes?.location).not.toBe("checkout-step-2");
    expect(typeof event.attributes?.location).toBe("object");
    expect(event.attributes?.appId).toBe("web");
  });

  it("is a no-op when 'logs' is not in options.enabledEvents", () => {
    // Each init() builds a fresh ConfigManager, so the custom enabledEvents
    // apply directly — no config reset needed.
    sdk.init({
      appId: "test-app",
      options: { enabledEvents: ["dom"] },
    });
    addEventSpy.mockClear();

    sdk.logger.info("should be dropped", { foo: 1 });
    sdk.logger.error("also dropped", { foo: 2 });

    expect(addEventSpy).not.toHaveBeenCalled();
  });
});
