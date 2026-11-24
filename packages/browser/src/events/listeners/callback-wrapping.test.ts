import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import type { BaseEvent } from "@groundcover/rum-core/events/types";

type BrowserSdk = (typeof import("../../index"))["default"];
type HostFunction = (this: unknown, ...args: unknown[]) => unknown;
type Scheduler = (callback: HostFunction) => void;

// The host's timers are stubbed so a test holds the callback the SDK handed
// the host and runs it itself, as the host would. Only calls with this delay
// are held; the SDK's own timers are scheduled for real.
const HELD = 987_654;

// Where this test environment differs from a browser, and how the tests cope:
// - The global `EventTarget` is Node's, not the class happy-dom's nodes
//   inherit from, so the tests point the global at the DOM's for the SDK to
//   patch, and test listeners on elements.
// - `dispatchEvent` rethrows a listener's error to its caller instead of
//   reporting it on window.
// - `requestAnimationFrame` is an accessor that ignores writes, so the tests
//   replace it with a plain function, as a browser has.
const domEventTarget = (() => {
  let proto: object | null = Object.getPrototypeOf(document.createElement("div"));
  while (proto && proto.constructor.name !== "EventTarget") proto = Object.getPrototypeOf(proto);
  return proto!.constructor as typeof EventTarget;
})();

