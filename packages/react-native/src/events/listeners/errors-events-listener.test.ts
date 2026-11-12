import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ConfigManager,
  EventEnricher,
  EventsPool,
  SafeStorage,
  SessionState,
  type PlatformStorage,
} from "@groundcover/rum-core";
import { ErrorsEventsListener } from "./errors-events-listener";
import type { RNEventType } from "../rn-event-types";

// Keep the JSC rejection-tracking path hermetic: default to "module absent" so
// tests never enable a real tracker on Node's global Promise. Individual tests
// opt into a fake module via rejectionState.module.
const { rejectionState } = vi.hoisted(() => ({
  rejectionState: { module: null as unknown },
}));
vi.mock("../../platform/optional-modules", () => ({
  loadRejectionTracking: () => rejectionState.module,
}));

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type RejectionOptions = {
  allRejections: boolean;
  onUnhandled: (id: number, error: unknown) => void;
  onHandled: (id: number) => void;
};

function makePool(privacyLevel?: "allow" | "mask-sensitive" | "mask-all") {
  const config = new ConfigManager();
  config.initialize({
    dsn: "ingest.example",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
    options: {
      transport: { batchSize: 0, compression: false },
      ...(privacyLevel ? { privacy: { level: privacyLevel } } : {}),
    },
  });
  const map = new Map<string, string>();
  const backing: PlatformStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  const session = new SessionState({ storage: new SafeStorage(backing) });
  const send = vi.fn();
  const pool = new EventsPool<RNEventType>({
    config,
    session,
    transporter: { send } as never,
    getDeviceAttributes: () => ({ source: "mobile-rum" }),
    eventsToSkipFlush: [],
  });
  pool.initialize();
  const enricher = new EventEnricher();
  return { config, pool, enricher, send };
}

function exceptionsFrom(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls
    .flatMap((c) => (c[0] as { events: Array<Record<string, unknown>> }).events)
    .filter((e) => e.type === "exception");
}

