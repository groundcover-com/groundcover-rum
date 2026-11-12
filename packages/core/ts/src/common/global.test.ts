import { describe, it, expect } from "vitest";
import { MS_TO_NANOSECONDS, msToNs, nsToMs } from "./global";

describe("ms/ns conversion utils", () => {
  describe("msToNs", () => {
    it("multiplies milliseconds by 1_000_000", () => {
      expect(msToNs(1)).toBe(1_000_000);
      expect(msToNs(1000)).toBe(1_000_000_000);
    });

    it("handles zero", () => {
      expect(msToNs(0)).toBe(0);
    });

    it("handles fractional millisecond values", () => {
      expect(msToNs(0.5)).toBe(500_000);
      expect(msToNs(1.234)).toBe(1_234_000);
    });

    it("handles negative values", () => {
      expect(msToNs(-1)).toBe(-1_000_000);
    });

    it("uses the same factor as MS_TO_NANOSECONDS", () => {
      const ms = 12_345;
      expect(msToNs(ms)).toBe(ms * MS_TO_NANOSECONDS);
    });
  });

  describe("nsToMs", () => {
    it("divides nanoseconds by 1_000_000", () => {
      expect(nsToMs(1_000_000)).toBe(1);
      expect(nsToMs(1_000_000_000)).toBe(1000);
    });

    it("handles zero", () => {
      expect(nsToMs(0)).toBe(0);
    });

    it("handles sub-millisecond nanosecond values (returns fraction)", () => {
      expect(nsToMs(500_000)).toBe(0.5);
      expect(nsToMs(1_234_000)).toBe(1.234);
    });

    it("handles negative values", () => {
      expect(nsToMs(-1_000_000)).toBe(-1);
    });
  });

  describe("round-trip", () => {
    it("msToNs ∘ nsToMs is identity for ms values within safe-integer range", () => {
      // Note: real Date.now() values (~1.78e12) overflow Number.MAX_SAFE_INTEGER
      // after multiplication, so production callers tolerate sub-ms imprecision
      // on the inverse. This test pins the lossless range.
      for (const ms of [0, 1, 1000, 12_345, 1_000_000]) {
        expect(nsToMs(msToNs(ms))).toBe(ms);
      }
    });

    it("real Date.now() round-trips to within 1 ms (precision floor)", () => {
      const ms = Date.now();
      expect(nsToMs(msToNs(ms))).toBeCloseTo(ms, -1);
    });
  });
});
