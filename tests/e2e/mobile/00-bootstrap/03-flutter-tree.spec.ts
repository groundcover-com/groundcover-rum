import { test, expect } from "@mobilewright/test";

// The locator idioms the suite relies on, checked against the Flutter app's tree before any
// spec depends on them, and the tree dump that explains a red one.
//
// Which tree mobilecli reads for a debug build: the Dart VM service's when its in-app agent
// loads (the iOS simulator, an arm64 Android emulator), the native accessibility tree otherwise
// (CI's x86_64 emulators, where mobilecli ships no agent). These run on both, and the dump says
// which one a run got.
test.describe("flutter — the tree the harness reads", { tag: "@flutter-only" }, () => {
  test("dump the tree, for diagnosing any red spec in this run", async ({ screen }, testInfo) => {
    await screen.getByLabel("Taps tab").tap();
    const tree = await screen.viewTree();
    await testInfo.attach("view-tree.json", {
      body: JSON.stringify(tree, null, 2),
      contentType: "application/json",
    });
    expect(tree.length).toBeGreaterThan(0);
  });

  test("a label set with Text(semanticsLabel:) replaces the visible text", async ({ screen }) => {
    await screen.getByLabel("Taps tab").tap();
    // RN's accessibilityLabel idiom: the specs find these by label, never by their text.
    await expect(screen.getByLabel("Private action")).toBeVisible();
    await expect(screen.getByText(/Increment counter/)).toBeVisible();
  });

  test("a Semantics identifier finds a text field, which takes typed text", async ({ screen }) => {
    await screen.getByLabel("Taps tab").tap();
    const field = screen.getByTestId("home-text-input");
    await field.fill("tree probe");
    await expect(field).toHaveValue("tree probe");
  });

  test("a FilledButton is a button by role", async ({ screen }) => {
    await screen.getByLabel("Taps tab").tap();
    await expect(screen.getByRole("button", { name: "Go to Detail screen" })).toBeVisible();
  });
});
