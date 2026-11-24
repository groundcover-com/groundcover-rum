import { describe, it, expect, afterEach } from "vitest";

import { PageVisibilityTracker } from "./page-visibility";

// jsdom reports the page visible; each test overrides what the document reads.
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function setPrerendering(prerendering: boolean): void {
  Object.defineProperty(document, "prerendering", { configurable: true, get: () => prerendering });
}

describe("PageVisibilityTracker", () => {
  let tracker: PageVisibilityTracker | null = null;

  afterEach(() => {
    tracker?.stop();
    tracker = null;
    delete (document as { visibilityState?: unknown }).visibilityState;
    delete (document as { prerendering?: unknown }).prerendering;
  });

  it("is visible when the page is visible as it starts, and stays so once hidden", () => {
    setVisibility("visible");
    tracker = new PageVisibilityTracker();
    tracker.start();
    setVisibility("hidden");

    expect(tracker.wasVisible()).toBe(true);
  });

  it("is not visible for a page loaded and kept out of sight", () => {
    setVisibility("hidden");
    tracker = new PageVisibilityTracker();
    tracker.start();

    expect(tracker.wasVisible()).toBe(false);
  });

  it("becomes visible when the user switches to the tab", () => {
    setVisibility("hidden");
    tracker = new PageVisibilityTracker();
    tracker.start();
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("hidden");

    expect(tracker.wasVisible()).toBe(true);
  });

  it("counts a prerendered page only once it is opened", () => {
    setPrerendering(true);
    setVisibility("visible");
    tracker = new PageVisibilityTracker();
    tracker.start();
    expect(tracker.wasVisible()).toBe(false);

    setPrerendering(false);
    document.dispatchEvent(new Event("prerenderingchange"));
    setVisibility("hidden");
    expect(tracker.wasVisible()).toBe(true);
  });

  it("stops listening on stop()", () => {
    setVisibility("hidden");
    tracker = new PageVisibilityTracker();
    tracker.start();
    tracker.stop();
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("hidden");

    expect(tracker.wasVisible()).toBe(false);
  });
});
