// `console.warn`, but contained — and once per message where the caller asks for it.
//
// Mirrors core's `safeWarn` (packages/core/ts/src/common/safe-warn.ts) rather than importing it:
// core does not export that one from its package index, and it appends the `(groundcoverIgnore)`
// marker itself, while the RN call sites carry the marker in their own messages.
//
// The reason it exists: `console` is patched by other monitoring libraries — and by this SDK's own
// log listener — so a throwing sink is a real shape, not a hypothetical. A warning must never be
// able to take the host app down, least of all one emitted during `init()` before the
// composition root's own try/catch is in scope.

/** Messages already emitted by {@link warnOnce}. */
const warned = new Set<string>();

export function safeWarn(message: string): void {
  try {
    console.warn(message);
  } catch {
    // Swallowing is intentional — a warning must never break the SDK.
  }
}

/**
 * As {@link safeWarn}, but at most once per distinct message for the life of the process.
 *
 * For conditions discovered on a hot path: `flushFrameSegment` runs on every screen change, so a
 * per-call warning would bury the app's own logs — which is the surest way to have it ignored.
 */
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  safeWarn(message);
}
