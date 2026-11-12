import { describe, it, expect, vi } from "vitest";
import { RNLogger } from "./logger";

describe("RNLogger", () => {
  it("forwards to the sink with (message, level, attributes)", () => {
    const logger = new RNLogger();
    const sink = vi.fn();
    logger.setSink(sink);
    logger.warn("hi", { k: 1 });
    expect(sink).toHaveBeenCalledWith("hi", "warn", { k: 1 });
  });

  it("does not let a throwing sink crash logger.* calls (host safety)", () => {
    const logger = new RNLogger();
    logger.setSink(() => {
      throw new Error("sink boom");
    });
    expect(() => logger.info("x")).not.toThrow();
    expect(() => logger.error("y", { a: 1 })).not.toThrow();
  });
});
