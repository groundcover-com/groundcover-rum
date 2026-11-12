import { test, expect } from "@mobilewright/test";
import { clearEvents, screenKey, screenName, waitForEvents } from "../support/ingest-client";
import { app } from "../support/app";

test.describe("rn-playground — navigation", () => {
  test.beforeEach(async () => {
    await clearEvents();
  });

  test("a stack push emits a navigation event and stamps the screen", async ({ screen }) => {
    // Act: push the Detail screen onto the stack.
    await screen.getByText("Go to Detail screen").tap();
    await expect(screen.getByText("Detail")).toBeVisible();

    // Assert: the push emits a navigation event naming the Detail screen.
    const navs = await waitForEvents("navigation", {
      where: (e) => String(screenName(e)).includes("Detail"),
    });
    expect(navs.length).toBeGreaterThan(0);

    // The screen holder must follow navigation BOTH ways, checked on an event that is not itself
    // a navigation: "some event carries a screen name" would be satisfied by the navigation
    // event three lines above, so it could not fail while the holder was stuck.
    //
    // The enricher stamps the screen as a NESTED object, not the dot-flattened key used for
    // event-owned attributes — read the object, since stringifying passes on "[object Object]".
    await screen.getByText("Back").tap();
    await clearEvents();
    await screen.getByText(/Increment counter/).tap();

    // Keyed on the label the well-tagged button reports (app.wellTaggedLabel): its visible
    // text for RN and Flutter, its accessibility label for the native apps.
    const [tapped] = await waitForEvents("interaction", {
      timeout: 30_000,
      where: (e) =>
        app.wellTaggedLabel.test(
          String((e.attributes as Record<string, unknown>)["interaction_target.label"] ?? "")
        ),
    });
    expect(tapped).toBeTruthy();
    const stamped = (tapped!.attributes as Record<string, unknown>)["screen"] as
      | { name?: string }
      | undefined;
    expect(stamped?.name).toBe("Home");
  });

  test("switching bottom tabs is tracked as navigation", async ({ screen }) => {
    // Act: switch to the Network tab, then to the Logs tab. Assert on
    // Network-screen content (unambiguous) rather than the tab label to confirm
    // the switch: the tab's own "Network" text is consumed into its accessibility
    // label on iOS, so getByText("Network") wouldn't confirm the switch there.
    await screen.getByLabel("Network tab").tap();
    await expect(screen.getByText("fetch GET")).toBeVisible();
    await screen.getByLabel("Logs tab").tap();

    // Assert on the TRANSITION, not on the destination. Every test cold-launches
    // the app, and the tracker stamps the landing screen immediately — so
    // "any navigation event" matches that initial stamp and passes with tab
    // tracking entirely dead. Keying on `from_screen` is what makes this a test
    // of the switch rather than of the launch.
    const [nav] = await waitForEvents("navigation", {
      timeout: 30_000,
      where: (e) => {
        const a = e.attributes as Record<string, unknown>;
        return screenName(e) === "Logs" && a["from_screen"] === "Network";
      },
    });
    expect(nav).toBeTruthy();

    const attrs = nav!.attributes as Record<string, unknown>;
    // Keys distinguish two visits to the same route; without them a user who
    // bounces between two tabs looks like one long visit.
    expect(screenKey(nav!)).not.toBe("");
    expect(String(attrs["from_key"] ?? "")).not.toBe("");
    expect(screenKey(nav!)).not.toBe(String(attrs["from_key"] ?? ""));

    // Time spent on the screen being left — the number the dwell-time charts
    // are built from. Measured, not defaulted: a 0 here reads as "nobody looked
    // at this screen", which is exactly wrong.
    const dwellMs = Number(attrs["duration_ms"] ?? -1);
    expect(dwellMs).toBeGreaterThan(0);
    expect(dwellMs).toBeLessThan(60_000);
  });
});
