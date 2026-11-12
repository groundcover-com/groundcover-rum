import { describe, expect, test } from "vitest";
import { dragUpDistance, fallbackTapY, nudgeDistance, type Box } from "./ui";

/**
 * The fallback `tapScrolling` takes when its nudges could not lift a control
 * clear of the tab bar.
 *
 * A device cannot check this: the answer is arithmetic over a box and a line, and
 * getting it wrong produces a touch delivered somewhere else — which the suite
 * reports as a missing interaction, or as a failure on whatever the stray tap hit
 * instead, possibly a screen later.
 */
const box = (y: number, height: number): Box => ({ x: 100, y, width: 200, height });

describe("fallbackTapY", () => {
  test("taps the centre of the strip still in front of the bar", () => {
    // Control spans 1000-1100, bar clearance line at 1050: the visible strip is
    // 1000-1050 and its centre is 1025 — inside the control, in front of the bar.
    expect(fallbackTapY(box(1000, 100), 1050)).toEqual({ y: 1025 });
  });

  test("taps the control's own centre when it is entirely clear of the bar", () => {
    // Nothing is overlapped, so the strip is the whole control.
    expect(fallbackTapY(box(1000, 100), 5000)).toEqual({ y: 1050 });
  });

  /**
   * The case a plain clamp gets wrong: `Math.min(box.y + box.height / 2, limit)` returns 900
   * here, 100pt ABOVE the control's own top edge, so the OS delivers the touch to whatever
   * is drawn there and the spec fails as though the button were broken. There is genuinely
   * nowhere to tap in this configuration.
   */
  test("reports the control as unreachable rather than tapping above it", () => {
    const result = fallbackTapY(box(1000, 100), 900);

    expect(result).not.toHaveProperty("y");
    expect(result).toHaveProperty("unreachable");
    expect("unreachable" in result && result.unreachable).toContain("entirely below");
  });

  /**
   * The boundary between the two answers.
   *
   * A control whose top sits exactly ON the clearance line still has one tappable
   * row, so this must be a tap and not an "unreachable" — an off-by-one the other
   * way would start failing specs that work today.
   */
  test("still taps a control whose top rests exactly on the clearance line", () => {
    expect(fallbackTapY(box(1000, 100), 1000)).toEqual({ y: 1000 });
  });
});

/**
 * Android drops a drag shorter than its touch slop before a scroll ever begins, so
 * the distance a nudge asks for has to clear it. 8dp at the emulator's 420dpi.
 */
const ANDROID_TOUCH_SLOP_PX = 21;

describe("nudgeDistance", () => {
  /**
   * Nudging by the bare overlap is not enough: a control 3px under the clearance
   * line would ask for a 3px drag, the OS discards it, and repeated nudges move
   * nothing.
   */
  test("clears the touch slop for an overlap far under it", () => {
    expect(nudgeDistance(3)).toBeGreaterThan(ANDROID_TOUCH_SLOP_PX);
  });

  test("still covers the overlap once it is the larger term", () => {
    // The scroll has to reach past the bar, not merely start: 400 of overlap
    // needs more than 400 of drag.
    expect(nudgeDistance(400)).toBeGreaterThan(400);
  });

  test("clears the slop even where there is no overlap left to cover", () => {
    // Reachable when a nudge and the measurement race: the caller has already
    // decided to scroll, so answer with a drag that moves something.
    expect(nudgeDistance(0)).toBeGreaterThan(ANDROID_TOUCH_SLOP_PX);
    expect(nudgeDistance(-50)).toBeGreaterThan(ANDROID_TOUCH_SLOP_PX);
  });

  test("grows with the overlap", () => {
    expect(nudgeDistance(200)).toBeGreaterThan(nudgeDistance(100));
  });
});

describe("dragUpDistance", () => {
  // The Android agent rejects a gesture with any point off the screen, so the end of
  // the drag (startY - distance) must stay at or below the top edge.
  test("ends on the screen from anywhere, including an anchor near the top", () => {
    for (const startY of [2300, 1200, 300, 15, 11]) {
      const end = startY - dragUpDistance(startY);
      expect(end).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(10);
    }
  });

  test("still moves when the anchor is already at the edge", () => {
    expect(dragUpDistance(0)).toBe(1);
    expect(dragUpDistance(4.6)).toBe(1);
  });
});
