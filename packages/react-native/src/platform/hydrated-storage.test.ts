import { describe, it, expect, beforeEach, vi } from "vitest";

// Production loads AsyncStorage via a literal `require` (Metro's
// optional-dependency pattern), which doesn't honor vitest's module alias — so
// point the loader at the controllable stub here.
vi.mock("./optional-modules", async () => {
  const stub = await import("../test-utils/async-storage-stub");
  return {
    loadAsyncStorage: () => ({ default: stub.default }),
    loadExpoConstants: () => null,
  };
});

import { HydratedStorage } from "./hydrated-storage";
import AsyncStorageStub, {
  __seed,
  __dump,
  __setLatency,
  __failNext,
  __reset,
} from "../test-utils/async-storage-stub";

const KEY = "gcId";
const PREFIXED = "@groundcover:gcId";

describe("HydratedStorage", () => {
  beforeEach(() => {
    __reset();
  });

  it("seeds a synchronous cache from AsyncStorage before returning", async () => {
    // Persisted under the SDK's key prefix from a prior run.
    __seed({ [PREFIXED]: "session-abc" });
    const storage = await HydratedStorage.hydrate();
    // Reads are synchronous and see the seeded value immediately.
    expect(storage.getItem(KEY)).toBe("session-abc");
  });

  it("writes through to AsyncStorage (fire-and-forget) under the prefix", async () => {
    const storage = await HydratedStorage.hydrate();
    storage.setItem(KEY, "session-xyz");
    // Synchronous read hits the cache right away.
    expect(storage.getItem(KEY)).toBe("session-xyz");
    // The async mirror lands shortly after.
    await new Promise((r) => setTimeout(r, 0));
    expect(__dump()[PREFIXED]).toBe("session-xyz");
  });

  it("survives a simulated restart: a value written in one instance hydrates into the next", async () => {
    const first = await HydratedStorage.hydrate();
    first.setItem(KEY, "persisted");
    await new Promise((r) => setTimeout(r, 0));

    const second = await HydratedStorage.hydrate();
    expect(second.getItem(KEY)).toBe("persisted");
  });

  it("falls back to memory-only (no throw) when hydration times out", async () => {
    __setLatency(10_000); // longer than the 3s hydration budget
    const storage = await HydratedStorage.hydrate();
    // Timed out → empty cache, but usable.
    expect(storage.getItem(KEY)).toBeNull();
    storage.setItem(KEY, "memory");
    expect(storage.getItem(KEY)).toBe("memory");
  });

  it("falls back to memory-only when AsyncStorage read fails", async () => {
    __failNext();
    const storage = await HydratedStorage.hydrate();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("removeItem clears the cache and mirrors the delete", async () => {
    const storage = await HydratedStorage.hydrate();
    storage.setItem(KEY, "v");
    storage.removeItem(KEY);
    expect(storage.getItem(KEY)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(__dump()[PREFIXED]).toBeUndefined();
  });

  it("is resilient to a missing AsyncStorage module (memory-only)", async () => {
    // The composition should never crash if the optional peer is absent.
    const spy = vi.spyOn(AsyncStorageStub, "getAllKeys");
    const storage = await HydratedStorage.hydrate();
    expect(storage.getItem(KEY)).toBeNull();
    spy.mockRestore();
  });

  it("uses an explicitly injected AsyncStorage (init({ storage })) over the auto-required peer", async () => {
    // The auto-require mock would seed nothing here; the injected backend carries
    // the value — proving init({ storage }) takes precedence. This is the path a
    // monorepo app uses when the bundler can't resolve the SDK's own require.
    const injected = {
      getAllKeys: async () => [PREFIXED],
      multiGet: async (keys: string[]) =>
        keys.map((k) => [k, "from-injected"] as [string, string | null]),
      setItem: async () => {},
      removeItem: async () => {},
    };
    const storage = await HydratedStorage.hydrate(injected);
    expect(storage.getItem(KEY)).toBe("from-injected");
  });

  it("hydrates from AsyncStorage 3.x, which has getMany instead of multiGet", async () => {
    // 3.x's default export: getMany returns a { key: value } record, and there is
    // no multiGet. Keys getMany leaves out read as null and aren't seeded.
    const getMany = vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k === PREFIXED).map((k) => [k, "from-v3"]))
    );
    const v3 = {
      getAllKeys: async () => [PREFIXED, "@groundcover:gone", "someone-else"],
      getMany,
      setItem: async () => {},
      removeItem: async () => {},
    };
    const storage = await HydratedStorage.hydrate({ default: v3 });
    expect(getMany).toHaveBeenCalledWith([PREFIXED, "@groundcover:gone"]);
    expect(storage.getItem(KEY)).toBe("from-v3");
    expect(storage.getItem("gone")).toBeNull();
  });

  it("falls back to memory-only when the backend has neither multiGet nor getMany", async () => {
    const setItem = vi.fn(async () => {});
    const unknown = {
      getAllKeys: async () => [PREFIXED],
      setItem,
      removeItem: async () => {},
    };
    const storage = await HydratedStorage.hydrate(unknown);
    expect(storage.getItem(KEY)).toBeNull();
    // Still usable: writes go to the cache and keep mirroring to the backend.
    storage.setItem(KEY, "memory");
    expect(storage.getItem(KEY)).toBe("memory");
    await new Promise((r) => setTimeout(r, 0));
    expect(setItem).toHaveBeenCalledWith(PREFIXED, "memory");
  });

  it("serializes mirrored backend writes so a setItem→removeItem can't resurrect deleted state", async () => {
    const store = new Map<string, string>();
    // Holder object (not a bare `let`): a variable assigned only inside the
    // setItem closure is narrowed by CFA to its `null` initializer at the call
    // site; an object property keeps its declared type.
    const deferredSet: { release: (() => void) | null } = { release: null };
    const backend = {
      getAllKeys: async () => [...store.keys()],
      multiGet: async (keys: string[]) =>
        keys.map((k) => [k, store.get(k) ?? null] as [string, string | null]),
      // Deferred: simulate a slow setItem that lands AFTER a later removeItem.
      setItem: (k: string, v: string) =>
        new Promise<void>((res) => {
          deferredSet.release = () => {
            store.set(k, v);
            res();
          };
        }),
      removeItem: async (k: string) => {
        store.delete(k);
      },
    };
    const storage = await HydratedStorage.hydrate(backend);

    storage.setItem(KEY, "v"); // enqueues the slow setItem
    storage.removeItem(KEY); // enqueued AFTER — must apply after setItem settles
    deferredSet.release?.(); // now let the slow setItem land

    await new Promise((r) => setTimeout(r, 10)); // drain the write chain
    // removeItem ran last → the key stays deleted (not resurrected by the late setItem).
    expect(store.get(PREFIXED)).toBeUndefined();
  });

  it("serializes writes ACROSS instances so a re-init's stale write can't overwrite fresh state", async () => {
    // A fast-refresh re-init builds a NEW HydratedStorage over the SAME backend
    // while the OLD instance's mirror write is still pending. Per-instance chains
    // would let the old, slow write land AFTER the fresh write and resurrect a
    // stale session id on disk.
    const store = new Map<string, string>();
    const applied: string[] = [];
    const deferredFirst: { release: (() => void) | null } = { release: null };
    let firstCall = true;
    const backend = {
      getAllKeys: async () => [...store.keys()],
      multiGet: async (keys: string[]) =>
        keys.map((k) => [k, store.get(k) ?? null] as [string, string | null]),
      setItem: (k: string, v: string) => {
        if (firstCall) {
          firstCall = false;
          // The old instance's write is slow — resolves only when released.
          return new Promise<void>((res) => {
            deferredFirst.release = () => {
              store.set(k, v);
              applied.push(v);
              res();
            };
          });
        }
        // The new instance's write is fast.
        store.set(k, v);
        applied.push(v);
        return Promise.resolve();
      },
      removeItem: async (k: string) => {
        store.delete(k);
      },
    };

    const oldInstance = await HydratedStorage.hydrate(backend);
    oldInstance.setItem(KEY, "old-session"); // enqueues the slow write
    await new Promise((r) => setTimeout(r, 0)); // let the slow op START (pending)

    const newInstance = await HydratedStorage.hydrate(backend);
    newInstance.setItem(KEY, "new-session"); // fresh write over the SAME backend
    await new Promise((r) => setTimeout(r, 0));

    deferredFirst.release?.(); // now let the old, slow write finally land
    await new Promise((r) => setTimeout(r, 10)); // drain

    // Writes to one backend must land in call order regardless of instance —
    // the stale value must NOT be the final persisted state.
    expect(applied).toEqual(["old-session", "new-session"]);
    expect(store.get(PREFIXED)).toBe("new-session");
  });

  it("unwraps an injected module namespace ({ default: AsyncStorage })", async () => {
    const backend = {
      getAllKeys: async () => [PREFIXED],
      multiGet: async (keys: string[]) =>
        keys.map((k) => [k, "via-default"] as [string, string | null]),
      setItem: async () => {},
      removeItem: async () => {},
    };
    const storage = await HydratedStorage.hydrate({ default: backend });
    expect(storage.getItem(KEY)).toBe("via-default");
  });
});
