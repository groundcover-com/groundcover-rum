import { describe, it, expect } from "vitest";
import { resolveReplayMasking } from "./replay-masking";
// maskSelectors is a BROWSER privacy field (core's PrivacyOptions is lean),
// so fixtures passing it through core-typed options are typed here.
import type { PrivacyOptions } from "@/config/types";

// The rrweb-specific masking fields live outside core's EffectivePrivacy
// (replay is browser-only; core privacy stays platform-agnostic).

describe("resolveReplayMasking", () => {
  describe("maskAllInputs", () => {
    it("is true unless allow", () => {
      expect(resolveReplayMasking({}).maskAllInputs).toBe(true);
      expect(resolveReplayMasking({ privacy: { level: "mask-all" } }).maskAllInputs).toBe(true);
      expect(resolveReplayMasking({ privacy: { level: "allow" } }).maskAllInputs).toBe(false);
    });
  });

  describe("maskTextSelector", () => {
    it("is '*' (+ maskSelectors) for mask-all", () => {
      expect(resolveReplayMasking({ privacy: { level: "mask-all" } }).maskTextSelector).toBe("*");
      expect(
        resolveReplayMasking({ privacy: { level: "mask-all", maskSelectors: [".x"] } as PrivacyOptions })
          .maskTextSelector
      ).toBe("*, .x");
    });

    it("is [data-private] + maskSelectors for mask-sensitive", () => {
      expect(resolveReplayMasking({}).maskTextSelector).toBe("[data-private]");
      expect(
        resolveReplayMasking({ privacy: { maskSelectors: [".secret", ".pii"] } as PrivacyOptions })
          .maskTextSelector
      ).toBe("[data-private], .secret, .pii");
    });

    it("includes [data-private] so replay masks data-private text/subtrees (e.g. contenteditable)", () => {
      // Without this, the DOM-event stream masks a data-private element but the
      // replay text stream leaks it. rrweb evaluates maskTextSelector
      // ancestor-aware (closest), matching shouldMaskElement.
      expect(resolveReplayMasking({}).maskTextSelector).toBe("[data-private]");
      expect(
        resolveReplayMasking({ privacy: { maskSelectors: [".secret"] } as PrivacyOptions }).maskTextSelector
      ).toBe("[data-private], .secret");
    });

    it("is undefined for allow", () => {
      expect(resolveReplayMasking({ privacy: { level: "allow" } }).maskTextSelector).toBeUndefined();
    });

    it("selects all text ('*') when replay.maskTextFn is supplied, so rrweb invokes it", () => {
      const fn = (t: string) => t;
      // Default level would otherwise produce undefined → rrweb never calls the fn.
      expect(
        resolveReplayMasking({ privacy: { replay: { maskTextFn: fn } } }).maskTextSelector
      ).toBe("*");
      expect(resolveReplayMasking({ privacy: { replay: { maskTextFn: fn } } }).maskTextFn).toBe(fn);
    });

    it("does not force '*' for replay.maskTextFn under allow", () => {
      expect(
        resolveReplayMasking({ privacy: { level: "allow", replay: { maskTextFn: (t: string) => t } } })
          .maskTextSelector
      ).toBeUndefined();
    });
  });

  describe("defensive normalization (untyped JS callers)", () => {
    it("ignores non-function replay.maskTextFn / maskInputFn (would crash rrweb)", () => {
      // An untyped JS caller can pass anything — the runtime typeof guards
      // are the validation being pinned here.
      const m = resolveReplayMasking({
        privacy: { replay: { maskTextFn: "nope", maskInputFn: 123 } },
      } as never);
      expect(m.maskTextFn).toBeUndefined();
      expect(m.maskInputFn).toBeUndefined();
    });
  });
});
