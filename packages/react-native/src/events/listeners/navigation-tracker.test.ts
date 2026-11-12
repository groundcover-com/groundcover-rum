import { describe, it, expect, vi } from "vitest";
import {
  ConfigManager,
  EventEnricher,
  EventsPool,
  SafeStorage,
  SessionState,
  type PlatformStorage,
} from "@groundcover/rum-core";
import { NavigationTracker, type NavigationContainerRefLike } from "./navigation-tracker";
import { createScreenHolder } from "../../platform/rn-platform";
import type { RNEventType } from "../rn-event-types";

function make() {
  const config = new ConfigManager();
  config.initialize({
    dsn: "d",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
    options: { transport: { batchSize: 0, compression: false } },
  });
  const map = new Map<string, string>();
  const backing: PlatformStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  const session = new SessionState({ storage: new SafeStorage(backing) });
  const pool = new EventsPool<RNEventType>({
    config,
    session,
    transporter: { send: vi.fn() } as never,
    getDeviceAttributes: () => ({ source: "mobile-rum" }),
    eventsToSkipFlush: [],
  });
  pool.initialize();
  const screenHolder = createScreenHolder();
  // Wired exactly as the composition root does (`session-manager.ts`), because the screen a
  // navigation event reports is not an attribute of the tracker's own — it is the ambient
  // `screen` block this hook stamps, which the tracker updates before emitting. An
  // enricher without the hook would leave every assertion below unable to see the screen at all.
  const enricher = new EventEnricher({
    enrichAttributes: () => ({ screen: screenHolder.get() }),
  });
  const tracker = new NavigationTracker({ config, eventsPool: pool, enricher, screenHolder });
  // Spy on the pool boundary so we observe the tracker's emit decision directly,
  // independent of the ghost-session send gate.
  const addSpy = vi.spyOn(pool, "addEvent");
  return { tracker, addSpy };
}

