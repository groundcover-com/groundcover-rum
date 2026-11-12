import { test, expect } from "@mobilewright/test";
import { clearEvents, waitForEvents, sessionAttributes } from "../support/ingest-client";
import { androidProp } from "../support/android-device";
import { app as profile } from "../support/app";

// Baseline: the app launches, a tap is captured as an `interaction` event, and
// the batch carries the RN session envelope. This is the on-device counterpart
// to the wire-format golden test, proving the whole path (real app → real SDK →
// ingest) works, independently of any feature-specific spec.
test.describe("rn-playground — sanity", () => {
  test.beforeEach(async () => {
    await clearEvents();
  });

  test("captures a tap as an interaction event with the mobile-rum envelope", async ({
    screen,
    platform,
  }) => {
    // Longer than the 20s default on purpose: this is a readiness gate, not a feature assertion.
    // The fixture relaunches the app before each test, and a relaunched app has to reload its
    // bundle from Metro before anything renders; at 20s a full-suite run can catch the app still
    // booting rather than broken.
    await expect(screen.getByText("Taps")).toBeVisible({ timeout: 60_000 });
    const button = screen.getByText(/Increment counter/);

    // Act: tap it.
    await button.tap();

    // Keyed on THIS tap: waiting for "any interaction" would let a batch straggling in from the
    // previous spec become the event under test. The predicate matches the label the event
    // actually carries, read off the wire: the button's visible TEXT for RN and Flutter (by
    // prefix, since the counter increments across runs), its accessibility label for the native
    // apps (profile.wellTaggedLabel).
    const interactions = await waitForEvents("interaction", {
      where: (e) => {
        const a = e.attributes as Record<string, unknown>;
        return (
          a["interaction_type"] === "tap" &&
          profile.wellTaggedLabel.test(String(a["interaction_target.label"] ?? ""))
        );
      },
    });
    expect(interactions.length).toBeGreaterThan(0);

    const attrs = interactions[0]?.attributes as Record<string, unknown>;
    expect(attrs["interaction_type"]).toBe("tap");
    // The label itself is pinned by the `where` predicate above, so re-asserting
    // it here would be vacuous. Assert instead that the fiber walk produced the
    // rest of the target — a partial walk still yields a label (it also resolves
    // from the text child) while everything only the fiber tree knows comes back
    // empty, so the label alone cannot tell a healthy walk from a broken one.
    if (profile.tapComponents) {
      expect(attrs["interaction_target.component"]).toBe(profile.tapComponents.component);
    }
    expect(attrs["interaction_target.role"]).toBe("button");

    // ...and the batch carries the mobile-rum session envelope: fixed
    // SDK-family stamp + platform in os/device.
    const session = await sessionAttributes();
    expect(session?.source).toBe("mobile-rum");
    // Pinned to the project that is RUNNING, not to "one of the two". A
    // misconfigured lane that quietly ran the same platform twice — or a device
    // reporting the wrong OS — passes a `/ios|android/` match while half the
    // matrix goes untested, and the suite has no other way to notice. It is also
    // the invariant the foreign-reporter guard leans on to tell someone else's
    // batches from ours.
    expect((session?.os as { name?: string })?.name).toBe(platform);
    // The device identity, checked for VALUE rather than presence.
    //
    // `toBeTruthy()` would not do: `"unknown"` is truthy. RN's iOS Platform.constants carries no
    // model at all, so the value comes from the native module's `uname()`, and a missing model
    // shows up as that fallback sentinel. Rejecting it explicitly is the minimum.
    const device = session?.device as { model?: string; brand?: string } | undefined;
    const model = String(device?.model ?? "");
    expect(model).not.toBe("unknown");
    expect(model.length).toBeGreaterThan(0);

    if (platform === "android") {
      // Compared against the DEVICE's own build properties, which the SDK had no hand in
      // producing. Non-empty-and-not-"unknown" still passes on a hardcoded string or a constant
      // that has drifted from the hardware; `getprop` is the only source here that can catch a
      // model which is present and wrong.
      const [expectedModel, expectedBrand] = await Promise.all([
        androidProp("ro.product.model"),
        androidProp("ro.product.brand"),
      ]);
      // Guard the guard: an unreadable getprop would make both assertions below vacuous, and this
      // spec would go green having compared nothing to nothing. Both props are guarded — a bare
      // `if (expectedBrand)` would let an unreadable brand skip its own check silently, which
      // is the one failure this guard exists to catch.
      expect(expectedModel).not.toBe("");
      expect(expectedBrand).not.toBe("");
      expect(model).toBe(expectedModel);
      expect(String(device?.brand ?? "")).toBe(expectedBrand);
    }

    if (platform === "ios") {
      // The hardware identifier form, e.g. `iPhone17,1` — there is no simctl value that maps to it
      // directly, so the shape is what can be asserted. A simulator reports the SIMULATED device
      // rather than the host, which matters: `utsname.machine` alone yields the host architecture,
      // so the two rejections below are the specific wrong answers this can produce.
      expect(model).toMatch(/^(iPhone|iPad|iPod)\d+,\d+$/);
      expect(["arm64", "x86_64"]).not.toContain(model);
      expect(String(device?.brand ?? "")).toBe("Apple");
    }
    expect(String((session?.os as { version?: string })?.version ?? "")).not.toBe("");

    // Release attribution, which arrives through an OPTIONAL require of
    // expo-constants. Metro's optional-dependency resolution is exactly the kind
    // of thing that works in CI and not in a customer's monorepo, and the
    // failure is silent: sessions keep flowing, they just stop being attributable
    // to a build. Unit tests stub react-native wholesale, so only a device
    // exercises the real require.
    const app = session?.app as { id?: string; version?: string } | undefined;
    expect(app?.id).toBe(profile.appId);
    expect(String(app?.version ?? "")).toMatch(/^\d+\.\d+/);

    // Real screen metrics, not the {0,0,1,1} fallback the platform layer
    // substitutes when Dimensions throws — a plausible-looking envelope carrying
    // numbers nothing can be computed from.
    const screenMetrics = (session?.device as { screen?: { width?: number; scale?: number } })
      ?.screen;
    expect(Number(screenMetrics?.width ?? 0)).toBeGreaterThan(200);
    expect(Number(screenMetrics?.scale ?? 0)).toBeGreaterThanOrEqual(1);
  });
});
