import { test, expect } from "@mobilewright/test";

// Runs FIRST — `00-bootstrap/` sorts ahead of every other suite, and `00-` ahead of its siblings
// — with one job: absorb the slow WebDriverAgent cold start that otherwise hits whichever spec
// sorts first as `RpcError: timed out waiting for WebDriverAgent to be ready`, which a single
// attempt is not long enough to outlast.
//
// Retries a trivial tap INTERNALLY, swallowing the readiness error until the driver is up. On
// Android there is no WDA, so this is a fast no-op.
test.describe("warm-up", () => {
  test("app + driver become interactive (absorbs WebDriverAgent cold start)", async ({ screen }) => {
    test.setTimeout(200_000);
    const deadline = Date.now() + 180_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        // "Taps tab" is the default bottom tab — present on every screen.
        await screen.getByLabel("Taps tab").tap({ timeout: 20_000 });
        expect(true).toBe(true); // reaching here means driver up + app interactive
        return;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 3000)); // brief pause, then retry
      }
    }

    throw new Error(
      `warm-up: app/driver never became interactive within 180s (last: ${String(lastError)})`
    );
  });
});
