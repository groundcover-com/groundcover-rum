import { test, expect } from "@mobilewright/test";

// Runs before every native spec so ONE failure names the cause instead of five sharing it.
// An unresolved native module errors nowhere — every native signal degrades to silence,
// which is correct in Expo Go and indistinguishable from an app that has not reported yet,
// so five specs fail on `expect(undefined).toBeTruthy()` saying nothing. Two ways this can
// happen: a wrong JS name (RCT_EXTERN_MODULE leaves js_name empty, and RN strips only
// RCT/RK prefixes, never a "Module" suffix), and a pod-level `#if DEBUG` that compiles the
// e2e triggers to no-ops.
//
// The playground distinguishes the two cases in its UI, so the check is a locator away.
test.describe("rn-playground — native preflight", { tag: "@native" }, () => {
  test("the native module is reachable on this build", async ({ screen }) => {
    await screen.getByLabel("Native tab").tap();

    // Blocking the main thread is the cheapest trigger that proves a real call
    // crossed the bridge: the other one crashes the app. It recovers on its own,
    // and the hang it produces is asserted properly in native-crash.spec.ts.
    await screen.getByLabel("Block main thread").tap();

    await expect(screen.getByText("hang: triggered")).toBeVisible();

    // Stated as its own assertion rather than left implicit in the one above:
    // this is the exact string the degradation path renders, and seeing it in a
    // failure report is the whole point of this spec.
    expect(await screen.getByText(/no native module/).exists()).toBe(false);
  });
});
