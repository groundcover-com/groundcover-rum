import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldMaskElement } from "./element";
import type { WebEffectivePrivacy } from "@/privacy/web-privacy";

// Minimal mask-sensitive privacy (the default): no level-wide text masking,
// `.gc-mask` is an explicit mask selector.
const maskSensitive: WebEffectivePrivacy = {
  level: "mask-sensitive",
  maskSelectors: [".gc-mask"],
  maskNetworkBodies: true,
  maskNetworkQueryParams: true,
  maskLogs: true,
  maskErrors: true,
  shouldMaskNetworkBodies: true,
  shouldMaskNetworkQueryParams: true,
  shouldMaskLogs: true,
  shouldMaskErrors: true,
  sensitiveKeys: [],
};

describe("shouldMaskElement — ancestor-declared sensitivity", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("masks an input whose ANCESTOR is data-private", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-private", "true");
    const input = document.createElement("input");
    input.type = "text"; // not sensitive on its own
    wrapper.appendChild(input);
    container.appendChild(wrapper);

    expect(shouldMaskElement(input, maskSensitive)).toBe(true);
  });

  it("masks an input whose ANCESTOR matches a maskSelector", () => {
    const wrapper = document.createElement("div");
    wrapper.className = "gc-mask";
    const input = document.createElement("input");
    input.type = "text";
    wrapper.appendChild(input);
    container.appendChild(wrapper);

    expect(shouldMaskElement(input, maskSensitive)).toBe(true);
  });

  it("still captures a non-sensitive input with no sensitive ancestor", () => {
    const wrapper = document.createElement("div"); // benign wrapper
    const input = document.createElement("input");
    input.type = "text";
    input.id = "search";
    wrapper.appendChild(input);
    container.appendChild(wrapper);

    expect(shouldMaskElement(input, maskSensitive)).toBe(false);
  });
});

describe("shouldMaskElement — sensitive-key heuristic is input-gated", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("does NOT mask a STATIC non-input element with a sensitive-looking attribute", () => {
    // Contract: mask-sensitive keeps static text visible. A <div>/<button> that
    // merely has a sensitive-looking id/class must NOT be masked by the regex —
    // only maskSelectors / data-private (explicit) or mask-all should.
    const div = document.createElement("div");
    div.id = "api_key";
    container.appendChild(div);
    expect(shouldMaskElement(div, maskSensitive)).toBe(false);

    const button = document.createElement("button");
    button.className = "auth-toggle";
    container.appendChild(button);
    expect(shouldMaskElement(button, maskSensitive)).toBe(false);
  });

  it("STILL masks a form control with a sensitive-looking attribute", () => {
    const input = document.createElement("input");
    input.setAttribute("name", "api_key");
    container.appendChild(input);
    expect(shouldMaskElement(input, maskSensitive)).toBe(true);
  });

  it("still masks a static element via the explicit signals (data-private / maskSelectors)", () => {
    const priv = document.createElement("div");
    priv.setAttribute("data-private", "");
    container.appendChild(priv);
    expect(shouldMaskElement(priv, maskSensitive)).toBe(true);

    const sel = document.createElement("div");
    sel.className = "gc-mask";
    container.appendChild(sel);
    expect(shouldMaskElement(sel, maskSensitive)).toBe(true);
  });

  it("still masks any static element under mask-all", () => {
    const div = document.createElement("div");
    div.textContent = "plain";
    container.appendChild(div);
    expect(shouldMaskElement(div, { ...maskSensitive, level: "mask-all" })).toBe(true);
  });
});
