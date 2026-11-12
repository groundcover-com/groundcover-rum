import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Default-mock the worker source so each test starts with a known "available"
// path. Tests that need the no-source fallback override locally.
vi.mock("./worker-source", () => ({ WORKER_SOURCE: "/* worker stub */" }));

vi.mock("@groundcover/rum-core/common/logger", () => ({
  Logger: {
    getInstance: vi.fn().mockReturnValue({ log: vi.fn() }),
  },
}));

// ---- Stubbed Worker + Blob/URL globals -----------------------------------
// happy-dom defines Worker but postMessage is inert. Replace globally with a
// stub that drives bidirectional dispatch via Promise microtasks so we can
// exercise the request/response protocol.

type Handler = (event: { data: unknown; message?: string }) => void;

class StubWorker {
  static instances: StubWorker[] = [];
  static handler: ((self: StubWorker, msg: { id: number; op: string; payload: unknown }) => void) | null = null;

  onmessage: Handler | null = null;
  onerror: Handler | null = null;
  onmessageerror: Handler | null = null;
  terminated = false;
  postedMessages: Array<{ message: unknown; transfer: Transferable[] | undefined }> = [];

  constructor(public url: string) {
    StubWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.postedMessages.push({ message, transfer });
    if (StubWorker.handler) {
      // Use microtask scheduling so callers can attach .then() before we fire.
      Promise.resolve().then(() => {
        if (!this.terminated) StubWorker.handler!(this, message as { id: number; op: string; payload: unknown });
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  // Test helpers
  respond(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(message: string): void {
    this.onerror?.({ data: null, message });
  }
}

describe("WorkerClient", () => {
  const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(async () => {
    StubWorker.instances = [];
    StubWorker.handler = null;
    (globalThis as { Worker: typeof Worker }).Worker = StubWorker as unknown as typeof Worker;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:test");
    URL.revokeObjectURL = vi.fn();
    // Fresh singleton each test.
    const { WorkerClient } = await import("./worker-client");
    WorkerClient.__resetForTests();
  });

  afterEach(() => {
    if (originalWorker) {
      (globalThis as { Worker: typeof Worker }).Worker = originalWorker;
    }
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("spawns a worker from a blob URL and reports isAvailable", async () => {
    const { WorkerClient } = await import("./worker-client");
    const client = WorkerClient.getInstance();

    expect(client.isAvailable).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(StubWorker.instances).toHaveLength(1);
    // Revoke is deferred to a microtask to avoid racing the worker's blob
    // fetch on older WebKit — flush microtasks before checking.
    await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("routes responses back to the matching request by id", async () => {
    const { WorkerClient } = await import("./worker-client");
    const client = WorkerClient.getInstance();

    StubWorker.handler = (worker, msg) => {
      // Reply out of order on purpose: id 1 first, then 0.
      if (msg.id === 0) {
        setTimeout(() => worker.respond({ id: 0, ok: true, result: { packed: ["A"] } }), 5);
      } else {
        worker.respond({ id: 1, ok: true, result: { packed: ["B"] } });
      }
    };

    const first = client.packReplay(["e0" as unknown as never]);
    const second = client.packReplay(["e1" as unknown as never]);

    await expect(second).resolves.toEqual(["B"]);
    await expect(first).resolves.toEqual(["A"]);
  });

  it("encodeBatch forwards json + compress flag and surfaces data", async () => {
    const { WorkerClient } = await import("./worker-client");
    const client = WorkerClient.getInstance();

    StubWorker.handler = (worker, msg) => {
      const bytes = new Uint8Array([1, 2, 3]);
      worker.respond({ id: msg.id, ok: true, result: { bytes, isCompressed: true } });
    };

    const result = await client.encodeBatch('{"x":1}', true);

    expect(result.isCompressed).toBe(true);
    expect(Array.from(result.data)).toEqual([1, 2, 3]);
    const stub = StubWorker.instances[0]!;
    expect(stub.postedMessages[0]?.message).toEqual({
      id: 0,
      op: "encode-batch",
      payload: { json: '{"x":1}', compress: true },
    });
  });

  it("rejects pending calls and latches isAvailable=false on worker onerror", async () => {
    const { WorkerClient } = await import("./worker-client");
    const client = WorkerClient.getInstance();

    StubWorker.handler = null; // never respond

    const pending = client.encodeBatch('{}', false);

    // Drive the failure synchronously.
    StubWorker.instances[0]!.fail("boom");

    await expect(pending).rejects.toThrow(/worker onerror/);
    expect(client.isAvailable).toBe(false);

    // Subsequent calls on the SAME instance reject immediately. (terminate
    // drops the singleton, so calling getInstance() again would spawn fresh
    // — see the terminate-drops-singleton test below.)
    await expect(client.encodeBatch('{}', false)).rejects.toThrow(/worker not available/);
  });

  it("rejects single requests when the worker reports ok=false", async () => {
    const { WorkerClient } = await import("./worker-client");
    const client = WorkerClient.getInstance();

    StubWorker.handler = (worker, msg) => {
      worker.respond({ id: msg.id, ok: false, error: "pack-replay blew up" });
    };

    await expect(client.packReplay(["e" as unknown as never])).rejects.toThrow(/pack-replay blew up/);
    // Single ok=false does NOT latch isAvailable — only worker-level failures do.
    expect(client.isAvailable).toBe(true);
  });

  it("rejects a single timed-out request without latching the worker off", async () => {
    vi.useFakeTimers();
    try {
      const { WorkerClient } = await import("./worker-client");
      const client = WorkerClient.getInstance();
      StubWorker.handler = null; // never respond

      const pending = client.encodeBatch('{}', false);
      // Advance past the per-call deadline.
      vi.advanceTimersByTime(2_000);

      await expect(pending).rejects.toThrow(/worker request timed out/);
      // One timeout does NOT latch isAvailable — the worker may just be slow.
      expect(client.isAvailable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches isAvailable=false after MAX_CONSECUTIVE_TIMEOUTS timeouts in a row", async () => {
    vi.useFakeTimers();
    try {
      const { WorkerClient } = await import("./worker-client");
      const client = WorkerClient.getInstance();
      StubWorker.handler = null; // never respond

      const calls = [
        client.encodeBatch('{}', false).catch(() => null),
        client.encodeBatch('{}', false).catch(() => null),
        client.encodeBatch('{}', false).catch(() => null),
      ];
      vi.advanceTimersByTime(2_000);
      await Promise.all(calls);

      expect(client.isAvailable).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful response resets the timeout streak", async () => {
    vi.useFakeTimers();
    try {
      const { WorkerClient } = await import("./worker-client");
      const client = WorkerClient.getInstance();

      // Two timeouts, then a success — streak resets.
      StubWorker.handler = null;
      const first = client.encodeBatch('{}', false).catch(() => null);
      vi.advanceTimersByTime(2_000);
      await first;
      const second = client.encodeBatch('{}', false).catch(() => null);
      vi.advanceTimersByTime(2_000);
      await second;
      expect(client.isAvailable).toBe(true);

      // Now wire a responder and dispatch a third call that succeeds.
      StubWorker.handler = (worker, msg) => {
        worker.respond({ id: msg.id, ok: true, result: { bytes: new Uint8Array([0]), isCompressed: false } });
      };
      vi.useRealTimers();
      const ok = await client.encodeBatch('{}', false);
      expect(ok.isCompressed).toBe(false);

      // Two more timeouts — would have latched with streak=3 from earlier, but
      // success reset the counter, so still available.
      vi.useFakeTimers();
      StubWorker.handler = null;
      const fourth = client.encodeBatch('{}', false).catch(() => null);
      vi.advanceTimersByTime(2_000);
      await fourth;
      const fifth = client.encodeBatch('{}', false).catch(() => null);
      vi.advanceTimersByTime(2_000);
      await fifth;
      expect(client.isAvailable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onmessageerror does NOT latch isAvailable off (single bad message)", async () => {
    const { WorkerClient } = await import("./worker-client");
    const client = WorkerClient.getInstance();
    const stub = StubWorker.instances[0]!;

    stub.onmessageerror?.({ data: null });

    expect(client.isAvailable).toBe(true);
  });

  it("terminate() drops the singleton so getInstance() spawns fresh next time", async () => {
    const { WorkerClient } = await import("./worker-client");
    const first = WorkerClient.getInstance();
    expect(first.isAvailable).toBe(true);

    first.terminate();

    const second = WorkerClient.getInstance();
    expect(second).not.toBe(first);
    expect(second.isAvailable).toBe(true);
    expect(StubWorker.instances).toHaveLength(2);
  });

  it("terminate() flips isAvailable, kills the worker, and rejects in-flight", async () => {
    const { WorkerClient } = await import("./worker-client");
    const client = WorkerClient.getInstance();

    StubWorker.handler = null; // never respond
    const pending = client.encodeBatch('{}', false);

    client.terminate();

    expect(client.isAvailable).toBe(false);
    expect(StubWorker.instances[0]!.terminated).toBe(true);
    await expect(pending).rejects.toThrow(/worker terminated/);
  });

  it("isAvailable stays false when Worker constructor throws", async () => {
    (globalThis as { Worker: typeof Worker }).Worker = function () {
      throw new Error("CSP: worker-src blob: blocked");
    } as unknown as typeof Worker;

    const { WorkerClient } = await import("./worker-client");
    WorkerClient.__resetForTests();
    const client = WorkerClient.getInstance();

    expect(client.isAvailable).toBe(false);
  });

  it("revokes the blob URL synchronously when the Worker constructor throws", async () => {
    (globalThis as { Worker: typeof Worker }).Worker = function () {
      throw new Error("CSP: worker-src blob: blocked");
    } as unknown as typeof Worker;

    const { WorkerClient } = await import("./worker-client");
    WorkerClient.__resetForTests();
    WorkerClient.getInstance();

    // createObjectURL ran before the throw — revokeObjectURL must run in the
    // catch path or the blob URL leaks until page unload.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});

// Separate suite so the module-reset side effects don't leak into the main
// suite above. Each test here gets a fully fresh module graph.
describe("WorkerClient (empty worker source)", () => {
  const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    StubWorker.instances = [];
    StubWorker.handler = null;
    (globalThis as { Worker: typeof Worker }).Worker = StubWorker as unknown as typeof Worker;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:test");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    if (originalWorker) {
      (globalThis as { Worker: typeof Worker }).Worker = originalWorker;
    }
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.doUnmock("./worker-source");
    vi.resetModules();
  });

  it("isAvailable stays false when WORKER_SOURCE is empty (stub state)", async () => {
    vi.resetModules();
    vi.doMock("./worker-source", () => ({ WORKER_SOURCE: "" }));
    const { WorkerClient } = await import("./worker-client");
    WorkerClient.__resetForTests();
    const client = WorkerClient.getInstance();

    expect(client.isAvailable).toBe(false);
    expect(StubWorker.instances).toHaveLength(0);
  });
});
