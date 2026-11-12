import { describe, expect, it } from "vitest";

import { classifyGesture, type GestureInput } from "./gesture-classification";

function gesture(over: Partial<GestureInput> = {}) {
  const start = over.start ?? { x: 100, y: 200, t: 1_000 };
  return classifyGesture({
    start,
    end: { x: 100, y: 200, t: 1_100 },
    pointerCount: 1,
    cancelled: false,
    // Defaults to `start`, so the release window is the whole drag. These cases
    // are about kind/direction/distance, not about how the final segment is
    // measured.
    previous: start,
    ...over,
  });
}

/**
 * swipe vs scroll, told apart the same way both native trackers tell them apart. Ignoring speed
 * and calling every completed drag a swipe would disagree with iOS AND Android on the identical
 * gesture — which matters because this classifier IS the reporter wherever the native tracker is
 * absent or failed to attach.
 *
 * RELEASE velocity, not average: a drag that starts slow and finishes fast is a swipe, and
 * an average would be a third definition rather than a shared one.
 */
describe("classifyGesture — swipe vs scroll", () => {
  const from = { x: 0, y: 0, t: 0 };

  it("calls a drag released with momentum a swipe", () => {
    // 60dp in the last 100ms = 600 dp/s, comfortably past the threshold.
    expect(
      classifyGesture({
        start: from,
        previous: { x: 140, y: 0, t: 900 },
        end: { x: 200, y: 0, t: 1_000 },
        pointerCount: 1,
        cancelled: false,
      })
    ).toMatchObject({ kind: "swipe", velocityDpS: 600 });
  });

  it("calls a drag brought to rest a scroll, however far it travelled", () => {
    // The case that matters: 200dp of travel, but the finger had essentially
    // stopped before lifting — 2dp in the last 100ms = 20 dp/s.
    expect(
      classifyGesture({
        start: from,
        previous: { x: 198, y: 0, t: 900 },
        end: { x: 200, y: 0, t: 1_000 },
        pointerCount: 1,
        cancelled: false,
      })
    ).toMatchObject({ kind: "scroll", distanceDp: 200, velocityDpS: 20 });
  });

  it("treats the swipe threshold as a strict boundary", () => {
    const at = (dp: number) =>
      classifyGesture({
        start: from,
        previous: { x: 200 - dp, y: 0, t: 900 },
        end: { x: 200, y: 0, t: 1_000 },
        pointerCount: 1,
        cancelled: false,
      });

    // 30dp in 100ms = exactly 300 dp/s.
    expect(at(30)).toMatchObject({ kind: "swipe", velocityDpS: 300 });
    expect(at(29)).toMatchObject({ kind: "scroll", velocityDpS: 290 });
  });

  it("reports release velocity rather than the average over the drag", () => {
    // Crawls for 900ms, then flicks: average is 200 dp/s, release is 1000.
    // Averaging would call this a scroll and under-report its speed 5x.
    const result = classifyGesture({
      start: from,
      previous: { x: 100, y: 0, t: 900 },
      end: { x: 200, y: 0, t: 1_000 },
      pointerCount: 1,
      cancelled: false,
    });

    expect(result).toMatchObject({ kind: "swipe", velocityDpS: 1_000 });
  });

  it("falls back to the whole drag when there was only one sample", () => {
    // A fast flick can end before onTouchMove ever fires, leaving no
    // next-to-last point. Measuring start→end is the best available answer;
    // treating it as zero would silently demote every such flick to a scroll.
    expect(
      classifyGesture({
        start: from,
        previous: from,
        end: { x: 200, y: 0, t: 200 },
        pointerCount: 1,
        cancelled: false,
      })
    ).toMatchObject({ kind: "swipe", velocityDpS: 1_000 });
  });

  it("still calls a cancelled stream a scroll without consulting velocity", () => {
    // A native scroller took the gesture over, so the finger was certainly still
    // moving — but we never saw it lift, and what we did see is a lower bound.
    expect(
      classifyGesture({
        start: from,
        previous: { x: 140, y: 0, t: 900 },
        end: { x: 200, y: 0, t: 1_000 },
        pointerCount: 1,
        cancelled: true,
      })
    ).toMatchObject({ kind: "scroll", partial: true });
  });
});

