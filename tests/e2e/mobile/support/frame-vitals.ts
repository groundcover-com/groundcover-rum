import type { RumEvent } from "./ingest-client";

// The frame-vitals wire contract, in one place because four specs select on it: a contract spelled
// out in each spec lets a missed file go green against a stale contract rather than fail.

/**
 * What a closed frame segment emits: ONE event.
 *
 * - `frames_delay_total` — MILLISECONDS lost, absolute. The sum over slow frames of
 *   `actualDuration - expectedDuration`. It is deliberately an absolute duration rather than a
 *   rate: idle frames contribute exactly zero, so time spent looking at a still screen cannot
 *   dilute it.
 */
export const FRAME_VITAL_METRICS = ["frames_delay_total"] as const;

/**
 * Names that must never appear on the wire, and why:
 *
 * - `slow_frames_rate`, `frozen_frames_rate` — a rate needs a denominator, and the denominator is
 *   not the same quantity on the two platforms. iOS counts every display refresh (CADisplayLink
 *   ticks whether or not the app drew); Android counts only frames it actually drew
 *   (FrameMetrics fires on a real draw). On a mostly idle screen iOS sees the full refresh rate
 *   and Android a few frames per second, so the same app would report rates orders of magnitude
 *   apart. The slow and frozen counts carry the information without the denominator.
 * - `refresh_rate_average` — on iOS it IS the refresh rate by construction (ticks / elapsed). On
 *   Android, where frames come only from draws, the same arithmetic reads a few frames per second,
 *   which is not a refresh rate at all and would tell a reader the app runs at single-digit fps.
 *   It is also deliberately not derivable from anything on the wire — see the note on
 *   `performance_frames_total` in the SDK's own type declarations.
 */
export const RETIRED_FRAME_VITAL_METRICS = [
  "slow_frames_rate",
  "frozen_frames_rate",
  "refresh_rate_average",
  // Its value comes from a SINGLE frame — the worst non-frozen one in the segment — so one stutter
  // anywhere in a long otherwise-smooth screen dominates it, and identical jank produces very
  // different numbers depending on segment length. `frames_delay_total` carries the time lost and
  // the counts carry the frequency; both aggregate correctly, which a one-frame-derived rate
  // cannot.
  "refresh_rate_min",
] as const;

export function frameMetricName(event: RumEvent): string {
  return String((event.attributes as Record<string, unknown>)?.["performance_metric_name"] ?? "");
}

export function isFrameVital(event: RumEvent): boolean {
  return (FRAME_VITAL_METRICS as readonly string[]).includes(frameMetricName(event));
}

/**
 * Any retired metric name found in `events`, for the assertion that none is emitted.
 *
 * Worth its own helper rather than an inline filter: "the current metrics arrived" passes just as
 * happily when retired ones are still being emitted alongside them, which is a wire nobody agreed
 * to and double the vitals volume.
 */
export function retiredFrameVitals(events: RumEvent[]): string[] {
  const retired = new Set<string>();
  for (const event of events) {
    const name = frameMetricName(event);
    if ((RETIRED_FRAME_VITAL_METRICS as readonly string[]).includes(name)) retired.add(name);
  }
  return [...retired].sort();
}
