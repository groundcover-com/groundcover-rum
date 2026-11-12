import { handleError } from "../common/error-handler";
import { BaseEvent } from "./types";

// Reading an event's own occurrence time back off the event.
//
// Only TOP-LEVEL fields count, and both must be read: EventEnricher has a
// single branch — `network` events get a top-level `start_timestamp` and no
// `timestamp` at all, every other type gets a `timestamp` and no
// `start_timestamp`. (`timestamp ?? start_timestamp` would be wrong: `??` does
// not fall through on `timestamp: 0`.)
//
// `attributes` is deliberately off-limits. A platform's events may carry a
// `start_timestamp` in there too (navigation spans do) — in MILLISECONDS, which
// read as a nanosecond value lands in 1970.

// A candidate is trusted only inside (nowNs - maxAgeNs, nowNs] — half-open at
// the bottom. The window is what makes it safe to derive session identity from
// event data:
//
// - Legitimate backdating is small and in-process — a rotation stamped from a
//   second Date.now() read milliseconds after the triggering event, or an
//   in-flight network span that began seconds before the rotation.
// - Everything untrustworthy is off by ORDERS OF MAGNITUDE: a caller passing
//   milliseconds where nanoseconds belong (an `enrichEvent` that forgot
//   `msToNs`) reads as 1970, a monotonic clock reads as 1970, and `0` means
//   "unset" everywhere in this codebase. Any window measured in minutes
//   separates those from the real cases, with no absolute "plausible epoch"
//   constant to rot.
// - Both bounds come from the SAME clock read as `nowNs`, so a uniformly wrong
//   device clock shifts them together and produces no spurious correction.
//
// `maxAgeNs` is the CALLER's to choose, and it is not simply the session cap —
// see SessionLifecycle.resolveNewSessionStartTime, which bounds it by the idle
// window too so an adopted start cannot make the session it opens retroactively
// stale. The lower bound is strict for the same reason: at exactly one idle
// window back, isSessionInactive's own `>=` already reads as stale, so the edge
// value is the one place the caller's guarantee is borderline.
//
// NaN and ±Infinity need no special case: every comparison against NaN is
// false, +Infinity fails `<= nowNs`, and -Infinity fails the floor.
//
// Exported because the window has to be enforced by whoever ACTS on a time, not
// only by whoever reads it out of an event: SessionLifecycle re-checks the value
// EventsPool hands back before adopting it as a session start, rather than
// trusting a collaborator to have applied the same bounds.
export function isTrustedEventTime(
  value: unknown,
  nowNs: number,
  maxAgeNs: number
): value is number {
  return typeof value === "number" && value > 0 && value <= nowNs && value > nowNs - maxAgeNs;
}

// The earliest trusted occurrence time across `events`, or null when none of
// them carry one. Times are nanoseconds, as produced by msToNs.
//
// Never throws. The events come from EventsPool's buffer, which holds whatever
// a user's `enrichEvent` returned — including `undefined`, a non-number, or a
// throwing getter. Callers run this during a session rotation, where an
// escaping throw would abort the id flip partway.
//
// Containment is PER FIELD, deliberately, and that granularity is load-bearing
// twice over. Wrapping the whole loop would let one hostile getter hide every
// event after it; wrapping only each event would let a throwing `timestamp`
// getter hide the `start_timestamp` on the SAME event — which is where a network
// event keeps its time. Either way the scan yields nothing (or a too-late
// minimum), the rotation falls back to the clock, and the batch ships a start
// that postdates a buffered event — precisely the inversion this function exists
// to prevent.
export function earliestTrustedEventTime<TType extends string>(
  events: Iterable<BaseEvent<TType> | null | undefined>,
  nowNs: number,
  maxAgeNs: number
): number | null {
  let earliest: number | null = null;

  const consider = (value: unknown) => {
    if (isTrustedEventTime(value, nowNs, maxAgeNs) && (earliest === null || value < earliest)) {
      earliest = value;
    }
  };

  try {
    for (const event of events) {
      // A truthiness check cannot trap, so it stays outside the guards.
      if (!event) continue;
      // Reading a field is the part that can throw (a getter on a user-replaced
      // event), so each read is isolated and the scan carries on.
      try {
        consider(event.timestamp);
      } catch (error) {
        handleError(error);
      }
      try {
        consider(event.start_timestamp);
      } catch (error) {
        handleError(error);
      }
    }
  } catch (error) {
    // The iteration itself failed (a hostile iterator). Keep what we have.
    handleError(error);
  }

  return earliest;
}
