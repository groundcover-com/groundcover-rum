import { test, expect } from "@mobilewright/test";
import { clearEvents, expectEvents, screenName } from "../support/ingest-client";

// A Dialog is a window of its own and not an Activity, so the engine's per-Activity window
// callback never sees what happens in it: RN reports its modal's drags from JavaScript for that
// reason (gestures.spec.ts). A native app has no JavaScript to fall back on, so this records
// whether a tap inside a Dialog reaches the SDK at all. iOS has no counterpart: a presented view
// controller is in a window the SDK covers.
test.describe("native — an Android dialog", { tag: "@native-app-only" }, () => {
  test("a tap inside a Dialog is captured, on the screen that opened it", async ({
    screen,
    platform,
  }) => {
    test.skip(platform !== "android", "Android only: an iOS modal is in a window the SDK covers");
    test.setTimeout(90_000);

    await screen.getByLabel("Native tab").tap();
    await screen.getByLabel("Open modal").tap();
    await expect(screen.getByText("Modal row 1")).toBeVisible();
    // Drop the tap that opened it, which an Activity's window does see.
    await clearEvents();

    await screen.getByLabel("Close modal").tap();

    const [tap] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) =>
        (e.attributes as Record<string, unknown>)["interaction_target.label"] === "Close modal",
      describe: "the tap on Close modal, inside the Dialog",
    });
    expect((tap!.attributes as Record<string, unknown>)["interaction_type"]).toBe("tap");
    expect(screenName(tap!)).toBe("Native");
  });
});
