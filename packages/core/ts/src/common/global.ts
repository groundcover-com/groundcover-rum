/** Multiplier to convert milliseconds (Date.now()) to nanoseconds */
export const MS_TO_NANOSECONDS = 1_000_000;

/** Convert a millisecond value (e.g. Date.now()) to nanoseconds. */
export function msToNs(ms: number): number {
  return ms * MS_TO_NANOSECONDS;
}

/** Convert a nanosecond timestamp back to milliseconds. */
export function nsToMs(ns: number): number {
  return ns / MS_TO_NANOSECONDS;
}
