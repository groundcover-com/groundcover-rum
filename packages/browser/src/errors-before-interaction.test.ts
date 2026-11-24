import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { strFromU8 } from "fflate";

import { SessionManager } from "@/session-manager/session-manager";
import { Batch, BaseEvent } from "@groundcover/rum-core/events/types";
import { BASE_CONFIG, drainAsyncSends } from "@/test-utils/pipeline";

// Errors before the first interaction, through the whole browser pipeline against a stubbed
// fetch. The SDK sends nothing for a session until the user first interacts (the ghost-session
// gate) and drops what it held if they never do. The one exception: hiding or leaving the page
// sends a session that caught an exception, everything it held included, so an error while
// loading isn't lost when the visitor leaves without touching anything.
//
// BASE_CONFIG has batchSize 0 and compression off: every event asks for a send, so the gate is
// what holds them, and bodies are plain JSON. The golden suite holds the reference test.

function sentBatches(fetchMock: ReturnType<typeof vi.fn>): Batch[] {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as { body: Uint8Array };
    return JSON.parse(strFromU8(init.body)) as Batch;
  });
}

function sentEvents(fetchMock: ReturnType<typeof vi.fn>): BaseEvent[] {
  return sentBatches(fetchMock).flatMap((batch) => batch.events);
}

// The tab is hidden: the SDK's lifecycle flush. showPage undoes it.
function hidePage(): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

function showPage(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
}

describe("errors before the first interaction", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let manager: SessionManager | null = null;

  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("Worker", undefined);
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    showPage();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("hiding the page sends the session with its exception and everything it held", async () => {
    manager = new SessionManager(BASE_CONFIG);
    manager.sendCustomEvent({ event: "before_error", attributes: {} });
    manager.captureException(new Error("load failed"));
    await drainAsyncSends();
    // Held until the page is hidden: no send while the user is still there.
    expect(fetchMock).not.toHaveBeenCalled();

    hidePage();
    await drainAsyncSends();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const events = sentEvents(fetchMock);
    expect(events.find((e) => e.type === "exception")?.attributes).toMatchObject({
      error_message: "load failed",
    });
    expect(
      events.some((e) => e.type === "custom" && e.attributes?.custom_event_name === "before_error")
    ).toBe(true);
    expect(sentBatches(fetchMock)[0]!.sessionAttributes.session_id).toBe(manager.getSessionId());
    // The page-hide send is a keepalive request, so leaving the page doesn't cancel it.
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ keepalive: true });
  });

  it("a session without an exception is still not sent", async () => {
    manager = new SessionManager(BASE_CONFIG);
    manager.sendCustomEvent({ event: "background", attributes: {} });
    manager.emitLog("an error-level log is not an exception", "error");
    hidePage();
    await drainAsyncSends();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an uncaught error counts like captureException", async () => {
    manager = new SessionManager(BASE_CONFIG);
    window.dispatchEvent(
      new ErrorEvent("error", { message: "uncaught on load", error: new Error("uncaught on load") })
    );
    hidePage();
    await drainAsyncSends();

    expect(sentEvents(fetchMock).some((e) => e.type === "exception")).toBe(true);
  });

  it("merges repeats of the error as usual", async () => {
    manager = new SessionManager(BASE_CONFIG);
    for (let i = 0; i < 3; i++) manager.captureException(new Error("same error"));
    hidePage();
    await drainAsyncSends();

    const exceptions = sentEvents(fetchMock).filter((e) => e.type === "exception");
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.attributes).toMatchObject({ error_repeat_count: 3 });
  });

  it("after the page is shown again, the session is still held until the user interacts", async () => {
    manager = new SessionManager(BASE_CONFIG);
    manager.captureException(new Error("load failed"));
    hidePage();
    await drainAsyncSends();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sessionId = sentBatches(fetchMock)[0]!.sessionAttributes.session_id;

    showPage();
    manager.sendCustomEvent({ event: "after_return", attributes: {} });
    await drainAsyncSends();
    // The exception went with the hide; the session is still unconfirmed.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A raw-input presence signal confirms it: the rest goes, same session.
    window.dispatchEvent(new Event("pointerdown"));
    manager.sendCustomEvent({ event: "after_interaction", attributes: {} });
    await drainAsyncSends();

    const later = sentBatches(fetchMock).slice(1);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((batch) => batch.sessionAttributes.session_id === sessionId)).toBe(true);
    const names = later
      .flatMap((batch) => batch.events)
      .map((e) => e.attributes?.custom_event_name);
    expect(names).toEqual(expect.arrayContaining(["after_return", "after_interaction"]));
  });
});
