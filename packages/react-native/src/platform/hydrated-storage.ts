import { handleError, SafeStorage, type PlatformStorage } from "@groundcover/rum-core";
import { loadAsyncStorage } from "./optional-modules";
import { safeWarn } from "../internal/safe-warn";

// Core's storage contract is SYNCHRONOUS, but the only Expo-Go-compatible backend
// (AsyncStorage) is async. HydratedStorage bridges the two: hydrate() seeds a
// synchronous write-through Map from AsyncStorage BEFORE the composition root is
// built (index.ts awaits it), then reads serve from the Map and writes mirror
// back to AsyncStorage fire-and-forget. No read-before-hydrate window exists by
// construction.
const KEY_PREFIX = "@groundcover:";
const HYDRATION_TIMEOUT_MS = 3000;

// The batch read differs by AsyncStorage major: 1.x/2.x have `multiGet`, 3.x
// replaced it with `getMany`. A backend needs one of the two; hydrate() uses
// whichever it finds.
export interface AsyncStorageLike {
  getAllKeys(): Promise<readonly string[]>;
  // `readonly` matches @react-native-async-storage's own `Promise<readonly
  // KeyValuePair[]>` return — the SDK only reads the result, so a mutable slot
  // would (wrongly) reject the real AsyncStorage under strict tsc.
  multiGet?(keys: string[]): Promise<ReadonlyArray<[string, string | null]>>;
  getMany?(keys: string[]): Promise<Readonly<Record<string, string | null>>>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// What init({ storage }) accepts: the AsyncStorage instance, or its module
// namespace (`{ default: AsyncStorage }`) — so both `import AsyncStorage from …`
// and `import * as AsyncStorage from …` work.
export type InjectedAsyncStorage = AsyncStorageLike | { default?: AsyncStorageLike };

// Serializes backend mirror writes in global call order PER BACKEND — keyed on
// the AsyncStorage instance, NOT on a single HydratedStorage. A fast-refresh /
// re-init builds a NEW HydratedStorage over the SAME AsyncStorage while the old
// instance's writes may still be pending; a per-instance chain would let those
// stale writes land AFTER the fresh instance's writes and resurrect an old
// session id on disk. Sharing the chain by backend guarantees every write to one
// backend lands in the order it was issued, across instances. WeakMap so a
// discarded backend (and its settled chain) is collectable.
const backendWriteChains = new WeakMap<AsyncStorageLike, Promise<unknown>>();

export class HydratedStorage implements PlatformStorage {
  private readonly cache = new Map<string, string>();

  constructor(private readonly backend: AsyncStorageLike | null) {}

  getItem(key: string): string | null {
    return this.cache.has(key) ? (this.cache.get(key) as string) : null;
  }

  // Mirror writes must land in CALL order: a setItem followed by a removeItem
  // that resolved out of order could resurrect deleted state on the next launch.
  // Chain them on the shared per-backend chain (cache updates stay synchronous).
  // Errors are swallowed per-op so one failure doesn't wedge the chain.
  private enqueueWrite(backend: AsyncStorageLike, op: () => Promise<unknown>): void {
    const prev = backendWriteChains.get(backend) ?? Promise.resolve();
    backendWriteChains.set(backend, prev.catch(() => {}).then(op).catch(handleError));
  }

  setItem(key: string, value: string): void {
    this.cache.set(key, value);
    const backend = this.backend;
    if (backend) this.enqueueWrite(backend, () => backend.setItem(KEY_PREFIX + key, value));
  }

  removeItem(key: string): void {
    this.cache.delete(key);
    const backend = this.backend;
    if (backend) this.enqueueWrite(backend, () => backend.removeItem(KEY_PREFIX + key));
  }

  private seed(entries: ReadonlyArray<[string, string | null]>): void {
    for (const [prefixedKey, value] of entries) {
      if (value !== null && prefixedKey.startsWith(KEY_PREFIX)) {
        this.cache.set(prefixedKey.slice(KEY_PREFIX.length), value);
      }
    }
  }

  // Builds a SafeStorage over a HydratedStorage whose cache is pre-seeded from
  // AsyncStorage. Degrades to a usable memory-only store (no throw) when the
  // optional peer is absent, hydration fails, or it exceeds the timeout budget.
  //
  // `injected` is the app-provided AsyncStorage from init({ storage }). Prefer it
  // over the auto-require: in a pnpm/monorepo the bundler may not resolve the
  // SDK's own optional require of the peer, but the APP always can — so passing
  // it explicitly is the reliable path to cross-restart persistence.
  static async hydrate(injected?: InjectedAsyncStorage | null): Promise<SafeStorage> {
    const mod =
      injected ?? loadAsyncStorage<{ default?: AsyncStorageLike } | AsyncStorageLike>();
    const backend = (mod && "default" in mod ? mod.default : mod) as AsyncStorageLike | null;

    if (!backend) {
      // groundcoverIgnore: keep the SDK's own warning out of console capture. safeWarn so a
      // patched/throwing console can't break storage setup during init.
      safeWarn(
        "[groundcover] AsyncStorage not found; session state is memory-only (groundcoverIgnore)"
      );
      return new SafeStorage(new HydratedStorage(null));
    }

    const storage = new HydratedStorage(backend);
    // On timeout, withTimeout rejects but the AsyncStorage reads below are NOT
    // cancelled — they keep running and could seed() the cache AFTER hydrate()
    // returned and the session was already bootstrapped memory-only. This flag
    // makes any post-timeout resolution a no-op so the late seed can't overwrite
    // the live (fresh) session state.
    let settled = false;
    try {
      await withTimeout(
        (async () => {
          const keys = await backend.getAllKeys();
          const ours = keys.filter((k) => k.startsWith(KEY_PREFIX));
          if (ours.length === 0) return;
          const entries = await readEntries(backend, ours);
          if (!settled) storage.seed(entries);
        })(),
        HYDRATION_TIMEOUT_MS
      );
    } catch (error) {
      // Timed out or read failed: proceed memory-only (worst case: a fresh
      // session this launch). Telemetry is unaffected.
      handleError(error);
    } finally {
      settled = true;
    }
    return new SafeStorage(storage);
  }
}

// Reads `keys` as [key, value] pairs through whichever batch read the backend has.
async function readEntries(
  backend: AsyncStorageLike,
  keys: string[]
): Promise<ReadonlyArray<[string, string | null]>> {
  if (typeof backend.multiGet === "function") return backend.multiGet(keys);
  if (typeof backend.getMany === "function") {
    const values = await backend.getMany(keys);
    return keys.map((key) => [key, values[key] ?? null]);
  }
  throw new Error("AsyncStorage backend has neither multiGet nor getMany");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hydration timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
