import { describe, it, expect } from "vitest";
import { exceptionDedup } from "./exception-dedup";
import type { ErrorEventAttributes } from "../types";

const frame = (filename: string, lineno: number) => ({ filename, function: "load", lineno, colno: 7 });

const exception = (overrides: Partial<ErrorEventAttributes> = {}): ErrorEventAttributes => ({
  error_type: "Error",
  error_message: "Unable to decode file",
  error_fingerprint: "Error:Unable to decode file",
  error_handled: false,
  error_stacktrace: [frame("app.js", 10), frame("main.js", 3)],
  ...overrides,
});

const keyOf = (attributes: ErrorEventAttributes) => exceptionDedup(attributes).key;
const same = (a: ErrorEventAttributes, b: ErrorEventAttributes) => expect(keyOf(a)).toBe(keyOf(b));
const different = (a: ErrorEventAttributes, b: ErrorEventAttributes) => expect(keyOf(a)).not.toBe(keyOf(b));

describe("exceptionDedup", () => {
  it("is the same for the same error thrown through the same code path, counted in error_repeat_count", () => {
    same(exception(), exception());
    expect(exceptionDedup(exception())).toEqual({ key: expect.any(Number), countAttribute: "error_repeat_count" });
  });

  it("ignores metadata, captured values included, so a changing detail still matches", () => {
    same(exception({ error_metadata: { attempt: 1 } }), exception({ error_metadata: { attempt: 2 } }));
    same(
      exception({ error_metadata: { captured_value: '{"requestId":"a"}' } }),
      exception({ error_metadata: { captured_value: '{"requestId":"b"}' } })
    );
  });

  it("matches two errors with no stack", () => {
    same(exception({ error_stacktrace: [] }), exception({ error_stacktrace: [] }));
  });

  it("separates a different fingerprint, type or handled flag", () => {
    different(exception(), exception({ error_message: "x", error_fingerprint: "Error:x" }));
    different(exception(), exception({ error_type: "TypeError" }));
    different(exception(), exception({ error_handled: true }));
  });

  it("separates a different code path anywhere in the stack, such as a shared helper's two callers", () => {
    different(exception(), exception({ error_stacktrace: [frame("app.js", 99), frame("main.js", 3)] }));
    different(exception(), exception({ error_stacktrace: [frame("app.js", 10), frame("cart.js", 8)] }));
    different(exception(), exception({ error_stacktrace: [frame("app.js", 10)] }));
  });
});
