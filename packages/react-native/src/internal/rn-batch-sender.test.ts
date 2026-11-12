import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchRequest } from "@groundcover/rum-core";

import { createRnBatchSender, RN_SEND_TIMEOUT_MS } from "./rn-batch-sender";

const request = (): BatchRequest => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: new Uint8Array([1, 2, 3]),
});

describe("createRnBatchSender", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes the request through to fetch verbatim", async () => {
    const send = createRnBatchSender();

    await send("https://ingest.example/v1", request());

    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("https://ingest.example/v1");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reports delivered when the server accepts it (2xx)", async () => {
    const onOutcome = vi.fn();
    const send = createRnBatchSender(onOutcome);

    await send("e", request());
    await Promise.resolve();

    expect(onOutcome).toHaveBeenCalledWith(true);
  });

  it("reports NOT delivered on a non-2xx — the transporter would call this sent", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const onOutcome = vi.fn();
    const send = createRnBatchSender(onOutcome);

    await send("e", request());
    await Promise.resolve();

    expect(onOutcome).toHaveBeenCalledWith(false);
  });

  it("reports NOT delivered on a network rejection", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const onOutcome = vi.fn();
    const send = createRnBatchSender(onOutcome);

    await expect(send("e", request())).rejects.toThrow("offline");
    await Promise.resolve();

    expect(onOutcome).toHaveBeenCalledWith(false);
  });

  it("surfaces a synchronous fetch throw as a rejection, and reports not delivered", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error("no global fetch");
    });
    const onOutcome = vi.fn();
    const send = createRnBatchSender(onOutcome);

    await expect(send("e", request())).rejects.toThrow("no global fetch");
    expect(onOutcome).toHaveBeenCalledWith(false);
  });

  it("aborts a request that outruns the timeout", async () => {
    vi.useFakeTimers();
    try {
      // Never resolves on its own, so only the abort can end it. Capture the signal
      // the sender wires in.
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementation((_endpoint, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise(() => {});
      });
      const send = createRnBatchSender();

      void send("e", request());
      expect(signal?.aborted).toBe(false);

      vi.advanceTimersByTime(RN_SEND_TIMEOUT_MS);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is fire-and-forget without an outcome callback — a non-2xx does not throw", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const send = createRnBatchSender();

    await expect(send("e", request())).resolves.toBeTruthy();
  });
});
