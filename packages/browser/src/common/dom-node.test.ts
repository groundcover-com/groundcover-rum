import { describe, it, expect } from "vitest";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";
import { redactObject, REDACTED } from "@groundcover/rum-core/privacy/redaction";
import { isDomNode } from "./dom-node";

describe("isDomNode", () => {
  it("detects a real DOM element", () => {
    expect(isDomNode(document.createElement("div"))).toBe(true);
  });

  it("does NOT match plain metadata that merely looks node-like", () => {
    // No ownerDocument → not a node, so user metadata isn't misclassified.
    expect(isDomNode({ nodeType: 1, nodeName: "span", component: "Widget" })).toBe(false);
  });

  it("returns false (does not throw) for a hostile Proxy whose getters throw", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
      }
    );
    let result: boolean | undefined;
    expect(() => {
      result = isDomNode(hostile);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it("returns false for null / primitives", () => {
    expect(isDomNode(null)).toBe(false);
    expect(isDomNode(undefined)).toBe(false);
    expect(isDomNode("span")).toBe(false);
    expect(isDomNode(1)).toBe(false);
  });
});

// The browser injects isDomNode into core's walkers; these pin that a DOM
// element carrying a (self-referential) React fiber is never traversed.
describe("DOM nodes through core's walkers", () => {
  const elementWithFiber = () => {
    const element = document.createElement("div");
    const fakeFiber: Record<string, unknown> = {};
    fakeFiber.return = fakeFiber;
    fakeFiber.alternate = fakeFiber;
    (element as unknown as Record<string, unknown>).__reactFiber$abc = fakeFiber;
    return element;
  };

  it("enrichment emits a placeholder instead of flattening the node", () => {
    const enricher = new EventEnricher({ isOpaqueNode: isDomNode });
    const enriched = enricher.enrich({
      type: "custom",
      attributes: { custom_event_name: "test-event", leaked_element: elementWithFiber() },
    });
    expect(enriched.attributes).toMatchObject({
      custom_event_name: "test-event",
      leaked_element: "[HTMLDivElement]",
    });
  });

  it("redaction replaces the node wholesale", () => {
    const out = redactObject({ el: elementWithFiber() }, { isOpaqueNode: isDomNode });
    expect(out.el).toBe(REDACTED);
  });
});
