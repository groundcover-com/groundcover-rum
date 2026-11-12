import * as React from "react";
import { View } from "react-native";
import { reportSafely } from "../internal/report-safely";

import { EMPTY_WALK, resolveFiber, walkFiber, type FiberWalkResult } from "./fiber-walk";
import { classifyGesture, type TouchPoint } from "./gesture-classification";
import { recordTouchStart, reportInteraction, reportPresence } from "../internal/touch-bridge";

export type GroundcoverProviderProps = {
  children?: React.ReactNode;
};

type TouchLike = {
  nativeEvent?: { pageX?: number; pageY?: number; touches?: unknown[] };
};

/** What we know about the touch currently in progress. */
type InFlightTouch = {
  start: TouchPoint;
  last: TouchPoint;
  /** The sample before `last`, so release velocity spans ~2 frames rather than
   *  the sliver between the final move and touch-end. */
  previous: TouchPoint;
  /** Max simultaneous touches seen — two or more makes it a pinch. */
  pointerCount: number;
  /** The target, walked once at touch-down. Holding the walk rather than the fiber is what
   *  lets the listener build the event without walking a second time. */
  target: FiberWalkResult;
};

type TouchHolder = { current: InFlightTouch | null };

// These handlers run on EVERY touch — the SDK's hottest, most exposed path.
// Wrap them fully: the reporters self-guard, but reading a malformed synthetic
// event can throw before any of them is reached, and a throw here would break
// the host app's touch dispatch.

function onTouchStart(event: TouchLike, holder: TouchHolder): void {
  try {
    const now = Date.now();
    const ne = event?.nativeEvent ?? {};
    const pointers = ne.touches?.length ?? 1;

    // A second finger landing mid-gesture fires its OWN touch-start — RN
    // dispatches one per touch. It must NOT restart the gesture: start, previous
    // and the resolved target all belong to the first finger, and a pinch is
    // measured from there. Only raise the pointer count, exactly as onTouchMove
    // does; a lower count on a later finger never lowers it.
    const existing = holder.current;
    if (existing && pointers > 1) {
      if (pointers > existing.pointerCount) existing.pointerCount = pointers;
      reportPresence(now);
      return;
    }

    const point: TouchPoint = { x: ne.pageX ?? 0, y: ne.pageY ?? 0, t: now };
    // Resolve from the SYNTHETIC event, not nativeEvent: under Fabric
    // nativeEvent.target is a numeric tag, while the fiber lives on the
    // synthetic event (_targetInst / target.__internalInstanceHandle).
    //
    // Walk it HERE, exactly once, while the fiber is still mounted: a native gesture referring
    // back to this touch can arrive seconds later, and everything downstream — the correlation
    // record and the interaction event alike — reads this one result.
    const target = describeTarget(resolveFiber(event));

    holder.current = {
      start: point,
      last: point,
      previous: point,
      pointerCount: pointers,
      target,
    };

    recordTouchStart({ startedAtMs: now, x: point.x, y: point.y, target });

    reportPresence(now);
  } catch (error) {
    // A start we could not read leaves no trustworthy gesture: clear it, so a
    // prior gesture's point cannot survive to be reused by a later end (which
    // would classify a fresh touch against stale coordinates, or ship a false
    // tap). A failed start must leave no start at all.
    holder.current = null;
    reportSafely(error);
  }
}

function onTouchMove(event: TouchLike, holder: TouchHolder): void {
  // Deliberately trivial: this fires for every pointer sample, and doing real
  // work here is how gesture tracking becomes the jank it is meant to measure.
  try {
    const inFlight = holder.current;
    if (!inFlight) return;
    const ne = event?.nativeEvent ?? {};
    inFlight.previous = inFlight.last;
    inFlight.last = { x: ne.pageX ?? inFlight.last.x, y: ne.pageY ?? inFlight.last.y, t: Date.now() };
    const pointers = ne.touches?.length ?? 1;
    if (pointers > inFlight.pointerCount) inFlight.pointerCount = pointers;
  } catch (error) {
    reportSafely(error);
  }
}

function finishTouch(event: TouchLike, holder: TouchHolder, cancelled: boolean): void {
  try {
    const inFlight = holder.current;
    holder.current = null;
    if (!inFlight) return;

    const ne = event?.nativeEvent ?? {};
    const end: TouchPoint = {
      x: ne.pageX ?? inFlight.last.x,
      y: ne.pageY ?? inFlight.last.y,
      t: Date.now(),
    };

    const gesture = classifyGesture({
      start: inFlight.start,
      previous: inFlight.previous,
      end,
      pointerCount: inFlight.pointerCount,
      cancelled,
    });
    if (!gesture) return;

    const isTap = gesture.kind === "tap";
    reportInteraction({
      kind: gesture.kind,
      // A tap is identified by where the finger LIFTED; a gesture by where it LANDED, since a
      // scroll ends half a screen away from the element the user actually grabbed.
      x: isTap ? end.x : inFlight.start.x,
      y: isTap ? end.y : inFlight.start.y,
      target: inFlight.target,
      captureSource: "js",
      startedAtMs: inFlight.start.t,
      direction: gesture.direction,
      distanceDp: gesture.distanceDp,
      durationMs: gesture.durationMs,
      velocityDpS: gesture.velocityDpS,
      pointerCount: gesture.pointerCount,
      partial: gesture.partial,
    });
  } catch (error) {
    reportSafely(error);
  }
}

function onTouchEnd(event: TouchLike, holder: TouchHolder): void {
  finishTouch(event, holder, false);
}

/**
 * Android cancels the JS touch stream the moment a ScrollView takes the gesture
 * over. Without this the scroll would be invisible: no end event ever arrives.
 */
function onTouchCancel(event: TouchLike, holder: TouchHolder): void {
  finishTouch(event, holder, true);
}

/**
 * The touch target, resolved while the fiber is still mounted.
 *
 * Returns the WHOLE walk. Collapsing it to `component || label` would throw away
 * `masked` (the per-element `dataPrivate` opt-out) and also put label text into a
 * field the event builder treats as a never-masked component name.
 * The listener owns the masking decision; this function's only job is to read
 * the tree before it goes away.
 */
function describeTarget(fiber: unknown): FiberWalkResult {
  try {
    return walkFiber(fiber);
  } catch {
    // A tap is never lost, only its labels.
    return EMPTY_WALK;
  }
}

// Exposed for unit tests (the handlers are otherwise closed over inside the
// component and need a renderer to reach).
export const __internals = { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };

/**
 * Root touch boundary — wrap the app, typically just inside NavigationContainer. Uses the
 * bubbling responder callbacks, so it observes touches without claiming the responder and never
 * interferes with the app's own gestures.
 *
 * Presence is reported on touch START, before gesture classification; the
 * gesture is classified on touch end, or on cancel when a native scroller takes it over.
 */
export function GroundcoverProvider({ children }: GroundcoverProviderProps): React.ReactElement {
  const touchRef = React.useRef<InFlightTouch | null>(null);

  const handleTouchStart = React.useCallback((event: TouchLike) => onTouchStart(event, touchRef), []);
  const handleTouchMove = React.useCallback((event: TouchLike) => onTouchMove(event, touchRef), []);
  const handleTouchEnd = React.useCallback((event: TouchLike) => onTouchEnd(event, touchRef), []);
  const handleTouchCancel = React.useCallback(
    (event: TouchLike) => onTouchCancel(event, touchRef),
    []
  );

  return React.createElement(
    View,
    {
      style: { flex: 1 },
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchCancel,
    },
    children
  );
}
