import { describe, it, expect } from "vitest";
import { resolvePrivacy } from "../../privacy/config";
import { parseErrorStack, shapeErrorEvent } from "./shape-error";
import { coerceToError } from "./coerce-error";

describe("parseErrorStack", () => {
  it("maps V8 frames", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at doThing (https://app.example.com/main.js:10:5)\n    at https://app.example.com/main.js:20:1";
    expect(parseErrorStack(error)).toEqual([
      { filename: "https://app.example.com/main.js", function: "doThing", lineno: 10, colno: 5 },
      { filename: "https://app.example.com/main.js", function: "anonymous", lineno: 20, colno: 1 },
    ]);
  });

  it("maps JSC frames", () => {
    const error = new Error("x");
    error.stack = "bar@/app/thing.js:7:8";
    expect(parseErrorStack(error)[0]).toEqual({ filename: "/app/thing.js", function: "bar", lineno: 7, colno: 8 });
  });

  it("reads a V8 bare frame whose path contains @ (scoped package) as a path, not a JSC frame", () => {
    const error = new Error("x");
    error.stack = "Error: x\n    at /app/node_modules/@react-navigation/core/index.js:2:3";
    expect(parseErrorStack(error)[0]).toEqual({
      filename: "/app/node_modules/@react-navigation/core/index.js",
      function: "anonymous",
      lineno: 2,
      colno: 3,
    });
  });

  it("yields [] for a missing stack", () => {
    const error = new Error("boom");
    error.stack = undefined;
    expect(parseErrorStack(error)).toEqual([]);
  });
});

describe("shapeErrorEvent", () => {
  it("shapes an exception with its fingerprint", () => {
    const error = new TypeError("bad input");
    const input = shapeErrorEvent(error, { handled: true, metadata: { stage: "test" } }, resolvePrivacy(undefined));
    expect(input.type).toBe("exception");
    expect(input.attributes).toMatchObject({
      error_type: "TypeError",
      error_message: "bad input",
      error_fingerprint: "TypeError:bad input",
      error_handled: true,
      error_metadata: { stage: "test" },
    });
    expect(Array.isArray(input.attributes?.error_stacktrace)).toBe(true);
  });

  it("defaults handled to false and an empty message to 'Unknown error'", () => {
    const input = shapeErrorEvent(new Error(""), undefined, resolvePrivacy(undefined));
    expect(input.attributes?.error_handled).toBe(false);
    expect(input.attributes?.error_message).toBe("Unknown error");
  });

  it("redacts the message and metadata while masking errors, and fingerprints the redacted message", () => {
    const privacy = resolvePrivacy({ privacy: { sensitiveKeys: ["tenant"] } });
    const input = shapeErrorEvent(new Error("login failed password=hunter2"), { metadata: { tenant: "acme" } }, privacy);
    expect(input.attributes?.error_message).toBe("login failed password=[REDACTED]");
    expect(input.attributes?.error_fingerprint).toBe("Error:login failed password=[REDACTED]");
    expect(input.attributes?.error_metadata).toEqual({ tenant: "[REDACTED]" });
  });

  it("leaves everything as-is under allow", () => {
    const input = shapeErrorEvent(
      new Error("login failed password=hunter2"),
      { metadata: { tenant: "acme" } },
      resolvePrivacy({ privacy: { level: "allow", sensitiveKeys: ["tenant"] } })
    );
    expect(input.attributes?.error_message).toBe("login failed password=hunter2");
    expect(input.attributes?.error_metadata).toEqual({ tenant: "acme" });
  });

  it("caps error_message at 10,000 characters and keeps the fingerprint", () => {
    const input = shapeErrorEvent(new Error("x".repeat(20_000)), undefined, resolvePrivacy(undefined));

    expect(input.attributes?.error_message).toHaveLength(10_000);
    expect(input.attributes?.error_fingerprint).toBe(`Error:${"x".repeat(400)}`);
  });

  describe("a value captured as an exception", () => {
    const allow = resolvePrivacy({ privacy: { level: "allow" } });

    it("sends the value as error_metadata.captured_value, beside the app's metadata", () => {
      const input = shapeErrorEvent(coerceToError({ code: 402 }), { metadata: { stage: "checkout" } }, allow);

      expect(input.attributes?.error_message).toBe("Object captured as exception with keys: code");
      expect(input.attributes?.error_metadata).toEqual({ captured_value: '{"code":402}', stage: "checkout" });
    });

    it("redacts the value field by field while masking errors", () => {
      const value = { credit_card: { number: "4111111111111111", exp: "12/29" }, tokens: ["t1", "t2"], code: 402 };
      const input = shapeErrorEvent(coerceToError(value), undefined, resolvePrivacy(undefined));

      expect(input.attributes?.error_metadata).toEqual({
        captured_value: '{"credit_card":"[REDACTED]","tokens":"[REDACTED]","code":402}',
      });
      expect(JSON.stringify(input.attributes)).not.toContain("4111");
    });

    it("marks a cycle instead of failing", () => {
      const value: Record<string, unknown> = { code: 1 };
      value.self = value;
      const input = shapeErrorEvent(coerceToError(value), undefined, allow);

      expect(input.attributes?.error_metadata).toEqual({ captured_value: '{"code":1,"self":"[Circular]"}' });
    });

    it("describes binary data instead of serializing its bytes", () => {
      const input = shapeErrorEvent(coerceToError({ bytes: new Uint8Array(100_000) }), undefined, allow);

      expect(input.attributes?.error_metadata).toEqual({ captured_value: '{"bytes":"[Uint8Array(100000)]"}' });
    });

    it("bounds a large value", () => {
      const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: i, name: "x".repeat(50) }));
      const input = shapeErrorEvent(coerceToError({ rows }), undefined, allow);
      const captured = (input.attributes?.error_metadata as Record<string, string>).captured_value ?? "";

      expect(captured.length).toBeLessThanOrEqual(10_000);
      expect(captured).toContain("more");
    });

    it("sends no captured_value for an Error or a primitive", () => {
      expect(shapeErrorEvent(new Error("x"), undefined, allow).attributes?.error_metadata).toBeUndefined();
      expect(shapeErrorEvent(coerceToError("x"), undefined, allow).attributes?.error_metadata).toBeUndefined();
    });
  });
});
