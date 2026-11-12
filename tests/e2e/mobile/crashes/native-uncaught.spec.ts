import { test, expect } from "@mobilewright/test";
import { clearEvents, expectEvents, waitForEvents } from "../support/ingest-client";
import { app, BUNDLE_ID } from "../support/app";

// The native counterpart of exceptions.spec.ts's uncaught-error test, which is @hybrid-only: in a
// native app an uncaught error ends the process, so it is a crash, reported on the next launch.
// native-crash.spec.ts drives the SDK's own test hook (a bad-pointer signal on iOS, an exception
// posted to Android's main looper). This drives the app's own uncaught error, the other path: an
// Objective-C exception on iOS, which the crash reporter records through its exception handler
// rather than its signal handler, and a throwable on a background thread on Android.
test.describe("native — an uncaught error is a crash", { tag: "@native-app-only" }, () => {
  test("an uncaught error is reported on the next launch, with its message", async ({
    screen,
    device,
  }) => {
    test.setTimeout(180_000); // a crash plus a cold relaunch

    // Clear BEFORE the crash: the next launch drains the crash at once, and a clear after the
    // relaunch would race it.
    await clearEvents();
    // A tap confirms the session; a session no user touched sends nothing, its crash included.
    await screen.getByLabel("Logs tab").tap();
    await waitForEvents("interaction", { timeout: 30_000 });

    await screen.getByText("throw uncaught").tap();
    await new Promise((r) => setTimeout(r, 3_000)); // the process dies
    await device.launchApp(BUNDLE_ID);

    const [crash] = await expectEvents("exception", {
      timeout: 60_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)["error_message"] ?? "").includes(
          "uncaught e2e error"
        ),
      describe: "the uncaught error, reported on the next launch",
    });
    const attrs = crash!.attributes as Record<string, unknown>;
    expect(attrs["error_handled"]).toBe(false);
    expect(attrs["error_metadata.fatal"]).toBe(true);
    // The app's own error type: the exception's name on iOS, the throwable's class on Android.
    expect(String(attrs["error_type"] ?? "")).toContain(app.errorType);
  });
});
