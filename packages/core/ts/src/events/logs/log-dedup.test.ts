import { describe, it, expect } from "vitest";
import { errorLogDedup } from "./log-dedup";

describe("errorLogDedup", () => {
  it("is the same for the same error-level message, counted in log_repeat_count", () => {
    expect(errorLogDedup("Network Error: timeout", "error")).toEqual({
      key: errorLogDedup("Network Error: timeout", "error")!.key,
      countAttribute: "log_repeat_count",
    });
  });

  it("separates a different message", () => {
    expect(errorLogDedup("Network Error: timeout", "error")!.key).not.toBe(
      errorLogDedup("Network Error: 500", "error")!.key
    );
  });

  it.each(["log", "info", "warn", "debug", "trace"])("never merges a %s-level log", (level) => {
    expect(errorLogDedup("Network Error: timeout", level)).toBeUndefined();
  });
});
