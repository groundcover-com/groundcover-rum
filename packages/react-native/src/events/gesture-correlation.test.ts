import { describe, expect, it } from "vitest";

import {
  CORRELATION_DISTANCE_DP,
  CORRELATION_WINDOW_MS,
  correlateGesture,
} from "./gesture-correlation";
import type { TouchStartRecord } from "../internal/touch-bridge";
import { EMPTY_WALK } from "../react/fiber-walk";

const DOWN_AT = 1_700_000_000_000;

const WALK = {
  ...EMPTY_WALK,
  component: "ProductCarousel",
  label: "Featured products",
  componentPath: "HomeScreen > ProductCarousel",
};

const touch = (over: Partial<TouchStartRecord> = {}): TouchStartRecord => ({
  startedAtMs: DOWN_AT,
  x: 200,
  y: 400,
  target: WALK,
  ...over,
});

const gesture = (over: { startedAtMs?: number; startX?: number; startY?: number } = {}) => ({
  startedAtMs: DOWN_AT,
  startX: 200,
  startY: 400,
  ...over,
});

describe("correlateGesture", () => {
  it("matches a native gesture to the touch JavaScript saw start", () => {
    // The whole point of the hybrid: native's kinematics with JS's labels. Both sides stamp
    // touch-DOWN time — recognition time would put a slow press-then-drag ~400ms outside the
    // window and every deliberate scroll would come back unlabelled — but that convention is a
    // PRODUCER property, pinned in the native trackers rather than here.
    //
    // The WHOLE walk comes back, not a display string, because the caller must apply the same
    // masking a tap gets and `masked` only reaches it if it travels with the rest.
    expect(correlateGesture(gesture(), [touch()])).toEqual(WALK);
  });

  it("tolerates bridge and clock jitter between the two sides", () => {
    const match = correlateGesture(
      gesture({ startedAtMs: DOWN_AT + 120, startX: 210, startY: 405 }),
      [touch()]
    );

    expect(match?.component).toBe("ProductCarousel");
  });

  it("does not match a touch outside the time window", () => {
    const stale = touch({ startedAtMs: DOWN_AT - (CORRELATION_WINDOW_MS + 50) });

    expect(correlateGesture(gesture(), [stale])).toBeNull();
  });

  it("does not match a touch somewhere else on screen", () => {
    const elsewhere = touch({ x: 200 + CORRELATION_DISTANCE_DP + 20 });

    expect(correlateGesture(gesture(), [elsewhere])).toBeNull();
  });

  it("picks the closest touch in TIME when several are in range", () => {
    // Fast scrolling puts several touch-downs inside the window; the gesture
    // grew out of exactly one of them.
    const named = (component: string) => ({ ...WALK, component });
    const older = touch({ startedAtMs: DOWN_AT - 100, target: named("Older") });
    const closest = touch({ startedAtMs: DOWN_AT - 5, target: named("Closest") });
    const newer = touch({ startedAtMs: DOWN_AT + 90, target: named("Newer") });

    expect(correlateGesture(gesture(), [older, closest, newer])?.component).toBe("Closest");
  });

  it("returns null rather than guessing when nothing matches", () => {
    // A touch on a surface JS never saw. The caller still reports the gesture;
    // unlabelled beats mislabelled.
    expect(correlateGesture(gesture(), [])).toBeNull();
  });
});
