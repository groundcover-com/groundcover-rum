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

  it("resolves fetch at call time, so a fetch installed after init is used", async () => {
    const sender = createWebBatchSender();
    const later = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", later);

    await sender(ENDPOINT, request(10));

    expect(later).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