describe("options.errors.wrapCallbacks", () => {
  let sdk: BrowserSdk;
  let addEventSpy: MockInstance<(event: BaseEvent) => void>;
  let held: HostFunction[];
  let hostSetTimeout: typeof setTimeout;
  let realSetTimeout: typeof setTimeout;
  let savedSlots: Array<[object, string, PropertyDescriptor | undefined]>;

  beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    delete window.groundcover;

    // Restored in afterEach: the global EventTarget and rAF stand-ins, and
    // the EventTarget patch, which the SDK never restores itself.
    savedSlots = [
      [globalThis, "EventTarget"],
      [globalThis, "requestAnimationFrame"],
      [domEventTarget.prototype, "addEventListener"],
      [domEventTarget.prototype, "removeEventListener"],
    ].map(([target, key]) => [target as object, key as string, Object.getOwnPropertyDescriptor(target, key as string)]);
    Object.defineProperty(globalThis, "EventTarget", { value: domEventTarget, writable: true, configurable: true });

    held = [];
    realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: HostFunction, delay?: number, ...rest: unknown[]) => {
      if (delay === HELD) {
        held.push(callback);
        return 0;
      }
      return realSetTimeout(callback, delay, ...rest);
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: HostFunction, delay?: number, ...rest: unknown[]) => {
      if (delay === HELD) {
        held.push(callback);
        return 0;
      }
      return realSetInterval(callback, delay, ...rest);
    }) as typeof setInterval);
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      value: (callback: HostFunction) => {
        held.push(callback);
        return 0;
      },
      writable: true,
      configurable: true,
    });
    hostSetTimeout = globalThis.setTimeout;

    sdk = (await import("../../index")).default;
    const { EventsPool } = await import("@groundcover/rum-core/events/events-pool");
    addEventSpy = vi.spyOn(EventsPool.prototype, "addEvent").mockImplementation(() => undefined);
  });

  afterEach(() => {
    sdk.logger.manager?.destroy();
    vi.restoreAllMocks();
    for (const [target, key, descriptor] of savedSlots) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete (target as Record<string, unknown>)[key];
    }
    sessionStorage.clear();
    delete window.groundcover;
  });

  const init = (wrapCallbacks?: boolean, enabledEvents: string[] = ["exceptions"]) => {
    sdk.init({
      appId: "test-app",
      options: {
        enabledEvents: enabledEvents as never,
        ...(wrapCallbacks === undefined ? {} : { errors: { wrapCallbacks } }),
      },
    });
    addEventSpy.mockClear();
  };

  const setWrapCallbacks = (wrapCallbacks: boolean) =>
    sdk.updateConfig({ options: { errors: { wrapCallbacks } } });

  const exceptions = () =>
    addEventSpy.mock.calls.map(([event]) => event).filter((event) => event.type === "exception");

  // What Safari dispatches for an error it hides.
  const hiddenError = () =>
    window.dispatchEvent(new ErrorEvent("error", { error: null, message: "Script error." }));

  // Run what the host was handed, and return what it threw.
  const runHeld = (callback: HostFunction = held[held.length - 1]!): unknown => {
    try {
      callback();
    } catch (thrown) {
      return thrown;
    }
    throw new Error("the callback did not throw");
  };

  const nextTask = () => new Promise((resolve) => realSetTimeout(resolve, 0));

  const SCHEDULERS: Array<[string, Scheduler]> = [
    ["setTimeout", (callback) => setTimeout(callback, HELD)],
    ["setInterval", (callback) => setInterval(callback, HELD)],
    ["requestAnimationFrame", (callback) => requestAnimationFrame(callback)],
  ];

  describe("off (the default)", () => {
    it("hands the host the app's own callbacks and leaves addEventListener alone", () => {
      const before = EventTarget.prototype.addEventListener;
      init();
      const callback = () => undefined;

      setTimeout(callback, HELD);
      setInterval(callback, HELD);
      requestAnimationFrame(callback);

      expect(held).toEqual([callback, callback, callback]);
      expect(EventTarget.prototype.addEventListener).toBe(before);
    });

    it("still drops a hidden error", () => {
      init(false);
      hiddenError();

      expect(exceptions()).toHaveLength(0);
    });
  });

  describe.each(SCHEDULERS)("%s", (_name, schedule) => {
    it("reports the error its callback threw for the hidden 'Script error.' that follows", () => {
      init(true);
      const error = new Error("boom in a callback");
      schedule(() => {
        throw error;
      });

      // The host gets the same value back, so the page behaves as it did.
      expect(runHeld()).toBe(error);
      hiddenError();

      const [event, ...rest] = exceptions();
      expect(rest).toHaveLength(0);
      expect(event!.attributes).toMatchObject({
        error_type: "Error",
        error_message: "boom in a callback",
        error_handled: false,
      });
      expect(JSON.stringify(event!.attributes?.error_stacktrace)).toContain("callback-wrapping.test");
    });

    it("passes this, the arguments and the return value through", () => {
      init(true);
      const callback = vi.fn(function (this: unknown) {
        return "returned";
      });
      schedule(callback);
      const context = { host: true };

      const wrapper = held[held.length - 1]!;
      expect(wrapper).not.toBe(callback);
      expect(wrapper.call(context, "a", 1)).toBe("returned");
      expect(callback).toHaveBeenCalledWith("a", 1);
      expect(callback.mock.contexts[0]).toBe(context);
    });
  });

  it("reports an error the browser shows in full once, from its event", () => {
    init(true);
    const error = new Error("shown in full");
    setTimeout(() => {
      throw error;
    }, HELD);

    runHeld();
    window.dispatchEvent(new ErrorEvent("error", { error, message: "Uncaught Error: shown in full" }));
    // A hidden error later in the task isn't matched to the value already reported.
    hiddenError();

    expect(exceptions()).toHaveLength(1);
    expect(exceptions()[0]!.attributes?.error_message).toBe("shown in full");
  });

  it("drops a hidden error no wrapper caught", () => {
    init(true);
    hiddenError();

    expect(exceptions()).toHaveLength(0);
  });

  it("forgets a caught value when the task ends", async () => {
    init(true);
    setTimeout(() => {
      throw new Error("never reported");
    }, HELD);

    runHeld();
    await nextTask();
    hiddenError();

    expect(exceptions()).toHaveLength(0);
  });

  it("reports a thrown non-Error value without the SDK's own frames", () => {
    init(true);
    setTimeout(() => {
      throw "plain string";
    }, HELD);

    expect(runHeld()).toBe("plain string");
    hiddenError();

    const [event] = exceptions();
    expect(event!.attributes?.error_message).toBe("plain string");
    expect(event!.attributes?.error_stacktrace ?? []).toHaveLength(0);
  });

  it("passes a string handler to setTimeout as is", () => {
    init(true);
    setTimeout("void 0" as unknown as HostFunction, HELD);

    expect(held).toEqual(["void 0"]);
  });

  describe("event listeners", () => {
    it("reports the error a listener threw for the hidden 'Script error.' that follows", () => {
      init(true);
      const button = document.createElement("button");
      const error = new Error("boom in a listener");
      button.addEventListener("click", () => {
        throw error;
      });

      let thrown: unknown;
      try {
        button.dispatchEvent(new Event("click"));
      } catch (value) {
        thrown = value;
      }
      expect(thrown).toBe(error);
      hiddenError();

      expect(exceptions()).toHaveLength(1);
      expect(exceptions()[0]!.attributes?.error_message).toBe("boom in a listener");
    });

    it("calls a listener with the target as this, once however often it was added, until removed", () => {
      init(true);
      const button = document.createElement("button");
      const listener = vi.fn(function (this: unknown) {});

      button.addEventListener("click", listener);
      button.addEventListener("click", listener);
      button.dispatchEvent(new Event("click"));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.contexts[0]).toBe(button);

      button.removeEventListener("click", listener);
      button.dispatchEvent(new Event("click"));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("calls an object's handleEvent on the object, looked up on each event", () => {
      init(true);
      const button = document.createElement("button");
      const calls: string[] = [];
      const listener = {
        handleEvent(this: unknown, event: Event) {
          calls.push(`first:${event.type}:${this === listener}`);
        },
      };

      button.addEventListener("click", listener);
      button.dispatchEvent(new Event("click"));
      listener.handleEvent = function (this: unknown, event: Event) {
        calls.push(`second:${event.type}:${this === listener}`);
      };
      button.dispatchEvent(new Event("click"));
      button.removeEventListener("click", listener);
      button.dispatchEvent(new Event("click"));

      expect(calls).toEqual(["first:click:true", "second:click:true"]);
    });

    it("keeps a listener added before wrapping started registered once when it is added again", () => {
      init(false);
      const button = document.createElement("button");
      const listener = vi.fn();
      button.addEventListener("click", listener);

      setWrapCallbacks(true);
      button.addEventListener("click", listener);
      button.dispatchEvent(new Event("click"));
      expect(listener).toHaveBeenCalledTimes(1);

      button.removeEventListener("click", listener);
      button.dispatchEvent(new Event("click"));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("still removes a listener it wrapped after wrapping is turned off or the SDK shuts down", () => {
      init(true);
      const button = document.createElement("button");
      const kept = vi.fn();
      const removedWhileOff = vi.fn();
      const removedAfterShutdown = vi.fn();
      button.addEventListener("click", kept);
      button.addEventListener("click", removedWhileOff);
      button.addEventListener("click", removedAfterShutdown);

      setWrapCallbacks(false);
      // Added again while off: still the one registration.
      button.addEventListener("click", kept);
      button.removeEventListener("click", removedWhileOff);
      sdk.logger.manager?.destroy();
      button.removeEventListener("click", removedAfterShutdown);
      button.dispatchEvent(new Event("click"));

      expect(kept).toHaveBeenCalledTimes(1);
      expect(removedWhileOff).not.toHaveBeenCalled();
      expect(removedAfterShutdown).not.toHaveBeenCalled();
    });
  });

  describe("configuration", () => {
    it("follows updateConfig: off restores the host's timers, on wraps them again", () => {
      init(true);
      expect(globalThis.setTimeout).not.toBe(hostSetTimeout);

      setWrapCallbacks(false);
      expect(globalThis.setTimeout).toBe(hostSetTimeout);
      const callback = () => undefined;
      setTimeout(callback, HELD);
      expect(held).toEqual([callback]);

      setWrapCallbacks(true);
      expect(globalThis.setTimeout).not.toBe(hostSetTimeout);
    });

    it("stays on when another errors option is updated", () => {
      init(true);
      sdk.updateConfig({ options: { errors: { deduplication: false } } });

      expect(globalThis.setTimeout).not.toBe(hostSetTimeout);
    });

    it("needs the exceptions listener", () => {
      init(true, ["dom"]);

      expect(globalThis.setTimeout).toBe(hostSetTimeout);
    });

    it("restores the host's timers when the SDK shuts down", () => {
      init(true);
      sdk.logger.manager?.destroy();

      expect(globalThis.setTimeout).toBe(hostSetTimeout);
    });
  });
});
