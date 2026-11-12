// When the app became usable — the "I" in TTI.
//
// Module-level state, like touch-bridge, for the same reason: the mark can be
// set before the SDK finishes initializing, and it must record WHEN IT WAS
// CALLED. Routing it through the SDK's pre-init call buffer would replay it
// later and record the drain time instead, quietly turning a real measurement
// into a fabricated one.
//
// Set-once: the first screen a user reaches is the one TTI is about. Later
// navigations are not "the app became usable" again.

type MarkSource = "auto" | "manual";

let autoMarkMs: number | null = null;
let manualMarkMs: number | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  subscribers.forEach((subscriber) => {
    try {
      subscriber();
    } catch {
      // A TTI subscriber must never break whatever set the mark.
    }
  });
}

/**
 * The automatic anchor: the first screen landing. A floor rather than a
 * promise — it fires before that screen's own data loads.
 */
export function markAutoInteractive(nowMs: number): void {
  if (autoMarkMs !== null) return;
  autoMarkMs = nowMs;
  notify();
}

/** The app's own declaration that the first screen is genuinely usable. */
export function markManualInteractive(nowMs: number): void {
  if (manualMarkMs !== null) return;
  manualMarkMs = nowMs;
  notify();
}

export function getInteractiveMark(source: MarkSource): number | null {
  return source === "manual" ? manualMarkMs : autoMarkMs;
}

/** @returns an unsubscribe. Fires whenever either mark lands, since the
 *  listener does not know which source its config selected until it reads it. */
export function onInteractiveMark(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function __resetInteractiveMarkForTest(): void {
  autoMarkMs = null;
  manualMarkMs = null;
  subscribers.clear();
}
