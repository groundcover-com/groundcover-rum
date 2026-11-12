import type { RawGesture } from "../internal/touch-bridge";
import type { FiberWalkResult } from "../react/fiber-walk";

/**
 * Which side reports a scroll or a swipe — the one piece of gesture policy, kept in one place
 * rather than as a bare boolean plus an inline conditional in the instrumentation manager.
 *
 * Native measures these kinds properly: it watches the gesture through to its end, where the JS
 * touch stream was cancelled the moment a ScrollView claimed the gesture. So once the native
 * tracker is CONFIRMED attached, the JS classifier stands down on them — reporting both would
 * ship two events for one gesture, the JS one carrying the worse numbers. A tracker that never
 * attached leaves JS in charge rather than dropping every scroll (the attach is the
 * `gestures_attached` signal, not `nativeInit`'s status — see `setNativeGesturesAttached`).
 *
 * Taps and pinches are never suppressed: native reports no discrete tap, and a pinch's JS
 * numbers are all there is. The set is typed as `RawGesture["kind"]`, so adding a movement kind
 * is a decision made here rather than a silent miss.
 */
const NATIVE_MEASURED_KINDS: ReadonlySet<RawGesture["kind"]> = new Set(["swipe", "scroll"]);

/** What the native tracker told us it reaches, as of its last `gestures_attached` signal. */
export type NativeGestureCoverage = {
  attached: boolean;
  /** The tracker's own statement of reach, from the `gestures_attached` signal payload. */
  coversAllSurfaces: boolean;
};

export const NO_NATIVE_COVERAGE: NativeGestureCoverage = {
  attached: false,
  coversAllSurfaces: false,
};

/**
 * True when the JS classifier should stand down for this interaction because the native tracker,
 * confirmed attached, will report it with better numbers.
 *
 * "Attached" is not enough on its own, because it is not app-wide. A tracker hooks SURFACES, and
 * on Android it hooks activities — so a React Native `Modal`, which renders into a `Dialog`, is
 * not covered. Standing down on the strength of the main activity being hooked would mean nobody
 * measures a modal drag: native is not watching it and JS has been told not to. The gesture would
 * not be mislabelled, it would never be reported at all.
 *
 * So the question asked here is "is native watching THIS touch", not "is native attached
 * somewhere". `insideModal` comes free from the fiber walk the gesture already carries, and
 * `coversAllSurfaces` comes from the tracker itself rather than being inferred from
 * `Platform.OS` — the platform difference is a fact about our own trackers, and it belongs where
 * it is known rather than duplicated in a JS constant that would silently rot if Android ever
 * gained per-window attachment.
 */
export function shouldSuppressJsGesture(
  interaction: Pick<RawGesture, "kind"> & { target?: Pick<FiberWalkResult, "insideModal"> },
  coverage: NativeGestureCoverage
): boolean {
  if (!coverage.attached) return false;
  if (!NATIVE_MEASURED_KINDS.has(interaction.kind)) return false;
  // The one surface we know a tracker can miss. Uncovered → JS stays in charge, so the gesture is
  // reported with JS numbers rather than not at all.
  if (interaction.target?.insideModal && !coverage.coversAllSurfaces) return false;
  return true;
}
