import { test, expect } from "@mobilewright/test";
import {
  expectEvents,
  getEvents,
  screenName,
  settleAndClear,
  waitForEvents,
} from "../support/ingest-client";
import { tapScrolling } from "../support/ui";

// Screens from each native toolkit. Detail is a UIKit view controller on iOS and a Fragment on
// Android, which the SDK names through its automatic hook; the tabs are SwiftUI views and Compose
// destinations, which name themselves (groundcoverScreen, GroundcoverNavigationEffect).
// navigation.spec.ts covers the transitions every app shares. This pins what is native: each
// screen is reported once, though more than one mechanism can see it (a hosting controller, the
// Fragment's own callbacks beside the navigation effect), and is stamped on what happens on it.
test.describe("native — screens from each toolkit", { tag: "@native-app-only" }, () => {
  test("a pushed view controller or Fragment is one navigation, stamped on the taps on it", async ({
    screen,
  }) => {
    test.setTimeout(120_000);

    await settleAndClear();
    await screen.getByText("Go to Detail screen").tap();
    await expect(screen.getByText("Detail")).toBeVisible();

    const [nav] = await waitForEvents("navigation", {
      timeout: 30_000,
      where: (e) => screenName(e).includes("Detail"),
    });
    expect(nav).toBeTruthy();
    expect((nav!.attributes as Record<string, unknown>)["from_screen"]).toBe("Home");

    // A tap on the Detail screen carries it, so the automatic hook's name is the one events use.
    // By test id: the text "Back" also names the system navigation bar's back key on an emulator
    // with three-button navigation (CI's), which would go back without touching the app.
    await screen.getByTestId("detail-back").tap();
    const [back] = await waitForEvents("interaction", {
      timeout: 30_000,
      where: (e) => (e.attributes as Record<string, unknown>)["interaction_target.label"] === "Back",
    });
    expect(back).toBeTruthy();
    expect(screenName(back!)).toBe(screenName(nav!));

    // Read once the tap's batch is in, so a second report of the same push has arrived too.
    const intoDetail = (await getEvents()).filter(
      (e) => e.type === "navigation" && screenName(e).includes("Detail")
    );
    expect(intoDetail).toHaveLength(1);
  });

  test("a SwiftUI or Compose screen is reported once, by the name the app gave it", async ({
    screen,
  }) => {
    test.setTimeout(120_000);

    await settleAndClear();
    await screen.getByLabel("Custom tab").tap();
    await tapScrolling(screen, "sendCustomEvent");

    const [custom] = await waitForEvents("custom", { timeout: 30_000 });
    expect(custom).toBeTruthy();
    expect(screenName(custom!)).toBe("Custom");

    const intoCustom = (await getEvents()).filter(
      (e) => e.type === "navigation" && screenName(e) === "Custom"
    );
    expect(intoCustom).toHaveLength(1);
    expect((intoCustom[0]!.attributes as Record<string, unknown>)["from_screen"]).toBe("Home");
  });

  test("closing a modal flow with its own NavHost makes the screen under it current again", async ({
    screen,
    platform,
  }) => {
    test.skip(platform !== "android", "Android only: a Compose flow with its own NavHost");
    test.setTimeout(120_000);

    await screen.getByLabel("Native tab").tap();
    await expect(screen.getByLabel("Open checkout")).toBeVisible();
    await settleAndClear();

    // The checkout layer's own NavHost and GroundcoverNavigationEffect report its route.
    await screen.getByLabel("Open checkout").tap();
    await expect(screen.getByText("Cart")).toBeVisible();
    await expectEvents("navigation", {
      timeout: 30_000,
      where: (e) => screenName(e) === "Cart",
      describe: "the navigation into the checkout's Cart",
    });

    // Closing it navigates nothing in the app's NavHost, still on Native: the SDK alone makes
    // Native the screen again.
    await screen.getByLabel("Close checkout").tap();
    const [back] = await expectEvents("navigation", {
      timeout: 30_000,
      where: (e) => screenName(e) === "Native",
      describe: "the navigation back to Native as the checkout closes",
    });
    expect((back!.attributes as Record<string, unknown>)["from_screen"]).toBe("Cart");

    // And what happens on Native from then on carries it, not the closed checkout.
    await screen.getByLabel("Open modal").tap();
    const [tap] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) =>
        (e.attributes as Record<string, unknown>)["interaction_target.label"] === "Open modal",
      describe: "the tap on Open modal after the checkout closed",
    });
    expect(screenName(tap!)).toBe("Native");
    await screen.getByLabel("Close modal").tap();
  });
});
