import { handleError } from "@groundcover/rum-core";

import type { FiberWalkResult } from "../react/fiber-walk";

// The seam between the customer-rendered <GroundcoverProvider> and the SDK
// singleton. The provider imports only this module (not index.ts), so there is
// no import cycle and the provider is inert until the SDK wires handlers here.

// A finished text-field edit, captured by the internal TextInput patch (see
// react/text-input-instrumentation.ts). Unlike an interaction this never flows
// through the customer-rendered provider — the SDK patches TextInput itself at
// instrument time — so it carries only the field's fiber (walked by the listener
// for a label/component path). The typed value is deliberately absent.
export type RawInput = {
  /** The edited field's fiber (or null) — resolved from the blur/submit event. */
  fiber: unknown;
};

/**
 * A classified interaction: a tap, or a gesture, and how the finger moved.
 *
 * ONE shape for every source. A tap is this with `kind: "tap"`, not a type of its own — a
 * separate tap payload would mean near-identical pipelines whose event builders drift apart
 * field by field.
 */
export type RawGesture = {
  kind: "tap" | "long_press" | "swipe" | "scroll" | "pinch";
  /** The point that identifies the element: a tap's LIFT point, a gesture's START point. */
  x: number;
  y: number;
  /**
   * The target, walked ONCE — at touch-down by the provider, or recovered from the correlation
   * buffer for a native gesture. The whole walk rather than a raw fiber, so the listener never
   * re-walks and nothing pins a React subtree against GC while the event is built.
   */
  target: FiberWalkResult;
  /** Which side measured it. Native sees a scroll through to its end where the
   *  JS stream was cancelled, so its kinematics are the trustworthy ones. */
  captureSource: "js" | "native";
  /** Touch-DOWN time. The native gesture trackers report the same instant, so
   *  this is what correlates a native gesture back to the element JS saw. */
  startedAtMs: number;
  // How the finger moved. A tap leaves these at the classifier's defaults; the event builder
  // omits the whole gesture block for a tap, so they are never read for one.
  direction?: "up" | "down" | "left" | "right";
  distanceDp: number;
  durationMs: number;
  velocityDpS: number;
  pointerCount: number;
  partial: boolean;
};

/**
 * A touch start with its target ALREADY resolved off the fiber. Eager on purpose: a native
 * gesture arrives after the gesture ends, seconds later for a long scroll, by which time the
 * fiber may belong to an unmounted tree — and holding fibers would pin whole subtrees against GC.
 *
 * The whole walk is kept rather than a collapsed string, because it carries `masked`, the
 * per-element `dataPrivate` opt-out. Collapsing would drop that bit, leaving the native gesture
 * path unable to honour a privacy decision it can no longer see.
 */
export type TouchStartRecord = {
  startedAtMs: number;
  x: number;
  y: number;
  target: FiberWalkResult;
};

// Small ring: only the most recent touches can plausibly match a gesture the
// native side just finished reporting.
const TOUCH_HISTORY_SIZE = 5;
const touchHistory: TouchStartRecord[] = [];

type PresenceHandler = (nowMs: number) => void;
type InteractionHandler = (interaction: RawGesture) => void;

let presenceHandler: PresenceHandler | null = null;
let interactionHandler: InteractionHandler | null = null;

export function setTouchHandlers(handlers: {
  onPresence: PresenceHandler | null;
  onInteraction?: InteractionHandler | null;
}): void {
  presenceHandler = handlers.onPresence;
  interactionHandler = handlers.onInteraction ?? null;
}

export function recordTouchStart(record: TouchStartRecord): void {
  touchHistory.push(record);
  if (touchHistory.length > TOUCH_HISTORY_SIZE) touchHistory.shift();
}

export function getTouchHistory(): ReadonlyArray<TouchStartRecord> {
  return touchHistory;
}

export function clearTouchHistory(): void {
  touchHistory.length = 0;
}

/**
 * Hand a signal to its wired handler without letting a failure reach the host.
 *
 * Contained, but NOT silent. The listener guards its own event building, so what escapes to
 * here is the layer beneath it — a session-lifecycle or reconciliation failure on a real touch —
 * and a bare `catch {}` would make exactly those invisible. Report it and carry on; the report is
 * itself guarded, because the one thing that must never happen is a throw reaching RN's touch
 * dispatch and breaking the host app's gestures.
 */
function dispatchSafely(dispatch: () => void): void {
  try {
    dispatch();
  } catch (error) {
    try {
      handleError(error);
    } catch {
      // Not even the error reporter is allowed to reach the host.
    }
  }
}

// A classified interaction (tap / long press / swipe / scroll / pinch), fired on
// touch END once the classifier has decided which it was.
export function reportInteraction(interaction: RawGesture): void {
  dispatchSafely(() => interactionHandler?.(interaction));
}

// Raw presence fires on touch START, independently of gesture classification and event filtering.
export function reportPresence(nowMs: number): void {
  dispatchSafely(() => presenceHandler?.(nowMs));
}
