import { describe, it, expect } from "vitest";
import { isReactFiber } from "./opaque-node";

const fiberLike = () => ({
  tag: 5,
  return: null,
  alternate: null,
  stateNode: {},
  memoizedProps: {},
});

describe("isReactFiber", () => {
  it("matches the fiber shape", () => {
    expect(isReactFiber(fiberLike())).toBe(true);
  });

  it("does NOT match ordinary user data that shares a few fiber keys", () => {
    expect(isReactFiber({ type: "refund", return: 12 })).toBe(false);
    expect(isReactFiber({ tag: 1, return: true, stateNode: "x" })).toBe(false);
  });

  it("returns false (does not throw) for a hostile Proxy", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
      }
    );
    expect(isReactFiber(hostile)).toBe(false);
  });

  it("returns false for null / primitives", () => {
    expect(isReactFiber(null)).toBe(false);
    expect(isReactFiber(undefined)).toBe(false);
    expect(isReactFiber(5)).toBe(false);
  });
});
