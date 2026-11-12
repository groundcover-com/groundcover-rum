// Turns a raw touch into the kind of gesture it was.
//
// Not just taps: scrolls, drags and long-holds are real interactions the user
// performed, and silence about them would make a session timeline look empty
// during the parts where someone was actively reading.
//
// Pure, so the whole decision table is testable without a renderer.

export const TAP_SLOP_DP = 10;
export const TAP_MAX_DURATION_MS = 500;

/** Below this a drag is a wobble, not a swipe worth reporting. */
export const MIN_SWIPE_DISTANCE_DP = 32;

/**
 * A drag released with real momentum is a swipe; one brought to rest is a scroll.
 * The user's intent differs and so does what they expect to happen next.
 *
 * Shared with both native trackers by value — `GCRumGestureClassifier.swift` and
 * `GcRumGestureClassifier.kt` hold the same number. Three runtimes with no shared
 * code means three constants, so they are cross-referenced in all three places
 * and the cross-platform e2e drag is what actually catches them drifting.
 */
export const MIN_SWIPE_VELOCITY_DP_S = 300;

/**
 * The narrowest release window worth dividing by, one frame at 60Hz.
 *
 * React Native coalesces touch moves, so the last two samples of an ordinary drag can be 1ms apart
 * and tens of dp apart — and `releaseDp / releaseMs` then reports tens of thousands of dp/s for a
 * finger that moved at eight hundred. Paired with durations a fraction of the real gesture, such
 * velocities are self-consistent, so they read as a different quantity rather than as noise.
 *
 * Unlike {@link MIN_SWIPE_VELOCITY_DP_S} this is deliberately NOT mirrored in the native
 * classifiers: it compensates for how RN delivers samples to JavaScript, and both platforms use a
 * real `VelocityTracker` that smooths for them. Nothing has drifted if this number appears here
 * alone.
 */
export const MIN_RELEASE_WINDOW_MS = 16;

export type TouchPoint = { x: number; y: number; t: number };

export type GestureDirection = "up" | "down" | "left" | "right";

export type GestureKind = "tap" | "long_press" | "swipe" | "scroll" | "pinch";

export type ClassifiedGesture = {
  kind: GestureKind;
  direction?: GestureDirection;
  distanceDp: number;
  durationMs: number;
  velocityDpS: number;
  pointerCount: number;
  /**
   * True when the touch stream was CANCELLED rather than ended — Android does
   * this the moment a ScrollView takes over the gesture. We saw the start and
   * the direction but never the end, so distance and velocity are lower bounds.
   */
  partial: boolean;
};

export type GestureInput = {
  start: TouchPoint;
  /**
   * The next-to-last sample, for RELEASE velocity. Two back rather than one, because touch-end
   * often lands within a millisecond of the final move and that window is mostly noise; this
   * spans about two frames, roughly what the platform trackers smooth over. Equal to `start` when
   * fewer than two moves arrived, so the whole drag becomes the release window.
   */
  previous: TouchPoint;
  end: TouchPoint;
  /** Max simultaneous touches seen during the gesture. */
  pointerCount: number;
  /** The stream was cancelled mid-gesture (a native scroller took over). */
  cancelled: boolean;
};

/**
 * @returns the gesture, or null when there is nothing worth reporting (a tiny
 *   drag that is neither a tap nor a swipe).
 */
export function classifyGesture(input: GestureInput): ClassifiedGesture | null {
  const { start, previous, end, pointerCount, cancelled } = input;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const durationMs = Math.max(0, end.t - start.t);

  // RAW magnitudes for the threshold comparisons below, rounded ones only for
  // reporting. Both native classifiers compare raw, so rounding first would put a
  // band half a unit either side of every threshold on the wrong side of it on
  // this platform alone — a 31.6dp wobble would become a reportable gesture, a
  // 299.7 dp/s release a swipe. Invisible in aggregate, because either answer is
  // plausible for a real drag.
  const exactDistanceDp = Math.hypot(dx, dy);

  // RELEASE velocity, over the final segment — not the average over the whole
  // drag. A drag that crawls and then flicks is a swipe, and its average hides
  // that; both native trackers report release velocity, so an average here would
  // be a third definition of the same field rather than a shared one.
  //
  // But only when the window is wide enough to divide by. Below a frame this is not a measurement
  // of the finger, it is a measurement of how React Native happened to batch the samples — so it
  // widens to the whole drag, exactly as a gesture with fewer than two moves already does.
  const releaseMs = end.t - previous.t;
  const window =
    releaseMs >= MIN_RELEASE_WINDOW_MS
      ? { ms: releaseMs, dp: Math.hypot(end.x - previous.x, end.y - previous.y) }
      : { ms: durationMs, dp: exactDistanceDp };
  const exactVelocityDpS = window.ms > 0 ? (window.dp / window.ms) * 1000 : 0;

  const distanceDp = Math.round(exactDistanceDp);
  const velocityDpS = Math.round(exactVelocityDpS);

  const movedFar = Math.abs(dx) > TAP_SLOP_DP || Math.abs(dy) > TAP_SLOP_DP;
  const base = { distanceDp, durationMs, velocityDpS, pointerCount, partial: cancelled };

  // Two fingers is a pinch/zoom regardless of how far anything travelled — the
  // single-pointer geometry below does not describe it.
  if (pointerCount >= 2) {
    return { ...base, kind: "pinch" };
  }

  if (!movedFar) {
    // Stayed put: a tap if brief, a long press if held. A long press is a
    // deliberate action (context menus, reordering) and worth distinguishing.
    return durationMs <= TAP_MAX_DURATION_MS
      ? { ...base, kind: "tap" }
      : { ...base, kind: "long_press" };
  }

  const direction = dominantDirection(dx, dy);

  // Cancelled mid-drag means a native scroller claimed the gesture, so this was
  // a scroll — reported with direction only, since the real distance and
  // velocity happened after we stopped seeing the stream.
  if (cancelled) {
    return { ...base, kind: "scroll", direction };
  }

  // A real drag we saw through to the end. Which kind it was depends on whether
  // the finger was still travelling when it lifted — the same question both
  // native trackers ask, against the same threshold.
  if (exactDistanceDp < MIN_SWIPE_DISTANCE_DP) return null;
  const kind = exactVelocityDpS >= MIN_SWIPE_VELOCITY_DP_S ? "swipe" : "scroll";
  return { ...base, kind, direction };
}

/** Gestures are reported along their dominant axis; a diagonal drag is
 *  whichever way it mostly went. */
function dominantDirection(dx: number, dy: number): GestureDirection {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "down" : "up";
}
