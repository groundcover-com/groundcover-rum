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

describe("callback wrapping (errors the browser hides)", () => {
  let sdk: BrowserSdk;
  let addEventSpy: MockInstance<(event: BaseEvent) => void>;
  let held: HostFunction[];
  let hostSetTimeout: typeof setTimeout;
  let realSetTimeout: typeof setTimeout;
  let savedSlots: Array<[object, string, PropertyDescriptor | undefined]>;
  // The page's <script> elements, as the SDK sees them through document.scripts.
  let scripts: Array<{ src: string; type: string; hasAttribute(name: string): boolean }>;
  // How the reportError stand-in dispatches its event: hidden, as WebKit does
  // for a cross-origin caller, or in full, as Chrome does.
  let reportShows: "hidden" | "full";
  let hostReportError: typeof reportError;

  beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    delete window.groundcover;

    // Restored in afterEach: the global EventTarget, rAF, reportError and
    // document.scripts stand-ins, and the EventTarget patch, which the SDK
    // never restores itself.
    savedSlots = [
      [globalThis, "EventTarget"],
      [globalThis, "requestAnimationFrame"],
      [globalThis, "reportError"],
      [document, "scripts"],
      [domEventTarget.prototype, "addEventListener"],
      [domEventTarget.prototype, "removeEventListener"],
    ].map(([target, key]) => [target as object, key as string, Object.getOwnPropertyDescriptor(target, key as string)]);
    Object.defineProperty(globalThis, "EventTarget", { value: domEventTarget, writable: true, configurable: true });

    scripts = [];
    Object.defineProperty(document, "scripts", { get: () => scripts, configurable: true });
    reportShows = "hidden";
    Object.defineProperty(globalThis, "reportError", {
      value: (value: unknown) => {
        window.dispatchEvent(
          reportShows === "hidden"
            ? new ErrorEvent("error", { error: null, message: "Script error." })
            : new ErrorEvent("error", { error: value, message: `Uncaught ${String(value)}` })
        );
      },
      writable: true,
      configurable: true,
    });
    hostReportError = globalThis.reportError;

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

  const init = (enabledEvents: string[] = ["exceptions"]) => {
    sdk.init({ appId: "test-app", options: { enabledEvents: enabledEvents as never } });
    addEventSpy.mockClear();
  };

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

  describe("when the SDK isn't capturing exceptions", () => {
    it("hands the host the app's own callbacks and leaves addEventListener alone", () => {
      const before = EventTarget.prototype.addEventListener;
      const callback = () => undefined;
      setTimeout(callback, HELD);
      init(["dom"]);

      setTimeout(callback, HELD);
      setInterval(callback, HELD);
      requestAnimationFrame(callback);

      expect(held).toEqual([callback, callback, callback, callback]);
      expect(globalThis.setTimeout).toBe(hostSetTimeout);
      expect(EventTarget.prototype.addEventListener).toBe(before);
    });
  });

  describe.each(SCHEDULERS)("%s", (_name, schedule) => {
    it("reports the error its callback threw for the hidden 'Script error.' that follows", () => {
      init();
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
      init();
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
    init();
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
    init();
    hiddenError();

    expect(exceptions()).toHaveLength(0);
  });

  it("forgets a caught value when the task ends", async () => {
    init();
    setTimeout(() => {
      throw new Error("never reported");
    }, HELD);

    runHeld();
    await nextTask();
    hiddenError();

    expect(exceptions()).toHaveLength(0);
  });

  it("reports a thrown non-Error value without the SDK's own frames", () => {
    init();
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
    init();
    setTimeout("void 0" as unknown as HostFunction, HELD);

    expect(held).toEqual(["void 0"]);
  });

  describe("event listeners", () => {
    it("reports the error a listener threw for the hidden 'Script error.' that follows", () => {
      init();
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
      init();
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
      init();
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

    it("keeps a listener added before init registered once when it is added again", () => {
      const button = document.createElement("button");
      const listener = vi.fn();
      button.addEventListener("click", listener);

      init();
      button.addEventListener("click", listener);
      button.dispatchEvent(new Event("click"));
      expect(listener).toHaveBeenCalledTimes(1);

      button.removeEventListener("click", listener);
      button.dispatchEvent(new Event("click"));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("still removes a listener it wrapped after the SDK shuts down", () => {
      init();
      const button = document.createElement("button");
      const kept = vi.fn();
      const removed = vi.fn();
      button.addEventListener("click", kept);
      button.addEventListener("click", removed);

      sdk.logger.manager?.destroy();
      // Added again after shutdown: still the one registration.
      button.addEventListener("click", kept);
      button.removeEventListener("click", removed);
      button.dispatchEvent(new Event("click"));

      expect(kept).toHaveBeenCalledTimes(1);
      expect(removed).not.toHaveBeenCalled();
    });

    it("adds a new listener unwrapped after the SDK shuts down", () => {
      init();
      sdk.logger.manager?.destroy();
      const button = document.createElement("button");
      const error = new Error("after shutdown");
      button.addEventListener("click", () => {
        throw error;
      });

      expect(() => button.dispatchEvent(new Event("click"))).toThrow(error);
      hiddenError();

      expect(exceptions()).toHaveLength(0);
    });

    // happy-dom adds a listener even with an already-aborted signal, which a
    // browser doesn't, so this checks the call the SDK makes: an add that
    // adds nothing must not remove the listener's earlier registration.
    it("leaves a listener's earlier registration alone when it is added again with an aborted signal", () => {
      const nativeRemove = vi.spyOn(domEventTarget.prototype, "removeEventListener");
      init();
      const button = document.createElement("button");
      const listener = vi.fn();
      const controller = new AbortController();
      controller.abort();

      button.addEventListener("click", listener, { signal: controller.signal });
      expect(nativeRemove).not.toHaveBeenCalledWith("click", listener, expect.anything());

      button.addEventListener("click", listener);
      expect(nativeRemove).toHaveBeenCalledWith("click", listener, undefined);
    });
  });

  describe("third-party scripts", () => {
    const WIDGET = "https://widget.example/w.js";
    const appScript = () => new URL("/app.js", location.href).href;
    const script = (src: string, crossorigin = false) => ({
      src,
      type: "",
      hasAttribute: (name: string) => crossorigin && name === "crossorigin",
    });
    // An Error whose stack runs through these files, top frame first.
    const errorIn = (message: string, ...files: string[]) => {
      const error = new Error(message);
      error.stack = [
        `Error: ${message}`,
        ...files.map((file, i) => `    at fn${i} (${file}:${i + 1}:${i + 10})`),
      ].join("\n");
      return error;
    };
    const throwFromCallback = (error: Error) => {
      setTimeout(() => {
        throw error;
      }, HELD);
      runHeld();
    };

    it("drops an error thrown only in a script the page loads without crossorigin", () => {
      init();
      scripts = [script(WIDGET)];

      throwFromCallback(errorIn("widget broke", WIDGET, WIDGET));
      hiddenError();

      expect(exceptions()).toHaveLength(0);
    });

    it("drops it on a browser that shows it in full, too", () => {
      init();
      scripts = [script(WIDGET)];
      const error = errorIn("widget broke", WIDGET);

      throwFromCallback(error);
      window.dispatchEvent(new ErrorEvent("error", { error, message: "Uncaught Error: widget broke" }));

      expect(exceptions()).toHaveLength(0);
    });

    it("reports it when the app's own code is in the stack", () => {
      init();
      scripts = [script(WIDGET), script(appScript())];

      throwFromCallback(errorIn("widget broke under the app", WIDGET, appScript()));
      hiddenError();

      expect(exceptions()).toHaveLength(1);
    });

    it("reports an error from a third-party script loaded with crossorigin", () => {
      init();
      scripts = [script(WIDGET, true)];

      throwFromCallback(errorIn("cors widget broke", WIDGET));
      hiddenError();

      expect(exceptions()).toHaveLength(1);
    });

    it("reports an error from an address no script element has", () => {
      init();

      throwFromCallback(errorIn("chunk broke", "https://cdn.example/chunk-1.js"));
      hiddenError();

      expect(exceptions()).toHaveLength(1);
    });

    it("reports a third-party error the browser shows without a wrapper, as before", () => {
      init();
      scripts = [script(WIDGET)];
      const error = errorIn("shown by the browser", WIDGET);

      window.dispatchEvent(new ErrorEvent("error", { error, message: "Uncaught Error: shown by the browser" }));

      expect(exceptions()).toHaveLength(1);
    });
  });

  describe("reportError", () => {
    it("reports the value for the hidden 'Script error.' it dispatches", () => {
      init();
      reportError(new Error("reported by a framework"));

      expect(exceptions()).toHaveLength(1);
      expect(exceptions()[0]!.attributes?.error_message).toBe("reported by a framework");
    });

    it("reports a value the browser shows in full once", () => {
      init();
      reportShows = "full";
      reportError(new Error("shown in full"));
      hiddenError();

      expect(exceptions()).toHaveLength(1);
    });
  });

  it("gives a non-Error value that came through a wrapper no frame inside the SDK", () => {
    init();
    setTimeout(() => {
      throw "plain string";
    }, HELD);

    runHeld();
    // Where a browser that shows the error puts it: the wrapper's rethrow.
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: "plain string",
        message: "Uncaught plain string",
        filename: new URL("/sdk.js", location.href).href,
        lineno: 5,
        colno: 7,
      })
    );

    const [event] = exceptions();
    expect(event!.attributes?.error_message).toBe("plain string");
    expect(event!.attributes?.error_stacktrace ?? []).toHaveLength(0);
  });

  describe("lifecycle", () => {
    it("restores reportError when the SDK shuts down", () => {
      init();
      expect(globalThis.reportError).not.toBe(hostReportError);

      sdk.logger.manager?.destroy();
      expect(globalThis.reportError).toBe(hostReportError);
    });

    it("wraps the host's timers while the SDK runs and restores them when it shuts down", () => {
      init();
      expect(globalThis.setTimeout).not.toBe(hostSetTimeout);

      sdk.logger.manager?.destroy();
      expect(globalThis.setTimeout).toBe(hostSetTimeout);
      const callback = () => undefined;
      setTimeout(callback, HELD);
      expect(held).toEqual([callback]);
    });

    it("leaves a callback wrapped before shutdown passing errors through untouched", () => {
      init();
      const error = new Error("held over shutdown");
      setTimeout(() => {
        throw error;
      }, HELD);
      sdk.logger.manager?.destroy();

      expect(runHeld()).toBe(error);
    });
  });
});
