import { test, expect } from "@mobilewright/test";
import { clearEvents, waitForEvents } from "../support/ingest-client";
import { app } from "../support/app";

test.describe("rn-playground — tap interactions", () => {
  test.beforeEach(async () => {
    await clearEvents();
  });

  test("a tap on a well-tagged button is captured as a labeled interaction", async ({ screen }) => {
    // Arrange: locate the button by its accessible name — stable, unlike its
    // visible text which carries a "(tapped N)" counter.
    const button = screen.getByText(/Increment counter/);

    // Act: tap it.
    await button.tap();

    // Assert: the tap is captured as a labeled interaction.
    const [interaction] = await waitForEvents("interaction");
    expect(interaction).toBeTruthy();

    const attrs = interaction!.attributes as Record<string, unknown>;
    expect(attrs["interaction_type"]).toBe("tap");
    // The fiber walk labeled the tap from the button's text.
    expect(String(attrs["interaction_target.label"] ?? "")).not.toBe("");
    // No span_name: browser parity — only network events carry one.
    expect(interaction!.span_name).toBeUndefined();
    // Enriched target: accessibilityHint flows through on a real device...
    expect(String(attrs["interaction_target.hint"] ?? "")).toContain("counter");
    // ...and testID is not captured.
    expect(attrs["interaction_target.test_id"]).toBeUndefined();
    expect(attrs["interaction_touch_type"]).toBeUndefined();

    // The rest of what the fiber walk produces. A partial-walk regression —
    // React internals shift between versions, and this package tracks React 19
    // on RN 0.86 — leaves `label` intact, because it also resolves from the text
    // child, while quietly emptying everything that only the fiber tree knows.
    // Asserting the label alone would not notice.
    expect(attrs["interaction_target.role"]).toBe("button");

    // The app's OWN components have to reach the wire. `toContain(">")` would pass on a path made
    // entirely of React internals — say, a fiber walk that skipped plain function components
    // (`typeof "function"`) — and a separator assertion cannot tell those apart.
    // Only the playground's own tree is asserted, since React Navigation's outer plumbing is a
    // dependency's private shape and MAX_PATH_SEGMENTS keeps the INNERMOST segments. Where an
    // app's toolkit keeps component names at all (support/app.ts, tapComponents).
    if (app.tapComponents) {
      expect(attrs["interaction_target.component"]).toBe(app.tapComponents.component);
      const path = String(attrs["interaction_component_path"] ?? "");
      // Contiguous ("Card > Button"), so this pins nesting and order rather than mere presence;
      // and the walk reaches the screen ("HomeScreen"), not just the leaf it started from.
      for (const segment of app.tapComponents.pathIncludes) {
        expect(path).toContain(segment);
      }
    }
  });

  test("a dataPrivate button masks its label on-device (per-element opt-out)", async ({ screen }) => {
    // Arrange: locate the button by its accessibilityLabel. On iOS the a11y label
    // replaces the visible text for queries, so getByText won't find it — and
    // masking only affects the telemetry label, never the real a11y label.
    const button = screen.getByLabel("Private action");

    // Act: tap it.
    await button.tap();

    // Assert: the tap is captured but its label is masked — even under the
    // default privacy level, the accessibilityLabel never ships.
    const [interaction] = await waitForEvents("interaction", {
      where: (e) => (e.attributes as Record<string, unknown>)?.["interaction_type"] === "tap",
    });
    expect(interaction).toBeTruthy();
    const attrs = interaction!.attributes as Record<string, unknown>;
    expect(attrs["interaction_target.label"]).toBe("***");
    expect(JSON.stringify(interaction)).not.toContain("Private action");

    // The negative control, in the same run and under the same config. `label
    // === "***"` on its own is equally satisfied by masking that has become
    // global — every label redacted, the opt-out doing nothing, and the SDK
    // reporting interactions nobody can identify. Masking is only correct if it
    // is also SELECTIVE.
    await clearEvents();
    await screen.getByText(/Increment counter/).tap();
    const [visible] = await waitForEvents("interaction", {
      where: (e) => (e.attributes as Record<string, unknown>)["interaction_type"] === "tap",
    });
    expect(visible).toBeTruthy();
    // The label the well-tagged button reports (app.wellTaggedLabel): its visible text for RN
    // and Flutter, its accessibility label for the native apps.
    expect(
      String((visible!.attributes as Record<string, unknown>)["interaction_target.label"])
    ).toMatch(app.wellTaggedLabel);
  });

  test("a bare button still emits an interaction (degrades, never lost)", async ({ screen }) => {
    // Arrange: locate the button that has no accessibilityLabel, by its visible text.
    const button = screen.getByText("Bare button (no testID/label)");

    // Act: tap it.
    await button.tap();

    // Assert: even with no testID/accessibilityLabel, the tap is captured and
    // labeled from its visible text.
    const [interaction] = await waitForEvents("interaction", {
      where: (e) =>
        String((e.attributes as Record<string, unknown>)?.["interaction_target.label"] ?? "").includes(
          "Bare button"
        ),
    });
    expect(interaction).toBeTruthy();

    // Degrading means losing the ANNOTATIONS, not the structure. testID and
    // accessibilityLabel are absent here, but which component was pressed and
    // where it sits are read from the fiber tree and owe nothing to either — so
    // they must survive untouched. This is the case a partial-walk regression
    // hides in: the label still resolves from the visible text child, so a test
    // that checked only the label would stay green with the tree half-read.
    const bare = interaction!.attributes as Record<string, unknown>;
    if (app.tapComponents) {
      expect(bare["interaction_target.component"]).toBe(app.tapComponents.component);
      expect(String(bare["interaction_component_path"] ?? "")).toContain(
        app.tapComponents.pathIncludes[0]!
      );
    }
    // The annotations really are absent — otherwise the above proves nothing
    // about degradation.
    expect(bare["interaction_target.test_id"]).toBeUndefined();
  });

  test("editing a text field emits one labeled `input` interaction — never the typed value", async ({
    screen,
  }) => {
    // Arrange: wait for the app to be up before touching anything. Run as the
    // first test in a worker (a CI retry does exactly that), this races the cold
    // launch: `app_start_cold` can arrive AFTER this test's clearEvents(), i.e. the
    // app is still starting while the field is being filled. Longer than the 20s
    // default because a cold launch reloads the JS bundle from Metro.
    await expect(screen.getByText("Taps")).toBeVisible({ timeout: 60_000 });

    // Locate the field (by its accessibilityLabel on RN) and pick a secret value.
    const secret = "hunter2@example.com";
    const field = app.searchField(screen);

    // Act: fill() taps the field to focus it (a real touch, which is also what
    // signals user presence to the SDK) and types real key events. Proves the
    // global TextInput patch works on the real renderer (analogue of the tap
    // specs).
    await field.fill(secret);

    // End the edit TWO ways — ENTER (single-line, so onSubmitEditing) and a tap on a control
    // above it, which RN's ScrollView turns into a blur. The SDK collapses end-of-edit events
    // into one interaction, so both cannot double-report. The documented BACK workaround for
    // `fill()` leaving the keyboard up (mobile-next/mobilewright#154) is NOT usable: on
    // Android BACK hides the IME while the EditText keeps focus, so no blur fires.
    //
    // The tap uses an EXACT getByLabel on a hint-free button, since regex resolution is
    // unreliable while the keyboard is up. If this reddens, check the field's real state
    // (`uiautomator dump` → `text=`, `focused=`) before touching the sequence.
    await screen.pressButton("ENTER");
    await screen.getByLabel("Private action").tap();

    // Assert: exactly one labeled `input` interaction, and the typed value leaks nowhere.
    const [input] = await waitForEvents("interaction", {
      where: (e) => (e.attributes as Record<string, unknown>)?.["interaction_type"] === "input",
    });
    expect(input).toBeTruthy();

    const attrs = input!.attributes as Record<string, unknown>;
    expect(attrs["interaction_type"]).toBe("input");
    // Labeled from accessibilityLabel via the fiber walk.
    expect(attrs["interaction_target.label"]).toBe("Search field");
    // No span_name: interactions mirror the browser's dom.event, which carries
    // one only for network events. Identity is interaction_type + target label.
    expect(input!.span_name).toBeUndefined();

    // Privacy contract: the typed value must appear NOWHERE on the event.
    expect(JSON.stringify(input)).not.toContain(secret);
  });
});
