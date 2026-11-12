// Defaults + clamps for the native-module knobs. Mirrors core's own
// resolve*/clamp discipline: an out-of-range or non-finite value falls back to
// the default rather than reaching native, where a nonsense threshold would arm
// a watchdog that fires constantly or never.

import { warnOnce } from "../internal/safe-warn";

/** Main-thread stall before an app-hang is reported (iOS). 2 s, a common default. */
export const DEFAULT_HANG_THRESHOLD_MS = 2_000;

/**
 * Android's live watchdog default. Higher than iOS on purpose: the platform's
 * own ANR threshold is 5s, so reporting sooner would flag stalls the OS itself
 * tolerates. A host that configures `hangThresholdMs` overrides BOTH platforms.
 */
export const DEFAULT_ANDROID_HANG_THRESHOLD_MS = 5_000;

/**
 * Longest a frame-vitals segment may run before native force-closes it.
 *
 * Not a reporting cadence: segments normally end on a navigation or on
 * backgrounding, and this is only the safety valve that stops an unbounded
 * counter from accumulating on a screen the user never leaves. Deliberately
 * generous — a shorter value fragments a screen's stats into partials the
 * consumer has to re-add.
 */
export const DEFAULT_VITALS_MAX_SEGMENT_MS = 60_000;

/** How TTI's interactive moment is decided. See `NativeOptions.tti`. */
export const DEFAULT_TTI_SOURCE = "auto" as const;

const MIN_HANG_THRESHOLD_MS = 250;
const MAX_HANG_THRESHOLD_MS = 60_000;
const MIN_VITALS_MAX_SEGMENT_MS = 1_000;
const MAX_VITALS_MAX_SEGMENT_MS = 300_000;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  // Rounded, because the two engines read these fields with DIFFERENT numeric
  // types: Kotlin takes them through `JSONObject.optLong` into a `Long`, Swift
  // into a `Double`. A fractional value therefore configures 1500 on Android and
  // 1500.5 on iOS from one config. Making it integral before it crosses the
  // bridge fixes that once, for every threshold, rather than per-platform.
  return Math.round(value);
}

export function resolveHangThresholdMs(value: unknown, fallback: number): number {
  return clamp(value, MIN_HANG_THRESHOLD_MS, MAX_HANG_THRESHOLD_MS, fallback);
}

/**
 * The hang threshold for the platform actually running, from either shape the option accepts.
 * The one native knob whose right value DIFFERS BY PLATFORM: iOS has no system hang bar, while
 * Android's own ANR threshold is 5s and below it flags stalls the OS tolerates.
 *
 * @param platform `Platform.OS`. Anything but "android" resolves to the iOS side — RN's other
 *   hosts have no native module, so this only has to not throw.
 */
export function selectHangThresholdMs(value: unknown, platform: string): number {
  const isAndroid = platform === "android";
  const fallback = isAndroid ? DEFAULT_ANDROID_HANG_THRESHOLD_MS : DEFAULT_HANG_THRESHOLD_MS;

  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return resolveHangThresholdMs(value, fallback);
  // `typeof null === "object"`, hence the explicit null check above.
  if (typeof value === "object") {
    // A missing key is not a reason to borrow the other platform's number —
    // that is exactly the coupling this function exists to break.
    return resolveHangThresholdMs(
      (value as Record<string, unknown>)[isAndroid ? "android" : "ios"],
      fallback
    );
  }
  return fallback;
}

/**
 * The host's `tti` option, or the default.
 *
 * Checked, never cast: read with a cast, any value that is not exactly `"manual"` — `"Manual"`, a
 * stray boolean, a typo — would silently select auto. That is a worse failure than the clamped
 * numbers above: `getInteractiveMark` reads the manual and auto marks from two different places,
 * so a host that typed `"Manual"`, called `markAppInteractive()` and saw a TTI on its dashboard
 * would have a number measured a different way than it asked for, with nothing anywhere saying so.
 *
 * Hence the warning, which the numeric resolvers deliberately do not emit: clamping a threshold
 * still measures the thing the host asked for, just at a different bound. Absent stays silent —
 * unset is not a mistake.
 */
export function resolveTtiSource(value: unknown): "auto" | "manual" {
  if (value === "manual" || value === "auto") return value;
  if (value !== null && value !== undefined) {
    warnOnce(
      `[groundcover] options.native.tti must be "auto" or "manual"; got ${describeOptionValue(value)}. Using "${DEFAULT_TTI_SOURCE}".`
    );
  }
  return DEFAULT_TTI_SOURCE;
}

/** How much of a host-supplied string a warning may echo. Long enough to recognise a typo. */
const MAX_WARNED_VALUE_CHARS = 40;

/**
 * Names a rejected option value for a warning, without trusting it.
 *
 * NOT `JSON.stringify`: it throws on a BigInt, a circular object or a throwing `toJSON`, and it
 * would run as an ARGUMENT to {@link warnOnce} — so `safeWarn`'s own try/catch never sees it. A
 * resolver whose entire job is to tolerate a bad option would then throw out of
 * `instrumentNativeSignals`, into the composition root's init catch, and tear the SDK down: a
 * typo'd config value turning into no SDK at all.
 *
 * Bounded, and non-strings described by TYPE rather than contents, because this SDK's own log
 * listener patches `console.warn` — so anything echoed here can ride into a captured log event.
 * The host needs to know WHICH option it got wrong, not to see its object printed back.
 */
function describeOptionValue(value: unknown): string {
  if (typeof value !== "string") return `a ${typeof value}`;
  return value.length <= MAX_WARNED_VALUE_CHARS
    ? `"${value}"`
    : `"${value.slice(0, MAX_WARNED_VALUE_CHARS)}…"`;
}

export function resolveVitalsMaxSegmentMs(value: unknown): number {
  return clamp(
    value,
    MIN_VITALS_MAX_SEGMENT_MS,
    MAX_VITALS_MAX_SEGMENT_MS,
    DEFAULT_VITALS_MAX_SEGMENT_MS
  );
}
