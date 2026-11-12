import { describe, expect, it, vi } from "vitest";

// A HOSTILE REPORTER, for the whole file — which is why this lives in its own file rather than as
// cases in the consumers' test files. `handleError` is imported at module load time, so making it
// throw means mocking the module, and a module mock is per-file in vitest. Same construction as
// native-crash-drain.containment.test.ts.
//
// Reachable in principle rather than in theory: `handleError` ends up at the console, and other
// monitors patch it. Core captures `unpatchedConsoleLog` at ITS import, which sidesteps only the
// patch that existed at that moment — a monitor installed later, or one that replaces the whole
// `console` object, is still in the path.
vi.mock("@groundcover/rum-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@groundcover/rum-core")>();
  return {
    ...actual,
    handleError: vi.fn(() => {
      throw new Error("the host's logger is broken");
    }),
  };
});

const { reportSafely, runEachContained } = await import("./report-safely");
const { createScreenHolder } = await import("../platform/rn-platform");
const { AppStartListener } = await import("../events/listeners/app-start-listener");
const { ConfigManager, EventEnricher, RandomIdGenerator } = await import("@groundcover/rum-core");

describe("reportSafely", () => {
  it("swallows a reporter that throws", () => {
    expect(() => reportSafely(new Error("original"))).not.toThrow();
  });
});

describe("runEachContained", () => {
  it("runs every callback when one throws AND reporting it throws too", () => {
    // The double failure is the point: containing the callback but reporting with a bare
    // `handleError` moves the escape one line down instead of removing it.
    const ran: string[] = [];
    runEachContained([
      () => ran.push("first"),
      () => {
        throw new Error("second blew up");
      },
      () => ran.push("third"),
    ]);

    expect(ran).toEqual(["first", "third"]);
  });

  it("does not throw at its caller", () => {
    expect(() =>
      runEachContained([
        () => {
          throw new Error("boom");
        },
      ])
    ).not.toThrow();
  });
});

describe("AppStartListener — the SYNCHRONOUS screen path", () => {
  /**
   * The inline path, not only the buffered one.
   *
   * `whenScreenKnown` has two paths: buffer the metric until a screen lands, or — when one is
   * already current — run it inline. Only the buffered path goes through `runEachContained`, so on
   * the inline path `handleEvent`'s own catch is the last thing between a failed metric and the
   * caller, and the caller is the native signal router's dispatch, i.e. React Native's event
   * delivery. With a bare `handleError` there, a throwing host logger would move the escape one
   * line down instead of removing it.
   *
   * The two paths must contain identically, or the guarantee depends on whether a screen had
   * landed yet — which is a race, not a contract.
   */
  it("a failed metric with a screen already known does not escape handleEvent", () => {
    const config = new ConfigManager();
    config.initialize({
      dsn: "d",
      apiKey: "k",
      cluster: "c",
      environment: "e",
      appId: "a",
      options: {},
    } as never);

    const listener = new AppStartListener({
      config,
      eventsPool: { addEvent: vi.fn(), flush: vi.fn() } as never,
      enricher: new EventEnricher({ idGenerator: new RandomIdGenerator() }),
      // Already known — this is what selects the inline path.
      screenHolder: { get: () => ({ name: "Home", key: "h1" }), set: () => {}, subscribe: () => () => {} },
      ttiSource: "auto",
      idGenerator: new RandomIdGenerator(),
    });
    listener.initialize();

    // Fails where `queueEvent`'s own catch cannot see it: id generation and enrichment run before
    // the pool is ever reached.
    vi.spyOn(AppStartListener.prototype, "buildEvent").mockImplementation(() => {
      throw new Error("enrich boom");
    });

    expect(() =>
      listener.handleEvent({ type: "cold", startMs: 1_700_000_000_000, firstFrameMs: 1_700_000_000_842 })
    ).not.toThrow();

    vi.restoreAllMocks();
  });
});

describe("createScreenHolder", () => {
  it("a throwing listener AND a throwing reporter still leave set() silent", () => {
    // `set()` runs inside host navigation. Catching the listener's throw is not enough if the
    // `handleError` in that catch can throw straight back out into React Navigation's dispatch —
    // a broken host logger would turn one bad subscriber into a broken app.
    const holder = createScreenHolder();
    const after: string[] = [];
    holder.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    holder.subscribe((change) => after.push(change.incoming.name));

    expect(() => holder.set({ name: "Home", key: "h1" })).not.toThrow();
    // …and the subscriber behind the failing one still ran.
    expect(after).toEqual(["Home"]);
  });
});