describe("NavigationTracker", () => {
  it("does not emit a navigation event when endNavigation has no matching start", () => {
    const { tracker, addSpy } = make();
    // No startNavigation → activeManual is null. Emitting here would ship a
    // screenless, duration_ms:0 garbage record (mirror the browser guard).
    tracker.endNavigation();
    tracker.endNavigation({ some: "meta" });
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("still emits for a matched start→end pair", () => {
    const { tracker, addSpy } = make();
    tracker.startNavigation({ screen: "Checkout" });
    tracker.endNavigation({ screen: "Checkout" });
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  it("does not emit a navigation event for a manual navigation with no screen name", () => {
    const { tracker, addSpy } = make();
    tracker.startNavigation({ foo: 1 }); // no screen / name
    tracker.endNavigation();
    expect(addSpy).not.toHaveBeenCalled(); // a screenless record is garbage
  });

  it("does not fabricate a screen name from a non-string screen value", () => {
    // `String({})` is "[object Object]" — truthy, so a coercing tracker treats a caller who
    // passed an object (or a number, or null shaped wrong) as a real screen and ships fabricated
    // attribution. A non-string screen with no usable fallback is no screen at all.
    const { tracker, addSpy } = make();
    tracker.startNavigation({ screen: { route: "Checkout" } });
    tracker.endNavigation();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("falls back to metadata.name when screen is not a usable string", () => {
    // The `.name` fallback only works if `screen` is REJECTED when unusable — with `??` an object
    // `screen` is non-null and wins, so `name` is never consulted. Here the emitted screen must be
    // "Detail", not "[object Object]".
    const { tracker, addSpy } = make();
    tracker.startNavigation({ screen: {}, name: "Detail" });
    tracker.endNavigation();
    const event = addSpy.mock.calls[0]![0] as { attributes: Record<string, unknown> };
    expect(event.attributes.screen).toEqual({ name: "Detail", key: "" });
  });

  it("ignores a whitespace-only screen name", () => {
    const { tracker, addSpy } = make();
    tracker.startNavigation({ screen: "   " });
    tracker.endNavigation();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("resets last-screen state on stopTracking so re-attaching re-stamps the current screen", () => {
    const { tracker, addSpy } = make();
    const route = { name: "A", key: "a1" };
    const ref: NavigationContainerRefLike = {
      isReady: () => true,
      getCurrentRoute: () => route,
      addListener: () => () => {},
    };
    tracker.startTracking(ref); // emits A (initial)
    tracker.stopTracking();
    tracker.startTracking(ref); // fresh session → A stamped again (not deduped against pre-stop A)

    const aEmits = addSpy.mock.calls.filter(
      (c) => ((c[0] as { attributes: Record<string, unknown> }).attributes.screen as { name?: string })?.name === "A"
    );
    expect(aEmits.length).toBe(2);
  });

  it("emits route name + key (ambient screen, from_screen/from_key), never a URL, on the auto path", () => {
    // Mobile screens are identified by React Navigation's route name + key (a
    // per-instance id), NOT URLs. So the wire carries names and keys — no
    // page_url, no from_url, no path.
    const { tracker, addSpy } = make();
    let stateCb: (() => void) | undefined;
    let route: { name: string; key?: string } = { name: "Reset", key: "reset-1" };
    const ref: NavigationContainerRefLike = {
      isReady: () => true,
      getCurrentRoute: () => route,
      addListener: (_type, cb) => {
        stateCb = cb;
        return () => {};
      },
    };

    tracker.startTracking(ref); // initial screen "Reset"
    route = { name: "Home", key: "home-1" };
    stateCb!(); // navigate Reset → Home

    const first = addSpy.mock.calls[0]![0] as { attributes: Record<string, unknown> };
    expect(first.attributes.screen).toEqual({ name: "Reset", key: "reset-1" });
    expect(first.attributes.from_screen).toBeUndefined(); // first screen has no origin
    expect(first.attributes.from_key).toBeUndefined();

    const second = addSpy.mock.calls[1]![0] as { attributes: Record<string, unknown> };
    expect(second.attributes.screen).toEqual({ name: "Home", key: "home-1" });
    expect(second.attributes.from_screen).toBe("Reset");
    expect(second.attributes.from_key).toBe("reset-1");

    // No URL vocabulary on a mobile nav event.
    const wire = JSON.stringify(second.attributes);
    expect(wire).not.toContain("page_url");
    expect(wire).not.toContain("from_url");
    expect(wire).not.toContain("path");
  });

  it("treats a new instance of the same-named screen (same name, new key) as a navigation", () => {
    // The route key is what disambiguates two instances of one screen — so a
    // Detail→Detail push with a different key IS a navigation, while a duplicate
    // state event for the SAME instance (same name + key) is deduped.
    const { tracker, addSpy } = make();
    let stateCb: (() => void) | undefined;
    let route: { name: string; key?: string } = { name: "Detail", key: "detail-1" };
    const ref: NavigationContainerRefLike = {
      isReady: () => true,
      getCurrentRoute: () => route,
      addListener: (_type, cb) => {
        stateCb = cb;
        return () => {};
      },
    };

    tracker.startTracking(ref); // Detail (detail-1)
    stateCb!(); // duplicate state event, same instance → deduped
    route = { name: "Detail", key: "detail-2" };
    stateCb!(); // new Detail instance → emits

    expect(addSpy).toHaveBeenCalledTimes(2); // initial + new instance, not the dupe
    const second = addSpy.mock.calls[1]![0] as { attributes: Record<string, unknown> };
    expect(second.attributes.screen).toEqual({ name: "Detail", key: "detail-2" });
    expect(second.attributes.from_key).toBe("detail-1"); // came from the first instance
  });

  it("derives the screen from the manual API and key-redacts sensitive metadata while masking", () => {
    const { tracker, addSpy } = make(); // default privacy: mask-sensitive
    tracker.startNavigation({ screen: "Pay", token: "SUPERSECRET", tab: "2" });
    tracker.endNavigation();

    // core's enricher dot-flattens nested attributes, so metadata.* lands as
    // "metadata.<key>" on the wire.
    const event = addSpy.mock.calls[0]![0] as { attributes: Record<string, unknown> };
    expect(event.attributes.screen).toEqual({ name: "Pay", key: "" });
    expect(event.attributes["metadata.token"]).not.toBe("SUPERSECRET"); // sensitive key scrubbed
    expect(event.attributes["metadata.tab"]).toBe("2"); // non-sensitive preserved
  });

  it("leaves navigation metadata untouched under privacy level 'allow'", () => {
    const config = new ConfigManager();
    config.initialize({
      dsn: "d", apiKey: "k", cluster: "c", environment: "e", appId: "a",
      options: { transport: { batchSize: 0, compression: false }, privacy: { level: "allow" } },
    });
    const map = new Map<string, string>();
    const backing: PlatformStorage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
    const session = new SessionState({ storage: new SafeStorage(backing) });
    const pool = new EventsPool<RNEventType>({
      config, session, transporter: { send: vi.fn() } as never,
      getDeviceAttributes: () => ({ source: "mobile-rum" }), eventsToSkipFlush: [],
    });
    pool.initialize();
    const enricher = new EventEnricher();
    const tracker = new NavigationTracker({ config, eventsPool: pool, enricher, screenHolder: createScreenHolder() });
    const addSpy = vi.spyOn(pool, "addEvent");

    tracker.startNavigation({ screen: "Pay", token: "KEEPME" });
    tracker.endNavigation();
    const event = addSpy.mock.calls[0]![0] as { attributes: Record<string, unknown> };
    expect(event.attributes["metadata.token"]).toBe("KEEPME"); // allow → no redaction
  });

  it("a throwing state-listener callback never propagates into React Navigation's dispatch", () => {
    const { tracker } = make();
    let stateCb: (() => void) | undefined;
    const ref: NavigationContainerRefLike = {
      isReady: () => true,
      getCurrentRoute: () => {
        throw new Error("getCurrentRoute boom");
      },
      addListener: (_type, cb) => {
        stateCb = cb;
        return () => {};
      },
    };

    // startTracking's initial call is already guarded; the risk is LATER state
    // events invoking the registered callback outside that try.
    tracker.startTracking(ref);
    expect(stateCb).toBeDefined();
    expect(() => stateCb!()).not.toThrow();
  });
});
