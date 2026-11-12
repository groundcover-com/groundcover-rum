import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager, RandomIdGenerator, type SDKConfigInput } from "@groundcover/rum-core";

// A HOSTILE REPORTER, for the whole file — which is why this lives in its own file rather than as a
// case in native-crash-drain.test.ts. `handleError` is imported by the module under test at load
// time, so making it throw means mocking the module, and a module mock is per-file in vitest.
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

const { __resetDrainStateForTest, drainNativeCrashReports } = await import("./native-crash-drain");

const SNAPSHOT = JSON.stringify({
  session_id: "crashed-session-id",
  session_start_time: 1_700_000_000_000_000_000,
  source: "mobile-rum",
  cluster: "c",
  env: "e",
  "service.name": "a",
});

function config(): ConfigManager {
  const manager = new ConfigManager();
  manager.initialize({
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
    options: { debug: false, transport: { batchSize: 0, compression: false } },
  } as SDKConfigInput);
  return manager;
}

describe("drainNativeCrashReports — a throwing reporter must not cost records", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetDrainStateForTest();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Two records, and the FIRST one fails inside the drain's own machinery — `clearPendingCrashReports`
   * rejects after a successful POST. That lands in the per-record catch, which reports the failure,
   * and the reporter throws.
   *
   * With the report unguarded that second throw escapes the `for` loop, so record two is never even
   * read: one broken logger turns one failed ack into a total drain failure, and the loss is silent
   * because the outer `.catch` swallows what the loop threw. Asserted on record two's DELIVERY rather
   * than on a spy call count, since the claim is that the drain kept going.
   */
  it("keeps draining the records behind one whose ack failed", async () => {
    const native = {
      nativeInit: vi.fn().mockResolvedValue("{}"),
      updateSessionSnapshot: vi.fn(),
      getPendingCrashReports: vi.fn().mockResolvedValue(
        JSON.stringify([
          { id: "crash-1", crashEpochMs: 1, errorType: "SIGSEGV", sessionSnapshotJson: SNAPSHOT },
          { id: "crash-2", crashEpochMs: 2, errorType: "SIGABRT", sessionSnapshotJson: SNAPSHOT },
        ])
      ),
      clearPendingCrashReports: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk gone"))
        .mockResolvedValue(undefined),
      flushFrameSegment: vi.fn().mockResolvedValue("null"),
      stop: vi.fn(),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };

    await drainNativeCrashReports({
      config: config(),
      idGenerator: new RandomIdGenerator(),
      native: native as never,
    });

    // Both were POSTed — the second record was reached despite the first one's reporting throw.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // And the survivor was acked, so it will not be redelivered on the next launch.
    expect(native.clearPendingCrashReports).toHaveBeenLastCalledWith(["crash-2"]);
  });

  // The outer `.catch(reportSafely)` has no test here, deliberately.
  //
  // Such a test passes identically with the guard and with a bare `handleError`,
  // because nothing can reach that catch. `readPendingCrashReports` contains its own failures and
  // returns `[]`, and the per-record catch above contains the rest — so the outer guard is
  // defence-in-depth against a throw between them, not a live path. A test for it would assert the
  // module's structure rather than its behaviour, and would go on passing with a bare loop site.
});
