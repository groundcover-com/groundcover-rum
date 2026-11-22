// Guarded loaders for OPTIONAL peer modules. Metro resolves require() STATICALLY, so each peer
// needs its own LITERAL string: a generic `optionalRequire(name)` leaves the module out of the
// bundle and fails at runtime with `Unknown named module`, silently dropping the SDK to
// memory-only storage. A literal require in a try/catch is exactly the shape Metro's
// `allowOptionalDependencies` treats as optional, resolving a missing peer to null.
//
// The build has to preserve that shape, and tsup doesn't on its own: every string-literal
// `require(…)` in this file is made external and kept literal by scripts/optional-requires.mjs
// (wired in tsup.config.ts). A new optional peer only needs its loader here, with the require
// directly in the try block. The build fails if a require comes out any other way, or if a
// require() anywhere else in the SDK would ship through esbuild's shim.

export function loadAsyncStorage<T = unknown>(): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@react-native-async-storage/async-storage") as T;
  } catch {
    return null;
  }
}

export function loadExpoConstants<T = unknown>(): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-constants") as T;
  } catch {
    return null;
  }
}

// RN's bundled Promise polyfill exposes a rejection tracker used to catch
// unhandled promise rejections on JavaScriptCore (on Hermes we use the native
// HermesInternal tracker instead). It ships with react-native's `promise`
// dependency; guarded literal require so a bundle without it degrades to no
// rejection capture rather than failing.
export function loadRejectionTracking<T = unknown>(): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("promise/setimmediate/rejection-tracking") as T;
  } catch {
    return null;
  }
}
