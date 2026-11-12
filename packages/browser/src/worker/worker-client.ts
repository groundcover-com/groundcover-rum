import { pack } from "@rrweb/packer";
import { Logger } from "@groundcover/rum-core/common/logger";
import { WORKER_SOURCE } from "./worker-source";

type RawReplayEvent = Parameters<typeof pack>[0];

export type EncodeResult = { data: Uint8Array; isCompressed: boolean };

type WorkerResponse =
  | { id: number; ok: true; result: { packed: string[] } }
  | { id: number; ok: true; result: { bytes: Uint8Array; isCompressed: boolean } }
  | { id: number; ok: false; error: string };

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// Per-call deadline before falling back to inline. Comfortably above worst-
// case real work (rrweb pack + fflate gzip) on a slow phone.
const WORKER_CALL_DEADLINE_MS = 1_500;

// Consecutive deadline misses (no success in between) before latching the
// worker off. A single success resets the streak.
const MAX_CONSECUTIVE_TIMEOUTS = 3;

// Wraps a single inline-blob Worker behind a Promise API. Any spawn/runtime
// failure flips isAvailable=false and routes callers to the inline path.
export class WorkerClient {
  private static instance: WorkerClient | null = null;

  private worker: Worker | null = null;
  private pending = new Map<number, PendingEntry>();
  private nextId = 0;
  private consecutiveTimeouts = 0;
  isAvailable = false;

  private logger = Logger.getInstance();

  static getInstance(): WorkerClient {
    if (!WorkerClient.instance) {
      WorkerClient.instance = new WorkerClient();
    }
    return WorkerClient.instance;
  }

  // Test seam — drop and recreate the singleton.
  static __resetForTests(): void {
    if (WorkerClient.instance) {
      WorkerClient.instance.terminate();
    }
    WorkerClient.instance = null;
  }

  // Try op on the worker, fall back to inline on any failure / no worker.
  // Centralizes the check + try/catch so callers don't drift.
  static async withFallback<T>(
    op: (worker: WorkerClient) => Promise<T>,
    inline: () => T,
    label: string,
  ): Promise<T> {
    const worker = WorkerClient.getInstance();
    if (!worker.isAvailable) return inline();
    try {
      return await op(worker);
    } catch (error) {
      Logger.getInstance().log(
        `[${label}] worker call failed, using inline fallback:`,
        error,
      );
      return inline();
    }
  }

  private constructor() {
    if (
      typeof Worker === "undefined" ||
      typeof URL === "undefined" ||
      typeof Blob === "undefined" ||
      !WORKER_SOURCE
    ) {
      return;
    }

    const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      this.worker = new Worker(url);
      // Defer revoke by a microtask: some older WebKit can race the worker's
      // blob fetch and silently fail to load if revoked synchronously.
      Promise.resolve().then(() => URL.revokeObjectURL(url));

      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
      this.worker.onerror = (event) => this.handleFatalFailure("worker onerror", event.message);
      // onmessageerror is one bad message, not worker death — don't latch off.
      this.worker.onmessageerror = () => this.logger.log(
        "[worker-client] worker onmessageerror — single message dropped, worker still alive",
      );

      this.isAvailable = true;
      this.logger.log("[worker-client] worker spawned");
    } catch (error) {
      // CSP / sandbox / unsupported env can throw in `new Worker(url)` after
      // we've created the blob URL — revoke synchronously here so a strict-CSP
      // page doesn't leak the URL until unload.
      URL.revokeObjectURL(url);
      this.logger.log(
        "[worker-client] failed to spawn worker, falling back to main thread:",
        error,
      );
      this.worker = null;
      this.isAvailable = false;
    }
  }

  packReplay(events: RawReplayEvent[]): Promise<string[]> {
    return this.dispatch<{ packed: string[] }>("pack-replay", { events }).then((r) => r.packed);
  }

  encodeBatch(json: string, compress: boolean): Promise<EncodeResult> {
    return this.dispatch<{ bytes: Uint8Array; isCompressed: boolean }>("encode-batch", { json, compress })
      .then((r) => ({ data: r.bytes, isCompressed: r.isCompressed }));
  }

  terminate(): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (error) {
        this.logger.log("[worker-client] failed to terminate worker:", error);
      }
      this.worker = null;
    }
    this.isAvailable = false;
    this.rejectAllPending(new Error("worker terminated"));
    // Drop the singleton so getInstance() after destroy/re-init spawns fresh.
    if (WorkerClient.instance === this) {
      WorkerClient.instance = null;
    }
  }

  private dispatch<T>(op: string, payload: unknown): Promise<T> {
    if (!this.worker || !this.isAvailable) {
      return Promise.reject(new Error("worker not available"));
    }

    const id = this.nextId++;
    const worker = this.worker;
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Reject just this call; caller falls back to inline. After
        // MAX_CONSECUTIVE_TIMEOUTS in a row the worker is treated as wedged.
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.consecutiveTimeouts += 1;
        if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          this.handleFatalFailure(
            `worker latched after ${MAX_CONSECUTIVE_TIMEOUTS} consecutive timeouts`,
          );
        }
        reject(new Error("worker request timed out"));
      }, WORKER_CALL_DEADLINE_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
      });
      try {
        worker.postMessage({ id, op, payload });
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(data: WorkerResponse): void {
    const entry = this.pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    this.pending.delete(data.id);
    // Any response — ok or ok=false — is proof of life. Reset the streak.
    this.consecutiveTimeouts = 0;
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      entry.reject(new Error(data.error));
    }
  }

  // Worker is truly dead — latch off and tear down. Only call from onerror
  // or the timeout-streak limit; single timeouts/onmessageerror don't.
  private handleFatalFailure(source: string, detail?: string): void {
    this.logger.log(`[worker-client] ${source}${detail ? ": " + detail : ""}`);
    this.isAvailable = false;
    this.rejectAllPending(new Error(source));
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