describe("classifyGesture", () => {
  it("classifies a brief, still touch as a tap", () => {
    expect(gesture()).toMatchObject({ kind: "tap", distanceDp: 0, durationMs: 100 });
  });

  it("classifies a held, still touch as a long press", () => {
    // A deliberate action — context menus, drag-to-reorder — and worth telling
    // apart from an ordinary tap.
    expect(
      gesture({ end: { x: 103, y: 198, t: 1_900 } })
    ).toMatchObject({ kind: "long_press", durationMs: 900 });
  });

  it("tolerates a few pixels of finger wobble in a tap", () => {
    expect(gesture({ end: { x: 108, y: 208, t: 1_100 } })).toMatchObject({ kind: "tap" });
  });

  it("treats the tap thresholds as strict boundaries", () => {
    const from = { x: 0, y: 0, t: 0 };
    // Exactly at the slop / duration edge is still a tap; just past is not.
    expect(classifyGesture({ start: from, previous: from, end: { x: 10, y: 0, t: 500 }, pointerCount: 1, cancelled: false }))
      .toMatchObject({ kind: "tap" });
    // Past the slop but under the swipe floor: nothing worth reporting.
    expect(classifyGesture({ start: from, previous: from, end: { x: 11, y: 0, t: 500 }, pointerCount: 1, cancelled: false }))
      .toBeNull();
    // Past the duration edge while still: a long press, not a tap.
    expect(classifyGesture({ start: from, previous: from, end: { x: 0, y: 0, t: 501 }, pointerCount: 1, cancelled: false }))
      .toMatchObject({ kind: "long_press" });
  });

  it("classifies a completed drag as a swipe, with direction and velocity", () => {
    const result = gesture({ end: { x: 300, y: 210, t: 1_200 } });

    expect(result).toMatchObject({
      kind: "swipe",
      direction: "right",
      distanceDp: 200,
      durationMs: 200,
      // 200.25dp (the true hypotenuse of 200 x 10) over 200ms. Reported distance
      // rounds to 200, but velocity is computed before that rounding — dividing
      // the rounded distance instead would answer a flat 1000 here.
      velocityDpS: 1_001,
      partial: false,
    });
  });

  /**
   * A release window shorter than a frame is not a measurement of anything.
   *
   * React Native coalesces touch moves, so the last two samples of a perfectly ordinary drag can
   * be adjacent in time and far apart in space. Dividing one by the other then reports a velocity
   * an order of magnitude over what the finger did, beside durations a fraction of the real
   * gesture. Such numbers are not noisy, they are a different quantity under the same name as
   * native's correct one.
   *
   * Here: 240dp over 300ms, ~800 dp/s throughout — but the final pair is 1ms apart.
   */
  it("does not read a velocity off a sub-frame release window", () => {
    const result = classifyGesture({
      start: { x: 100, y: 400, t: 0 },
      previous: { x: 100, y: 210, t: 299 },
      end: { x: 100, y: 160, t: 300 },
      pointerCount: 1,
      cancelled: false,
    });

    // 50dp in 1ms reads as 50 000 dp/s. The whole drag says ~800.
    expect(result?.velocityDpS).toBeLessThan(2_000);
    expect(result?.velocityDpS).toBeGreaterThan(400);
  });

  /**
   * The counterpart: a window wide enough to mean something is still measured over the RELEASE and
   * not averaged over the drag, because a crawl-then-flick is a swipe and its average hides that.
   * Both native trackers report release velocity, so averaging here would make this field a third
   * definition rather than a shared one.
   */
  it("still measures release velocity, not the average, once the window is wide enough", () => {
    const result = classifyGesture({
      // Crawls 20dp in 250ms, then flicks 150dp in 50ms.
      start: { x: 100, y: 400, t: 0 },
      previous: { x: 100, y: 380, t: 250 },
      end: { x: 100, y: 230, t: 300 },
      pointerCount: 1,
      cancelled: false,
    });

    // Release: 150dp / 50ms = 3 000 dp/s. The average over the drag is only 567.
    expect(result?.velocityDpS).toBe(3_000);
    expect(result?.kind).toBe("swipe");
  });

  it("reports a gesture along its dominant axis", () => {
    expect(gesture({ end: { x: 120, y: 500, t: 1_300 } })).toMatchObject({ direction: "down" });
    expect(gesture({ end: { x: 120, y: -100, t: 1_300 } })).toMatchObject({ direction: "up" });
    expect(gesture({ end: { x: -100, y: 210, t: 1_300 } })).toMatchObject({ direction: "left" });
  });

  it("ignores a drag too small to be a deliberate swipe", () => {
    // Past the tap slop but well short of intent — reporting it would bury real
    // gestures in noise.
    expect(gesture({ end: { x: 120, y: 205, t: 1_200 } })).toBeNull();
  });

  it("classifies a cancelled drag as a scroll, marked partial", () => {
    // Android cancels the JS stream the moment a ScrollView takes over. We saw
    // the direction but never the end, so the numbers are lower bounds.
    const result = gesture({ end: { x: 100, y: 260, t: 1_150 }, cancelled: true });

    expect(result).toMatchObject({ kind: "scroll", direction: "down", partial: true });
  });

  it("reports a cancelled scroll even below the swipe distance floor", () => {
    // The floor exists to filter accidental wobble on a COMPLETED drag; a
    // cancelled one was cut short by the platform, not by the user.
    const result = gesture({ end: { x: 100, y: 215, t: 1_050 }, cancelled: true });

    expect(result).toMatchObject({ kind: "scroll", partial: true });
  });

  it("classifies any two-finger gesture as a pinch", () => {
    // Single-pointer geometry does not describe a pinch, so the movement
    // thresholds do not apply.
    expect(gesture({ pointerCount: 2 })).toMatchObject({ kind: "pinch", pointerCount: 2 });
    expect(
      gesture({ pointerCount: 2, end: { x: 400, y: 600, t: 1_400 } })
    ).toMatchObject({ kind: "pinch" });
  });

  it("survives a zero-duration touch without dividing by zero", () => {
    const result = gesture({ end: { x: 300, y: 200, t: 1_000 } });

    expect(result?.velocityDpS).toBe(0);
  });

  it("never reports a negative duration from a clock that went backwards", () => {
    const result = gesture({ end: { x: 100, y: 200, t: 900 } });

    expect(result?.durationMs).toBe(0);
  });

  it("measures distance diagonally, not per-axis", () => {
    const result = gesture({ end: { x: 130, y: 240, t: 1_200 } });

    expect(result?.distanceDp).toBe(50); // 3-4-5 triangle
  });
});

