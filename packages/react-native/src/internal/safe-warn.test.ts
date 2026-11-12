import { afterEach, describe, expect, it, vi } from "vitest";
import { safeWarn, warnOnce } from "./safe-warn";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A warning must never be able to take the host app down. `console` is patched by other monitoring
 * libraries — and by this SDK's own log listener — so a throwing sink is a real shape. This is the
 * primitive the SDK's warnings depend on for that, so the contract is pinned here rather than only
 * through its callers.
 */
describe("safeWarn", () => {
  it("emits the message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    safeWarn("[groundcover] something is off");

    expect(warn).toHaveBeenCalledWith("[groundcover] something is off");
  });

  it("swallows a console that throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("host replaced console.warn");
    });

    expect(() => safeWarn("anything")).not.toThrow();
  });
});

describe("warnOnce", () => {
  it("emits a given message only once, however often it is asked", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Distinct from any other test's message: the budget is per-process by design, so a shared
    // string would make this depend on what ran first.
    const message = "warnOnce: emits once";

    warnOnce(message);
    warnOnce(message);
    warnOnce(message);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("tracks messages separately, so one condition does not silence another", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnOnce("warnOnce: first condition");
    warnOnce("warnOnce: second condition");

    expect(warn).toHaveBeenCalledTimes(2);
  });

  /** Same containment as safeWarn — it delegates, and that must not regress to a bare call. */
  it("swallows a console that throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("host replaced console.warn");
    });

    expect(() => warnOnce("warnOnce: hostile console")).not.toThrow();
  });
});