describe("ErrorsEventsListener", () => {
  let originalErrorUtils: unknown;
  let originalHermes: unknown;

  beforeEach(() => {
    originalErrorUtils = (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
    originalHermes = (globalThis as { HermesInternal?: unknown }).HermesInternal;
  });

  afterEach(() => {
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = originalErrorUtils;
    (globalThis as { HermesInternal?: unknown }).HermesInternal = originalHermes;
    rejectionState.module = null;
    vi.restoreAllMocks();
  });

  // ── Direct API: groundcover.captureException ──
  it("captureException emits a handled exception event (type/message/handled on the wire)", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });

    listener.captureException(new Error("boom"));
    pool.flush();

    const [evt] = exceptionsFrom(send);
    expect(evt).toBeDefined();
    const attrs = evt!.attributes as Record<string, unknown>;
    expect(attrs.error_type).toBe("Error");
    expect(attrs.error_message).toBe("boom");
    expect(attrs.error_handled).toBe(true);
  });

  it("buildEvent carries error_metadata (dot-flattened, like every listener) for a handled error", () => {
    const { config, pool, enricher } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });

    const evt = listener.buildEvent(new Error("boom"), {
      handled: true,
      metadata: { feature: "checkout", attempt: 3 },
    });
    // enrich() flattens nested attributes via formatEventObject, so the metadata
    // object lands as dotted keys.
    const attrs = evt!.attributes as Record<string, unknown>;
    expect(attrs.error_type).toBe("Error");
    expect(attrs.error_handled).toBe(true);
    expect(attrs["error_metadata.feature"]).toBe("checkout");
    expect(attrs["error_metadata.attempt"]).toBe(3);
  });

  it("captureException coerces a non-Error throwable into an error message", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });

    listener.captureException("just a string");
    pool.flush();

    const [evt] = exceptionsFrom(send);
    expect((evt!.attributes as Record<string, unknown>).error_message).toBe("just a string");
  });

  // ── Global listener: automatic uncaught capture via ErrorUtils ──
  it("captures an uncaught error via the ErrorUtils global handler (handled: false) and chains the previous handler", () => {
    const previous = vi.fn();
    let current: GlobalErrorHandler | undefined = previous;
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: GlobalErrorHandler) => {
        current = h;
      },
    };

    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    // The SDK installed its wrapper; simulate the runtime reporting an uncaught error.
    expect(current).not.toBe(previous);
    const err = new Error("uncaught!");
    current?.(err, true);
    pool.flush();

    const [evt] = exceptionsFrom(send);
    expect(evt).toBeDefined();
    const attrs = evt!.attributes as Record<string, unknown>;
    expect(attrs.error_message).toBe("uncaught!");
    expect(attrs.error_handled).toBe(false);
    // Host's own handler still runs (redbox/crash preserved).
    expect(previous).toHaveBeenCalledWith(err, true);

    listener.destroy();
  });

  it("forces a lifecycle flush on a FATAL uncaught error (crash sent before the process dies)", () => {
    let current: GlobalErrorHandler | undefined = vi.fn();
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: GlobalErrorHandler) => {
        current = h;
      },
    };
    const { config, pool, enricher } = makePool();
    const flushSpy = vi.spyOn(pool, "flush");
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    current?.(new Error("fatal!"), true); // isFatal
    // A fatal crash can't wait for the heartbeat/size flush — force the lifecycle
    // (inline-encode) flush, same path AppState-background uses.
    expect(flushSpy).toHaveBeenCalledWith({ lifecycle: true });
    listener.destroy();
  });

  it("does NOT force a lifecycle flush for a non-fatal uncaught error", () => {
    let current: GlobalErrorHandler | undefined = vi.fn();
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: GlobalErrorHandler) => {
        current = h;
      },
    };
    const { config, pool, enricher } = makePool();
    const flushSpy = vi.spyOn(pool, "flush");
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    current?.(new Error("recoverable"), false);
    expect(flushSpy).not.toHaveBeenCalledWith({ lifecycle: true });
    listener.destroy();
  });

  it("does not install the global handler when ErrorUtils.getGlobalHandler is unavailable", () => {
    // Without getGlobalHandler we can't capture (and later restore) the host's
    // real handler, so taking it over would suppress the host redbox/crash path.
    const setSpy = vi.fn();
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = { setGlobalHandler: setSpy };

    const { config, pool, enricher } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    expect(setSpy).not.toHaveBeenCalled();
    listener.destroy();
  });

  it("restores the previous ErrorUtils handler on destroy", () => {
    const previous = vi.fn();
    let current: GlobalErrorHandler | undefined = previous;
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: GlobalErrorHandler) => {
        current = h;
      },
    };

    const { config, pool, enricher } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();
    expect(current).not.toBe(previous);
    listener.destroy();
    expect(current).toBe(previous);
  });

  it("initialize() is idempotent — a double init still restores the ORIGINAL host handler on destroy", () => {
    // The header contract claims idempotent + restorable. Without a guard, a
    // second initialize() captures OUR OWN wrapper as `previousHandler`, so
    // destroy() would restore a stale wrapper and permanently drop the host's
    // real crash/redbox handler.
    const host = vi.fn();
    let current: GlobalErrorHandler | undefined = host;
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h: GlobalErrorHandler) => {
        current = h;
      },
    };

    const { config, pool, enricher } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();
    const afterFirst = current;
    listener.initialize(); // must be a no-op — do NOT re-wrap
    expect(current).toBe(afterFirst);

    listener.destroy();
    expect(current).toBe(host); // original host handler restored, not our wrapper
  });

  it("is a no-op (never throws) when ErrorUtils is absent", () => {
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = undefined;
    const { config, pool, enricher } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    expect(() => {
      listener.initialize();
      listener.destroy();
    }).not.toThrow();
  });

  // ── Unhandled promise rejections (global listener) ──
  it("captures an unhandled promise rejection via the Hermes tracker (handled: false)", () => {
    // Hermes exposes a native rejection tracker; there is no DOM
    // `unhandledrejection` event in RN. Install it and simulate a rejection.
    let opts: RejectionOptions | undefined;
    (globalThis as { HermesInternal?: unknown }).HermesInternal = {
      enablePromiseRejectionTracker: (o: RejectionOptions) => {
        opts = o;
      },
    };

    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    expect(opts).toBeDefined();
    expect(opts?.allRejections).toBe(true);
    // The engine reports an unhandled rejection.
    opts?.onUnhandled(1, new Error("rejected!"));
    pool.flush();

    const [evt] = exceptionsFrom(send);
    expect(evt).toBeDefined();
    const attrs = evt!.attributes as Record<string, unknown>;
    expect(attrs.error_message).toBe("rejected!");
    expect(attrs.error_handled).toBe(false);

    listener.destroy();
  });

  it("captures an unhandled rejection via the JSC promise polyfill tracker when Hermes is absent", () => {
    (globalThis as { HermesInternal?: unknown }).HermesInternal = undefined;
    let opts: RejectionOptions | undefined;
    let disabled = false;
    rejectionState.module = {
      enable: (o: RejectionOptions) => {
        opts = o;
      },
      disable: () => {
        disabled = true;
      },
    };

    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    expect(opts).toBeDefined();
    opts?.onUnhandled(7, "string rejection");
    pool.flush();

    const [evt] = exceptionsFrom(send);
    expect((evt!.attributes as Record<string, unknown>).error_message).toBe("string rejection");
    expect((evt!.attributes as Record<string, unknown>).error_handled).toBe(false);

    // destroy() disables the JSC module (best-effort; Hermes has no un-set).
    listener.destroy();
    expect(disabled).toBe(true);
  });

  it("stops emitting after destroy() even if the single-slot Hermes tracker fires again", () => {
    // Hermes' rejection slot can't be un-set, so its callback keeps our closure
    // alive. After destroy() a later rejection must NOT enqueue into the pool.
    let opts: RejectionOptions | undefined;
    (globalThis as { HermesInternal?: unknown }).HermesInternal = {
      enablePromiseRejectionTracker: (o: RejectionOptions) => {
        opts = o;
      },
    };
    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();
    listener.destroy();

    opts?.onUnhandled(1, new Error("after destroy")); // slot still holds our callback
    pool.flush();
    expect(exceptionsFrom(send)).toHaveLength(0);
  });

  it("labels a non-Error unhandled rejection as 'UnhandledRejection' (browser grouping parity)", () => {
    let opts: RejectionOptions | undefined;
    (globalThis as { HermesInternal?: unknown }).HermesInternal = {
      enablePromiseRejectionTracker: (o: RejectionOptions) => {
        opts = o;
      },
    };
    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    opts?.onUnhandled(1, "boom-string"); // non-Error reason
    opts?.onUnhandled(2, new TypeError("bad")); // real Error keeps its own name
    pool.flush();

    const evts = exceptionsFrom(send);
    const stringReject = evts.find(
      (e) => (e.attributes as Record<string, unknown>).error_message === "boom-string"
    );
    expect((stringReject!.attributes as Record<string, unknown>).error_type).toBe("UnhandledRejection");
    expect(evts.some((e) => (e.attributes as Record<string, unknown>).error_type === "TypeError")).toBe(true);

    listener.destroy();
  });

  it("reports, and never throws for, a rejection reason whose every read throws", () => {
    let opts: RejectionOptions | undefined;
    (globalThis as { HermesInternal?: unknown }).HermesInternal = {
      enablePromiseRejectionTracker: (o: RejectionOptions) => {
        opts = o;
      },
    };
    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const throwingFn = Object.assign(() => 0, {
      toString() {
        throw new Error("no string");
      },
    });

    // The tracker calls onUnhandled from a timer: a throw here would be fatal.
    expect(() => {
      opts?.onUnhandled(1, revoked);
      opts?.onUnhandled(2, throwingFn);
    }).not.toThrow();
    pool.flush();

    expect(exceptionsFrom(send).map((e) => (e.attributes as Record<string, unknown>).error_message)).toEqual([
      "Object captured as promise rejection",
      "Function captured as promise rejection",
    ]);
    listener.destroy();
  });

  it("does no work for a rejection that arrives after destroy", () => {
    let opts: RejectionOptions | undefined;
    (globalThis as { HermesInternal?: unknown }).HermesInternal = {
      enablePromiseRejectionTracker: (o: RejectionOptions) => {
        opts = o;
      },
    };
    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();
    listener.destroy(); // Hermes' tracker slot can't be cleared, so it still calls us

    let reads = 0;
    const reason = {
      get message() {
        reads++;
        return "late";
      },
    };
    opts?.onUnhandled(1, reason);
    pool.flush();

    expect(reads).toBe(0);
    expect(exceptionsFrom(send)).toHaveLength(0);
  });

  it("rejection tracking is a no-op (never throws) when no engine tracker is available", () => {
    (globalThis as { HermesInternal?: unknown }).HermesInternal = undefined;
    rejectionState.module = null;
    const { config, pool, enricher } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    expect(() => {
      listener.initialize();
      listener.destroy();
    }).not.toThrow();
  });

  it("does not double-install the rejection tracker on a second initialize()", () => {
    const enable = vi.fn();
    (globalThis as { HermesInternal?: unknown }).HermesInternal = {
      enablePromiseRejectionTracker: enable,
    };
    const { config, pool, enricher } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();
    listener.initialize();
    expect(enable).toHaveBeenCalledTimes(1);
    listener.destroy();
  });

  // ── Redaction ──
  it("redacts sensitive metadata keys (default masking) and passes them through under level 'allow'", () => {
    const masked = makePool(); // default level: mask-sensitive
    const l1 = new ErrorsEventsListener({ config: masked.config, eventsPool: masked.pool, enricher: masked.enricher });
    const attrs1 = l1.buildEvent(new Error("e"), { metadata: { password: "hunter2" } })
      .attributes as Record<string, unknown>;
    expect(attrs1["error_metadata.password"]).not.toBe("hunter2");

    const allow = makePool("allow");
    const l2 = new ErrorsEventsListener({ config: allow.config, eventsPool: allow.pool, enricher: allow.enricher });
    const attrs2 = l2.buildEvent(new Error("e"), { metadata: { password: "hunter2" } })
      .attributes as Record<string, unknown>;
    expect(attrs2["error_metadata.password"]).toBe("hunter2");
  });

  // ── Non-Error coercion: the same messages, and so fingerprints, as the browser ──
  it("reports a non-Error value with the message the browser gives it", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new ErrorsEventsListener({ config, eventsPool: pool, enricher });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hostile = new Proxy({}, {
      get() {
        throw new Error("no reads");
      },
    });

    listener.captureException({ a: 1 });
    listener.captureException(circular);
    listener.captureException(hostile);
    listener.captureException(null);
    pool.flush();

    const messages = exceptionsFrom(send).map(
      (e) => (e.attributes as Record<string, unknown>).error_message
    );
    expect(messages).toEqual([
      "Object captured as exception with keys: a",
      "Object captured as exception with keys: self",
      "Object captured as exception",
      "null",
    ]);
  });
});
