import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { strFromU8 } from "fflate";

import { SessionManager } from "@/session-manager/session-manager";
import { Batch, BaseEvent } from "@groundcover/rum-core/events/types";
import { BASE_CONFIG, drainAsyncSends } from "@/test-utils/pipeline";

// Visits before the first interaction, through the whole browser pipeline against a stubbed
// fetch. The SDK sends nothing for a session until the user first interacts (the ghost-session
// gate) and drops what it held if they never do. The exception: hiding or leaving the page
// sends the session, everything it held included, if the page was visible at some point (the
// user could see it), or if it caught a real exception (a page that threw in a background tab).
//
// BASE_CONFIG has batchSize 0 and compression off: every event asks for a send, so the gate is
// what holds them, and bodies are plain JSON. jsdom reports the page visible. The golden suite
// holds the reference tests.

const RESIZE_OBSERVER_LOOP = "ResizeObserver loop completed with undelivered notifications.";

function sentBatches(fetchMock: ReturnType<typeof vi.fn>): Batch[] {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as { body: Uint8Array };
    return JSON.parse(strFromU8(init.body)) as Batch;
  });
}

function sentEvents(fetchMock: ReturnType<typeof vi.fn>): BaseEvent[] {
  return sentBatches(fetchMock).flatMap((batch) => batch.events);
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

// The page loads out of sight (a background tab): call before the SDK starts.
function loadInBackground(): void {
  setVisibility("hidden");
}

// The tab is hidden: the SDK's lifecycle flush. The event bubbles, as the browser's does: the
// SDK listens on window.
function hidePage(): void {
  setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}

// The user switches to the tab.
function showPage(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}

describe("visits before the first interaction", () => {
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
    delete (document as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  describe("a page that was visible", () => {
    it("hiding it sends the visit with everything it held, no exception needed", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.sendCustomEvent({ event: "while_loading", attributes: {} });
      manager.emitLog("a request failed", "error");
      await drainAsyncSends();
      // Held until the page is hidden: no send while the user is still there.
      expect(fetchMock).not.toHaveBeenCalled();

      hidePage();
      await drainAsyncSends();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const events = sentEvents(fetchMock);
      expect(events.some((e) => e.attributes?.custom_event_name === "while_loading")).toBe(true);
      expect(events.some((e) => e.type === "log")).toBe(true);
      expect(sentBatches(fetchMock)[0]!.sessionAttributes.session_id).toBe(manager.getSessionId());
      // The page-hide send is a keepalive request, so leaving the page doesn't cancel it.
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ keepalive: true });
    });

    it("pagehide sends it too (a reload or a navigation away)", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.sendCustomEvent({ event: "while_loading", attributes: {} });
      window.dispatchEvent(new Event("pagehide"));
      await drainAsyncSends();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentEvents(fetchMock).some((e) => e.attributes?.custom_event_name === "while_loading")).toBe(true);
    });
  });

  describe("a page that was never visible (loaded in a background tab)", () => {
    beforeEach(() => {
      loadInBackground();
    });

    it("hiding or leaving it sends the visit when it caught an exception, with everything it held", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.sendCustomEvent({ event: "before_error", attributes: {} });
      manager.captureException(new Error("load failed"));
      await drainAsyncSends();
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
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ keepalive: true });
    });

    it("a visit without an exception is still not sent", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.sendCustomEvent({ event: "background", attributes: {} });
      manager.emitLog("an error-level log is not an exception", "error");
      hidePage();
      window.dispatchEvent(new Event("pagehide"));
      await drainAsyncSends();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a harmless browser error does not send it", async () => {
      manager = new SessionManager(BASE_CONFIG);
      window.dispatchEvent(new ErrorEvent("error", { message: RESIZE_OBSERVER_LOOP }));
      manager.captureException(new Error(RESIZE_OBSERVER_LOOP));
      hidePage();
      await drainAsyncSends();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a harmless error goes along when a real one sends the visit", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.captureException(new Error(RESIZE_OBSERVER_LOOP));
      manager.captureException(new Error("load failed"));
      hidePage();
      await drainAsyncSends();

      const messages = sentEvents(fetchMock)
        .filter((e) => e.type === "exception")
        .map((e) => e.attributes?.error_message);
      expect(messages).toEqual(expect.arrayContaining([RESIZE_OBSERVER_LOOP, "load failed"]));
    });

    it("once the user switches to the tab, hiding it sends the visit without an exception", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.sendCustomEvent({ event: "background", attributes: {} });
      showPage();
      hidePage();
      await drainAsyncSends();

      expect(sentEvents(fetchMock).some((e) => e.attributes?.custom_event_name === "background")).toBe(true);
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

    it("an exception the app captures in its own hide listener goes with that send", async () => {
      manager = new SessionManager(BASE_CONFIG);
      const sdk = manager;
      // Added after the SDK started, as an app's or web-vitals' listener is.
      const appListener = () => {
        if (document.visibilityState === "hidden") sdk.captureException(new Error("save on hide failed"));
      };
      document.addEventListener("visibilitychange", appListener);
      try {
        hidePage();
        await drainAsyncSends();
      } finally {
        document.removeEventListener("visibilitychange", appListener);
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentEvents(fetchMock).find((e) => e.type === "exception")?.attributes).toMatchObject({
        error_message: "save on hide failed",
      });
    });

    it("pagehide sends it when no visibilitychange comes (a tab closed while still in the background)", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.captureException(new Error("load failed"));
      window.dispatchEvent(new Event("pagehide"));
      await drainAsyncSends();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentEvents(fetchMock).some((e) => e.type === "exception")).toBe(true);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ keepalive: true });
    });

    it("visibilitychange then pagehide sends it once", async () => {
      manager = new SessionManager(BASE_CONFIG);
      manager.captureException(new Error("load failed"));
      hidePage();
      window.dispatchEvent(new Event("pagehide"));
      await drainAsyncSends();

      expect(sentEvents(fetchMock).filter((e) => e.type === "exception")).toHaveLength(1);
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
});
