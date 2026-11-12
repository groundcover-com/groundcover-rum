import { describe, it, expect } from "vitest";
import { resolvePrivacy } from "./config";
import { redactMetadata } from "./redaction";

describe("redactMetadata", () => {
  it("key-redacts metadata while masking", () => {
    expect(redactMetadata({ password: "x", step: 2 }, resolvePrivacy(undefined))).toEqual({
      password: "[REDACTED]",
      step: 2,
    });
  });

  it("applies the user's sensitive keys and opaque-node predicate", () => {
    const privacy = { ...resolvePrivacy({ privacy: { sensitiveKeys: ["tenant"] } }), isOpaqueNode: (v: unknown) => v === OPAQUE };
    const OPAQUE = { secret: true };
    const out = redactMetadata({ tenant: "acme", node: OPAQUE }, privacy);
    expect(out?.tenant).toBe("[REDACTED]");
    expect(out?.node).not.toBe(OPAQUE);
  });

  it("returns metadata untouched under allow, and passes undefined through", () => {
    const metadata = { password: "x" };
    expect(redactMetadata(metadata, resolvePrivacy({ privacy: { level: "allow" } }))).toBe(metadata);
    expect(redactMetadata(undefined, resolvePrivacy(undefined))).toBeUndefined();
  });
});
