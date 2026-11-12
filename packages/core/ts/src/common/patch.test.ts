import { describe, it, expect } from "vitest";
import { PatchSet, type PatchSpec } from "./patch";

type Fn = () => string;

function slot(initial: Fn) {
  const host = { fn: initial };
  const spec = (tag: string): PatchSpec<Fn> => ({
    get: () => host.fn,
    set: (v) => {
      host.fn = v;
    },
    wrap: (original) => () => `${tag}(${original()})`,
  });
  return { host, spec };
}

describe("PatchSet", () => {
  it("installs a wrapper around the value found at install time and restores it", () => {
    const { host, spec } = slot(() => "native");
    const original = host.fn;
    const patches = new PatchSet();

    expect(patches.install([spec("sdk")])).toBe(true);
    expect(host.fn()).toBe("sdk(native)");

    patches.restore();
    expect(host.fn).toBe(original);
    expect(patches.isEmpty).toBe(true);
  });

  it("leaves a host wrapper layered on top of ours in place", () => {
    const { host, spec } = slot(() => "native");
    const patches = new PatchSet();
    patches.install([spec("sdk")]);

    const ours = host.fn;
    const hostWrapper = () => `host(${ours()})`;
    host.fn = hostWrapper;

    patches.restore();
    expect(host.fn).toBe(hostWrapper);
  });

  it("rolls a group back when one slot rejects the write, and reports not installed", () => {
    const a = slot(() => "a");
    const originalA = a.host.fn;
    const frozen: PatchSpec<Fn> = {
      get: () => () => "b",
      set: () => {
        throw new TypeError("read-only");
      },
      wrap: (original) => original,
    };
    const patches = new PatchSet();

    expect(patches.install([a.spec("sdk"), frozen])).toBe(false);
    expect(a.host.fn).toBe(originalA);
    expect(patches.isEmpty).toBe(true);
  });

  it("rolls back a setter that wrote before throwing", () => {
    const host = { fn: (() => "native") as Fn };
    const original = host.fn;
    const patches = new PatchSet();
    let calls = 0;
    const halfWrite: PatchSpec<Fn> = {
      get: () => host.fn,
      set: (v) => {
        host.fn = v;
        if (calls++ === 0) throw new Error("wrote, then threw");
      },
      wrap: () => () => "sdk",
    };

    expect(patches.install([halfWrite])).toBe(false);
    expect(host.fn).toBe(original);
  });

  it("fails groups independently", () => {
    const a = slot(() => "a");
    const broken: PatchSpec<Fn> = {
      get: () => () => "b",
      set: () => {
        throw new Error("nope");
      },
      wrap: (original) => original,
    };
    const patches = new PatchSet();

    expect(patches.install([broken])).toBe(false);
    expect(patches.install([a.spec("sdk")])).toBe(true);
    expect(a.host.fn()).toBe("sdk(a)");
  });

  it("keeps restoring the other slots when one refuses the restore", () => {
    const a = slot(() => "a");
    const originalA = a.host.fn;
    const host = { fn: (() => "b") as Fn };
    let locked = false;
    const lockable: PatchSpec<Fn> = {
      get: () => host.fn,
      set: (v) => {
        if (locked) throw new Error("locked");
        host.fn = v;
      },
      wrap: () => () => "sdk",
    };
    const patches = new PatchSet();
    patches.install([a.spec("sdk")]);
    patches.install([lockable]);

    locked = true;
    expect(() => patches.restore()).not.toThrow();
    expect(a.host.fn).toBe(originalA);
  });
});
