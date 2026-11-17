import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SessionManager } from "@/session-manager/session-manager";
import { SDKConfigInput } from "@/config/types";

// The browser sends batches with the page's fetch, which resolves rather than rejects on 4xx and
// 5xx. An endpoint that refuses the apiKey drops every batch, so the SDK must say so on the
// console even with debug off; otherwise it looks exactly like an SDK that is working.

// __dirname rather than import.meta.url: under happy-dom, `URL` is the DOM's, not Node's.
const BASE_CONFIG = JSON.parse(
  readFileSync(join(__dirname, "../../core/wire/config.json"), "utf8")
) as SDKConfigInput;

async function drainAsyncSends(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("an ingest endpoint that refuses the credentials", () => {
  let manager: SessionManager | null = null;

  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("Worker", undefined);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("warns once on the console, with debug off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    manager = new SessionManager(BASE_CONFIG);
    // A raw-input presence signal, so the SDK starts sending.
    window.dispatchEvent(new Event("pointerdown"));
    manager.sendCustomEvent({ event: "first", attributes: {} });
    manager.sendCustomEvent({ event: "second", attributes: {} });
    await drainAsyncSends();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const rejections = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("HTTP 401"));
    expect(rejections).toEqual([
      expect.stringContaining("https://ingest.golden.example/json/rum rejected a batch with HTTP 401"),
    ]);
  });
});
