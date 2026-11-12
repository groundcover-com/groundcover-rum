import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getWebDeviceAttributes, makeWebViewProvider } from "./web-platform";
import { resolvePrivacy } from "@groundcover/rum-core/privacy/config";
import { _globalThis } from "../common/global";
import type { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import type { EffectivePrivacy } from "@groundcover/rum-core/privacy/config";

// UA parsing lives in getWebDeviceAttributes, so the parsing cases are
// asserted against it directly rather than through the batch envelope.
describe("getWebDeviceAttributes", () => {
  const stubNavigator = (value: Record<string, unknown>) => {
    Object.defineProperty(window, "navigator", {
      value,
      configurable: true,
    });
  };

  it("should safely detect Chrome browser", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      language: "en-US",
      platform: "Win32",
    });

    expect(getWebDeviceAttributes()).toEqual({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      browser: {
        name: "Chrome",
        version: "91.0.4472.124",
        platform: "Win32",
        language: "en-US",
        mobile: false,
      },
    });
  });

  it("should safely handle unknown browsers", () => {
    stubNavigator({
      userAgent: "Unknown Browser",
      language: "en-US",
      platform: "Unknown",
    });

    expect(getWebDeviceAttributes()).toEqual({
      userAgent: "Unknown Browser",
      browser: {
        name: "unknown",
        version: "unknown",
        platform: "Unknown",
        language: "en-US",
        mobile: false,
      },
    });
  });
});

// Core's enricher stamps whatever LocationAttributes its injected provider
// returns; ALL the web-specific derivation — hash-route detection and
// query-param redaction — lives in makeWebViewProvider.
describe("makeWebViewProvider", () => {
  // Core-shaped privacy (no browser maskSelectors extension — the provider
  // only reads the core surface via config.getPrivacy()).
  let privacy: EffectivePrivacy;

  const fakeConfig = () =>
    ({
      getPrivacy: () => privacy,
      getConfig: () => null,
    }) as unknown as ConfigManager;

  const stubLocation = (value: unknown) => {
    Object.defineProperty(_globalThis, "location", {
      value,
      configurable: true,
    });
  };

  const stubDocument = (value: unknown) => {
    Object.defineProperty(_globalThis, "document", {
      value,
      configurable: true,
    });
  };

  // happy-dom's real globals, restored after each test so the rest of the
  // suite (and other files sharing the environment) sees the real DOM.
  const realLocation = _globalThis.location;
  const realDocument = _globalThis.document;

  beforeEach(() => {
    // Real resolution over the default options: mask-sensitive, query-param
    // redaction ON.
    privacy = resolvePrivacy({});
  });

  afterEach(() => {
    stubLocation(realLocation);
    stubDocument(realDocument);
  });

  it("passes through a plain path/url/title", () => {
    stubLocation({
      pathname: "/test-path",
      href: "https://test.com/test-path",
      hash: "",
    });
    stubDocument({ title: "Test Page" });

    expect(makeWebViewProvider(fakeConfig())()).toEqual({
      path: "/test-path",
      url: "https://test.com/test-path",
      title: "Test Page",
    });
  });

  it("uses the hash as the path for hash routes, query-redacted (stamped on every event)", () => {
    stubLocation({
      pathname: "/",
      hash: "#/account?token=secret&tab=1",
      href: "https://test.com/#/account?token=secret&tab=1",
    });
    stubDocument({ title: "Account" });

    const view = makeWebViewProvider(fakeConfig())();
    expect(view?.path).toContain("#/account");
    expect(view?.path).not.toContain("secret");
    expect(view?.path).toContain("tab=1");
  });

  it("does NOT treat a plain #fragment anchor as a hash route", () => {
    stubLocation({
      pathname: "/docs",
      hash: "#section-2",
      href: "https://test.com/docs#section-2",
    });
    stubDocument({ title: "Docs" });

    expect(makeWebViewProvider(fakeConfig())()?.path).toBe("/docs");
  });

  it("redacts sensitive query params in url by default (benign params kept)", () => {
    stubLocation({
      pathname: "/p",
      hash: "",
      href: "https://test.com/p?token=secret&page=2",
    });
    stubDocument({ title: "T" });

    const view = makeWebViewProvider(fakeConfig())();
    expect(view?.url).not.toContain("secret");
    expect(view?.url).toContain("page=2");
  });

  it("does not redact url when level is allow (shouldMaskNetworkQueryParams false)", () => {
    privacy = resolvePrivacy({ privacy: { level: "allow" } });
    stubLocation({
      pathname: "/p",
      hash: "",
      href: "https://test.com/p?token=secret",
    });
    stubDocument({ title: "T" });

    expect(makeWebViewProvider(fakeConfig())()?.url).toContain("secret");
  });

  it("falls back to empty path/url (keeping the title) when location is unavailable", () => {
    stubLocation(undefined);
    stubDocument({ title: "Still Titled" });

    expect(makeWebViewProvider(fakeConfig())()).toEqual({
      path: "",
      url: "",
      title: "Still Titled",
    });
  });

  // The provider runs for EVERY event, so a hostile or instrumented page must
  // cost the view, not the instrumentation.
  it("degrades to the empty view when a hostile location getter throws", () => {
    stubDocument({ title: "Hostile Page" });
    Object.defineProperty(_globalThis, "location", {
      get() {
        throw new Error("blocked by page");
      },
      configurable: true,
    });

    expect(() => makeWebViewProvider(fakeConfig())()).not.toThrow();
  });

  // A catch-all that returned a hardcoded empty title would silently discard a
  // title that had already been read successfully — the no-location branch
  // above preserves it, and so must the error path.
  it("keeps the title when the location path throws after the title was read", () => {
    stubDocument({ title: "Still Titled" });
    stubLocation({
      get hash(): string {
        throw new Error("instrumented getter");
      },
      pathname: "/p",
      href: "https://example.com/p",
    });

    expect(makeWebViewProvider(fakeConfig())()).toEqual({
      path: "",
      url: "",
      title: "Still Titled",
    });
  });

  it("survives a throwing document.title getter", () => {
    stubLocation(undefined);
    Object.defineProperty(_globalThis, "document", {
      get() {
        throw new Error("cross-origin document");
      },
      configurable: true,
    });

    expect(makeWebViewProvider(fakeConfig())()).toEqual({
      path: "",
      url: "",
      title: "",
    });
  });
});
