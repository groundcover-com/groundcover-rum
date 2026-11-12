// Controllable in-memory stand-in for @react-native-async-storage/async-storage.
// vitest aliases the module here. Exposes latency/failure injection and a call
// log so hydration + write-through can be tested deterministically.
type Store = Map<string, string>;

const store: Store = new Map();
let latencyMs = 0;
let failNext = false;

const delay = (): Promise<void> =>
  latencyMs > 0
    ? new Promise((resolve) => setTimeout(resolve, latencyMs))
    : Promise.resolve();

const maybeFail = (): void => {
  if (failNext) {
    failNext = false;
    throw new Error("async-storage stub: injected failure");
  }
};

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    await delay();
    maybeFail();
    return store.has(key) ? (store.get(key) as string) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await delay();
    maybeFail();
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    await delay();
    maybeFail();
    store.delete(key);
  },
  async getAllKeys(): Promise<string[]> {
    await delay();
    maybeFail();
    return [...store.keys()];
  },
  async multiGet(keys: string[]): Promise<Array<[string, string | null]>> {
    await delay();
    maybeFail();
    return keys.map((k) => [k, store.has(k) ? (store.get(k) as string) : null]);
  },
};

export default AsyncStorage;

// ── Test-only control surface ──
export function __seed(entries: Record<string, string>): void {
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
}
export function __dump(): Record<string, string> {
  return Object.fromEntries(store.entries());
}
export function __setLatency(ms: number): void {
  latencyMs = ms;
}
export function __failNext(): void {
  failNext = true;
}
export function __reset(): void {
  store.clear();
  latencyMs = 0;
  failNext = false;
}
