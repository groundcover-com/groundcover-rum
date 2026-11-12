import { test, expect } from "@mobilewright/test";
import { clearEvents, waitForEvents } from "../support/ingest-client";
import { app } from "../support/app";

// Exercises ALL THREE JS error-capture paths end to end on device:
//   - the direct API (groundcover.captureException) → handled exception
//   - the automatic global ErrorUtils handler (an uncaught async throw) → unhandled
//   - the engine's unhandled-promise-rejection tracker (Hermes) → unhandled
// The unit suite covers the listener shape; this proves the real engine hooks
// and the public API against the running app.
test.describe("rn-playground — exceptions", () => {
  test.beforeEach(async () => {
    await clearEvents();
  });

  test("captureException emits a handled exception event", async ({ screen }) => {
    // Arrange: go to the Logs screen where the capture buttons live.
    await screen.getByLabel("Logs tab").tap();

    // Act: invoke the direct captureException API.
    await screen.getByText("captureException").tap();

    // Assert: a handled exception event is captured, with its metadata.
    const [exc] = await waitForEvents("exception", {
      where: (e) =>
        String((e.attributes as Record<string, unknown>)?.error_message ?? "").includes(
          "handled e2e error"
        ),
    });
    expect(exc).toBeTruthy();

    const attrs = exc!.attributes as Record<string, unknown>;
    // The app's own error type: the error's name on RN, Flutter and iOS, the throwable's fully
    // qualified class on Android, as for a crash.
    expect(String(attrs.error_type ?? "")).toMatch(new RegExp(`(^|\\.)${app.errorType}$`));
    expect(attrs.error_handled).toBe(true);
    // Metadata rides along (dot-flattened, redaction contract applied).
    expect(attrs["error_metadata.screen"]).toBe("Logs");

    // A real parsed stack, from the real engine. `parseErrorStack` is unit-tested
    // against captured V8/Hermes/JSC strings, but only a device runs the format
    // RN 0.86's Hermes actually emits — and a parser that silently yields nothing
    // still produces an exception event that looks completely normal, just
    // without the one field anyone debugging it needs.
    const frames = attrs["error_stacktrace"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(frames)).toBe(true);
    expect(frames!.length).toBeGreaterThan(0);
    expect(String(frames![0]!["error_stacktrace[0].function"] ?? "")).not.toBe("");
  });

  // @hybrid-only: a framework's global handler, which a native app has no counterpart of. There an
  // uncaught error is a crash, reported on the next launch (native-uncaught.spec.ts).
  test("an uncaught error is auto-captured via the global handler (handled: false)", { tag: "@hybrid-only" }, async ({
    screen,
  }) => {
    // Arrange: go to the Logs screen.
    await screen.getByLabel("Logs tab").tap();

    // Act: trigger an uncaught throw, routed to RN's global ErrorUtils handler
    // (which the SDK wraps) — a different code path from captureException.
    await screen.getByText("throw uncaught").tap();

    // Assert: it is auto-captured end to end as an unhandled exception.
    const [exc] = await waitForEvents("exception", {
      timeout: 30_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)?.error_message ?? "").includes(
          "uncaught e2e error"
        ),
    });
    expect(exc).toBeTruthy();
    expect((exc!.attributes as Record<string, unknown>).error_handled).toBe(false);
  });

  // Skipped on-device: not verifiable in this environment. RN installs the Hermes
  // promise-rejection tracker itself at startup — but ONLY in __DEV__ builds (see
  // react-native Libraries/Core/polyfillPromise.js) — and the engine exposes a
  // single tracker slot. The e2e app is a Metro dev build, so RN owns that slot
  // and the SDK's tracker can't take it over; the rejection surfaces through RN's
  // default warning instead of our exception. In RELEASE builds RN does not
  // install it, so our tracker is active and rejections are captured; the JSC
  // path likewise uses ours. The unit suite covers the install + onUnhandled →
  // exception wiring (errors-events-listener.test.ts). Running this test needs a
  // release build of the app, which the e2e suite does not use.
  test.fixme("an unhandled promise rejection is auto-captured (handled: false)", { tag: "@rn-only" }, async ({ screen }) => {
    // Arrange: go to the Logs screen.
    await screen.getByLabel("Logs tab").tap();

    // Act: trigger an unhandled promise rejection, routed through the engine's
    // promise rejection tracker (Hermes on the sim) which the SDK hooks — a third
    // capture path distinct from ErrorUtils and captureException.
    await screen.getByText("unhandled rejection").tap();

    // Assert: it is auto-captured as an unhandled exception.
    const [exc] = await waitForEvents("exception", {
      timeout: 30_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)?.error_message ?? "").includes(
          "unhandled rejection e2e error"
        ),
    });
    expect(exc).toBeTruthy();
    expect((exc!.attributes as Record<string, unknown>).error_handled).toBe(false);
  });
});
