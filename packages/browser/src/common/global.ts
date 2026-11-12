// `globalThis` exists on every runtime the browser SDK targets (ES2020+). The
// alias gives the browser's host-global reads one greppable spelling.
export const _globalThis: typeof globalThis = globalThis;
