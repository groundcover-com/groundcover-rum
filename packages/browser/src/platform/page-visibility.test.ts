import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { PageVisibilityTracker } from "./page-visibility";

const WINDOW_MS = 30 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// jsdom reports the page visible; each test overrides what the document reads.
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function setPrerendering(prerendering: boolean): void {
  Object.defineProperty(document, "prerendering", { configurable: true, get: () => prerendering });
}

// The browser's tab switch: the state changes, then the event fires.
function switchTo(state: DocumentVisibilityState): void {
  setVisibility(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("PageVisibilityTracker", () => {
  let tracker: PageVisibilityTracker | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-15T08:00:00Z"));
  });

  afterEach(() => {
    tracker?.stop();
    tracker = null;
    vi.useRealTimers();
    delete (document as { visibilityState?: unknown }).visibilityState;
    delete (document as { prerendering?: unknown }).prerendering;
  });

  function startWhile(state: DocumentVisibilityState): PageVisibilityTracker {
    setVisibility(state);
    tracker = new PageVisibilityTracker();
    tracker.start();
    return tracker;
  }

  it("is visible while the page is visible, however long ago it started", () => {
    const visibility = startWhile("visible");
    vi.advanceTimersByTime(3 * 60 * MINUTE_MS);

    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(true);
  });

  it("stays visible for the window after the page is hidden, and not after", () => {
    const visibility = startWhile("visible");
    switchTo("hidden");

    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(true);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(false);
  });

  it("counts the window from when the page was hidden, not from when it was last read", () => {
    const visibility = startWhile("visible");
    // Visible for two hours with no visibility change, then hidden.
    vi.advanceTimersByTime(2 * 60 * MINUTE_MS);
    switchTo("hidden");
    vi.advanceTimersByTime(10 * MINUTE_MS);

    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(true);
  });

  it("counts a hide its listener missed as happening when it is next read", () => {
    const visibility = startWhile("visible");
    vi.advanceTimersByTime(2 * 60 * MINUTE_MS);
    // No visibilitychange heard: the page reads hidden at the next check.
    setVisibility("hidden");

    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(true);
  });

  it("is not visible for a page loaded and kept out of sight", () => {
    const visibility = startWhile("hidden");
    vi.advanceTimersByTime(MINUTE_MS);

    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(false);
  });

  it("is visible once the user switches to the tab, for the window after they leave it", () => {
    const visibility = startWhile("hidden");
    switchTo("visible");
    switchTo("hidden");

    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(true);
    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(false);
  });

  it("counts a prerendered page only once it is opened", () => {
    setPrerendering(true);
    const visibility = startWhile("visible");
    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(false);

    setPrerendering(false);
    document.dispatchEvent(new Event("prerenderingchange"));
    setVisibility("hidden");
    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(true);
  });

  it("stops listening on stop()", () => {
    const visibility = startWhile("hidden");
    visibility.stop();
    switchTo("visible");
    setVisibility("hidden");

    expect(visibility.wasVisibleWithin(WINDOW_MS)).toBe(false);
  });
});
