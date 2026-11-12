import { test, expect } from "@mobilewright/test";
import { expectEvents, sessionAttributes, settleAndClear } from "../support/ingest-client";
import { tapScrolling } from "../support/ui";

// accessibilityState / accessibilityValue / coordinates — three fields the
// interaction wire type declares and the SDK captures, checked here on device.
// The masking rule differs per field: the state flags and the numeric value fields
// are structural and never masked, while `value.text` is human-readable and is
// masked like a label (asserted under mask-all in zz-perturbing/privacy-configs).
test.describe("rn-playground — accessibility metadata", { tag: "@rn-only" }, () => {
  test("a tap carries accessibilityState, accessibilityValue and plausible coordinates", async ({
    screen,
  }) => {
    test.setTimeout(120_000);

    await settleAndClear();
    await tapScrolling(screen, /A11y annotated/);

    const [tap] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)["interaction_target.label"] ?? "").includes(
          "A11y annotated"
        ),
      describe: "the tap on the annotated control",
    });
    const attrs = tap!.attributes as Record<string, unknown>;

    // State flags survive as BOOLEANS, not stringified. A flattener that coerced
    // them would give the backend "true"/"false" strings, which every filter on
    // this field would then silently miss.
    expect(attrs["interaction_target.state.selected"]).toBe(true);
    expect(attrs["interaction_target.state.expanded"]).toBe(true);

    // The value block, numeric fields intact.
    expect(attrs["interaction_target.value.min"]).toBe(0);
    expect(attrs["interaction_target.value.max"]).toBe(100);
    expect(attrs["interaction_target.value.now"]).toBe(42);
    // Present in full at the default privacy level — the negative of this (masked
    // to "***" under mask-all) is what makes the pair meaningful.
    expect(String(attrs["interaction_target.value.text"] ?? "")).toBe("forty two percent");

    // Coordinates, bounded by the device's OWN reported screen size rather than by
    // a magic number. This is the assertion that catches a dp/px confusion: the
    // SDK documents these as device-independent pixels, and reporting raw device
    // pixels on a 3x display puts them outside the screen it also reports.
    const session = await sessionAttributes();
    const metrics = (session?.device as { screen?: { width?: number; height?: number } })?.screen;
    const width = Number(metrics?.width ?? 0);
    const height = Number(metrics?.height ?? 0);
    expect(width).toBeGreaterThan(200);

    const x = Number(attrs["interaction_coordinates.x"] ?? NaN);
    const y = Number(attrs["interaction_coordinates.y"] ?? NaN);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x).toBeLessThanOrEqual(width);
    expect(y).toBeLessThanOrEqual(height);
  });

  test("an input event carries no coordinates", async ({ screen }) => {
    test.setTimeout(120_000);

    await settleAndClear();

    // The wire type is explicit that taps carry coordinates and text edits do not
    // — "an input event has no coordinates at all". Worth pinning because the two
    // kinds share one attribute shape, so the difference is a convention rather
    // than something the types enforce, and a where-was-it leak on an input event
    // is a privacy-adjacent regression (it locates the keyboard, and with it the
    // field the user was typing into).
    await screen.getByLabel("Search field").fill("coordinates check");
    await screen.pressButton("ENTER");
    await screen.getByLabel("Private action").tap();

    const [input] = await expectEvents("interaction", {
      timeout: 30_000,
      where: (e) => (e.attributes as Record<string, unknown>)["interaction_type"] === "input",
      describe: "the input event",
    });
    const attrs = input!.attributes as Record<string, unknown>;
    expect(attrs["interaction_coordinates.x"]).toBeUndefined();
    expect(attrs["interaction_coordinates.y"]).toBeUndefined();
  });
});
