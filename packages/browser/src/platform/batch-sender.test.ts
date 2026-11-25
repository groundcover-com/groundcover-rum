import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { BatchRequest } from "@groundcover/rum-core/transporter/transporter";
import { createWebBatchSender, KEEPALIVE_BODY_LIMIT_BYTES } from "./batch-sender";

// The send when the page is hidden or left must outlive the page: an ordinary
// fetch is cancelled with it (after the CORS preflight, before the batch goes).

const ENDPOINT = "https://ingest.example/json/rum";

function request(bodyBytes: number): BatchRequest {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: "key", "Content-Encoding": "" },
    body: new Uint8Array(bodyBytes),
  };
}

describe("createWebBatchSender", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a lifecycle batch with keepalive", async () => {
    const sent = request(1_000);
    await createWebBatchSender()(ENDPOINT, sent, { lifecycle: true });

    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, { ...sent, keepalive: true });
  });

  it("sends every other batch as a plain fetch", async () => {
    const sent = request(1_000);
    await createWebBatchSender()(ENDPOINT, sent);

    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, sent);
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("keepalive");
  });

  it("keeps keepalive up to the browsers' 64 KiB limit, and drops it past it", async () => {
    const sender = createWebBatchSender();
    await sender(ENDPOINT, request(KEEPALIVE_BODY_LIMIT_BYTES), { lifecycle: true });
    await sender(ENDPOINT, request(KEEPALIVE_BODY_LIMIT_BYTES + 1), { lifecycle: true });

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ keepalive: true });
    // Refused outright with it, so a bigger batch goes as a plain fetch.
    expect(fetchMock.mock.calls[1]![1]).not.toHaveProperty("keepalive");
  });

  // The 64 KiB is shared by every keepalive request in flight on the page, the
  // app's own included, so one that fits can still be refused.
  it("sends a refused lifecycle batch again once, without keepalive, and resolves with that response", async () => {
    const retried = { ok: true, status: 200 };
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(retried);
    const sent = request(1_000);

    await expect(createWebBatchSender()(ENDPOINT, sent, { lifecycle: true })).resolves.toBe(retried);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ keepalive: true });
    expect(fetchMock.mock.calls[1]).toEqual([ENDPOINT, sent]);
  });

  it("rejects when the retry fails too, and retries only once", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      createWebBatchSender()(ENDPOINT, request(1_000), { lifecycle: true })
    ).rejects.toThrow("Failed to fetch");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a send that never asked for keepalive", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const sender = createWebBatchSender();

    await expect(sender(ENDPOINT, request(1_000))).rejects.toThrow("Failed to fetch");
    await expect(
      sender(ENDPOINT, request(KEEPALIVE_BODY_LIMIT_BYTES + 1), { lifecycle: true })
    ).rejects.toThrow("Failed to fetch");

    // One attempt each: an ordinary send, and a lifecycle send past the limit.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves fetch at call time, so a fetch installed after init is used", async () => {
    const sender = createWebBatchSender();
    const later = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", later);

    await sender(ENDPOINT, request(10));

    expect(later).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