/**
 * The thresholds have to see the same numbers the native classifiers see. Those compare raw
 * magnitudes, so rounding first would let a band half a unit either side of each threshold
 * decide differently per platform — invisible in aggregate, since both answers are plausible
 * kinds for a real gesture. Reported values stay rounded; rounding the OUTPUT is harmless.
 */
describe("classifyGesture — threshold edges agree with the native classifiers", () => {
  const from = { x: 0, y: 0, t: 0 };

  it("drops a drag just under the distance floor, which rounding would promote over it", () => {
    // 31.6dp travelled. Rounds to 32, which is exactly MIN_SWIPE_DISTANCE_DP, so
    // a rounded comparison would let it through; both native sides discard it.
    expect(
      classifyGesture({
        start: from,
        previous: { x: 31.6, y: 0, t: 400 },
        end: { x: 31.6, y: 0, t: 500 },
        pointerCount: 1,
        cancelled: false,
      })
    ).toBeNull();
  });

  it("keeps a drag exactly at the distance floor", () => {
    // The other side of the same boundary: `>= 32` must still be a gesture, or
    // comparing raw would have moved the threshold rather than un-rounding it.
    expect(
      classifyGesture({
        start: from,
        previous: { x: 32, y: 0, t: 400 },
        end: { x: 32, y: 0, t: 500 },
        pointerCount: 1,
        cancelled: false,
      })
    ).toMatchObject({ kind: "scroll" });
  });

  it("calls a release just under the swipe velocity a scroll, as native does", () => {
    // 29.97dp in the last 100ms = 299.7 dp/s. Rounds to 300 — the threshold —
    // so a rounded comparison would ship it as a `swipe` while both native sides
    // call it a `scroll`.
    const result = classifyGesture({
      start: from,
      previous: { x: 70, y: 0, t: 400 },
      end: { x: 99.97, y: 0, t: 500 },
      pointerCount: 1,
      cancelled: false,
    });

    expect(result).toMatchObject({ kind: "scroll" });
    // …and the reported figure is still a whole number.
    expect(result?.velocityDpS).toBe(300);
    expect(result?.distanceDp).toBe(100);
  });

  it("calls a release exactly at the swipe velocity a swipe", () => {
    const result = classifyGesture({
      start: from,
      previous: { x: 70, y: 0, t: 400 },
      end: { x: 100, y: 0, t: 500 },
      pointerCount: 1,
      cancelled: false,
    });

    expect(result).toMatchObject({ kind: "swipe" });
  });
});
