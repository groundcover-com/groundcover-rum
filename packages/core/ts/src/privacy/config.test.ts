import { describe, it, expect } from "vitest";
import { resolvePrivacy } from "./config";

// Platform-specific masking options are not part of core's privacy resolution;
// each platform resolves (and tests) its own on top of this.

describe("resolvePrivacy", () => {
  describe("level resolution", () => {
    it("defaults to mask-sensitive when nothing is set", () => {
      expect(resolvePrivacy(undefined).level).toBe("mask-sensitive");
      expect(resolvePrivacy({}).level).toBe("mask-sensitive");
    });

    it("respects an explicit privacy.level", () => {
      expect(resolvePrivacy({ privacy: { level: "mask-all" } }).level).toBe("mask-all");
      expect(resolvePrivacy({ privacy: { level: "allow" } }).level).toBe("allow");
    });
  });

  describe("per-stream toggles", () => {
    it("default on unless allow", () => {
      const p = resolvePrivacy({});
      expect(p.maskNetworkBodies).toBe(true);
      expect(p.maskNetworkQueryParams).toBe(true);
      expect(p.maskLogs).toBe(true);
      expect(p.maskErrors).toBe(true);

      const allow = resolvePrivacy({ privacy: { level: "allow" } });
      expect(allow.maskNetworkBodies).toBe(false);
      expect(allow.maskLogs).toBe(false);
    });

    it("can be individually overridden", () => {
      const p = resolvePrivacy({ privacy: { maskNetworkBodies: false } });
      expect(p.maskNetworkBodies).toBe(false);
      expect(p.maskNetworkQueryParams).toBe(true);
    });
  });

  describe("key pass-through", () => {
    // Platform-specific masking keys are not part of core's EffectivePrivacy —
    // a platform layers its own privacy extension (and its tests) on top.
    it("carries sensitiveKeys", () => {
      const p = resolvePrivacy({
        privacy: { sensitiveKeys: ["internal"] },
      });
      expect(p.sensitiveKeys).toEqual(["internal"]);
    });
  });

  describe("defensive normalization (untyped JS callers)", () => {
    it("ignores an invalid level and falls back to default", () => {
      // @ts-expect-error — JS caller passing a bogus level
      expect(resolvePrivacy({ privacy: { level: "bogus" } }).level).toBe(
        "mask-sensitive"
      );
    });

    // Platform-specific list normalization lives in the platform package
    // (which reuses the exported normalizeStringList for its own extension).
    it("filters non-string / blank entries out of the sensitiveKeys list", () => {
      const p = resolvePrivacy({
        privacy: {
          // @ts-expect-error — JS caller passing mixed-type arrays
          sensitiveKeys: ["keep", undefined, ""],
        },
      });
      expect(p.sensitiveKeys).toEqual(["keep"]);
    });

    it("ignores a non-function redact", () => {
      // @ts-expect-error — JS caller passing a non-function
      expect(resolvePrivacy({ privacy: { redact: "nope" } }).redact).toBeUndefined();
    });
  });
});
