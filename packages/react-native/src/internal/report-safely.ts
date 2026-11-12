import { handleError } from "@groundcover/rum-core";

/**
 * Reports an error without letting the reporting itself become the failure.
 *
 * `handleError` routes to the configured logger, which reaches the host's console — patched by
 * other monitors, and `unpatchedConsoleLog` only sidesteps the patch that existed at import. So a
 * throw from the reporter is possible, and at every site that matters it costs more than the
 * report: a `for` loop over pending work abandons everything queued behind it, a `.catch` turns
 * into an unhandled rejection, and a callback running inside `ScreenHolder.set()` or a
 * NativeEventEmitter dispatch takes down the host's navigation or event delivery.
 *
 * One definition rather than a private copy per module: copies drift apart in name while making
 * the identical argument, and the next reader has to be able to conclude that a BARE `handleError`
 * elsewhere is a deliberate choice rather than the one site that forgot.
 */
export function reportSafely(error: unknown): void {
  try {
    handleError(error);
  } catch {
    // Nothing left to report it to, and the caller must continue regardless.
  }
}

/**
 * Runs every callback, containing each one separately, and reports whatever they throw.
 *
 * The point is the ISOLATION: a bare `list.forEach(run)` stops at the first throw, so one bad
 * callback silently drops every callback queued behind it. Used wherever a buffered list of
 * host-supplied or listener-supplied work is released at once.
 */
export function runEachContained(callbacks: ReadonlyArray<() => void>): void {
  for (const run of callbacks) {
    try {
      run();
    } catch (error) {
      reportSafely(error);
    }
  }
}
