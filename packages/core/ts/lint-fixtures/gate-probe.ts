// LINT FIXTURE — not shipped, not compiled into the package.
//
// The platform gate is only worth what it actually catches, and a clean lint
// run over conforming code proves nothing. Every line tagged `// GATE` below
// MUST be reported by packages/core/ts/eslint.config.mjs.
// `pnpm -C packages/core/ts lint:gate` asserts that PER LINE — if any tagged line
// stops being flagged, the check fails and names it.
//
// Add a probe here whenever the gate grows a new responsibility.

// Bare identifiers (no-restricted-globals):
export const a = () => fetch("/x"); // GATE
export const b = () => new FormData(); // GATE
export const c = () => window.location.href; // GATE
export const d = () => new Worker("w"); // GATE
export const e = () => sessionStorage.getItem("k"); // GATE
export const l = () => new TextEncoder().encode("x"); // GATE
export const m = () => new TextDecoder().decode(new Uint8Array()); // GATE

// Member access off globalThis (no-restricted-properties) — `no-restricted-
// globals` does NOT see these, which is the hole this fixture exists to pin.
export const f = () => globalThis.fetch("/x"); // GATE
export const g = () => new globalThis.Blob([]); // GATE
export const h = () => globalThis.localStorage.getItem("k"); // GATE
export const n = () => new globalThis.TextEncoder(); // GATE

// Node's `global` is its own escape hatch: @types/node declares it, so these
// typecheck, and `global` is not itself a restricted identifier.
export const i = () => global.fetch("/x"); // GATE
export const j = () => global.process.env; // GATE
export const k = () => new global.Blob([]); // GATE
