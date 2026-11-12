import type { TouchStartRecord } from "../internal/touch-bridge";
import type { NativeGesturePayload } from "../platform/native-types";
import type { FiberWalkResult } from "../react/fiber-walk";

// Matches a native gesture back to the touch JavaScript saw start.
//
// This is what the hybrid buys. Native measures the gesture
// properly — it sees a scroll through to its end where the JS stream was
// cancelled — but it hit-tests to an anonymous RCTView and can only name the
// target with whatever accessibility strings happen to be set. JavaScript
// already walked the fiber tree at touch-down and knows the component path.
// Correlating the two gives native's numbers with JavaScript's labels, which
// neither side produces alone.

/**
 * How far apart the two sides' notion of "when the finger landed" may be.
 * Both report touch-DOWN time, so the gap is bridge and clock jitter rather
 * than gesture duration — a slow press-then-drag stays matched.
 */
export const CORRELATION_WINDOW_MS = 150;

/** Fingers are wide and the two sides round differently; this is a few
 *  millimetres, not a tolerance for "somewhere else on screen". */
export const CORRELATION_DISTANCE_DP = 24;

/**
 * @returns the fiber walk JS resolved at touch-down, or null when nothing matches — a touch on a
 *   surface JS never saw. The caller still reports the gesture; it goes out unlabelled rather
 *   than mislabelled. The whole walk comes back rather than display strings, so the caller can
 *   apply the same masking a tap gets, including the `dataPrivate` opt-out in `masked`.
 */
export function correlateGesture(
  gesture: Pick<NativeGesturePayload, "startedAtMs" | "startX" | "startY">,
  history: ReadonlyArray<TouchStartRecord>
): FiberWalkResult | null {
  let best: { record: TouchStartRecord; timeDelta: number } | null = null;

  for (const record of history) {
    const timeDelta = Math.abs(record.startedAtMs - gesture.startedAtMs);
    if (timeDelta > CORRELATION_WINDOW_MS) continue;

    const distance = Math.hypot(record.x - gesture.startX, record.y - gesture.startY);
    if (distance > CORRELATION_DISTANCE_DP) continue;

    // Several touches can fall inside the window during fast scrolling; the
    // closest in TIME is the one this gesture grew out of.
    if (!best || timeDelta < best.timeDelta) {
      best = { record, timeDelta };
    }
  }

  if (!best) return null;
  return best.record.target;
}
