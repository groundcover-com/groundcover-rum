import { test, expect } from "@mobilewright/test";
import { androidPidOf, androidReloadJs, androidThreadCount } from "../support/android-device";
import { BUNDLE_ID } from "../support/app";


// Every thread the engine owns, directly or through something it constructs.
//
// Counting only the HandlerThread would let the snapshot store's flush executor
// leak with the spec green, because it would not be looking at the other thread.
// A named list makes the omission visible the next time the engine acquires one.
const ENGINE_THREADS = ["gc-rum-engine", "gc-rum-snapshot-flush"];

// What the SDK leaves behind when RN tears its instance down. A `GcRumEngine` is
// constructed per React instance and starts a HandlerThread, and RN rebuilds that instance
// on every reload — so without a release, each recreation strands a thread and with it the
// chain Application -> ActivityLifecycleCallbacks -> tracker -> engine -> module -> the
// dead ReactApplicationContext.
//
// The thread count is the cheap, deterministic half: the retained context needs a heap
// dump, but the thread shows in `ps -T`, and a leak adds one per reload. In
// `zz-perturbing/` because it reloads the bundle repeatedly.
test.describe("rn-playground — engine teardown", { tag: "@rn-only" }, () => {
  test("releases the engine on React instance teardown, rather than stranding a thread per reload", async ({
    screen,
    platform,
  }) => {
    test.setTimeout(240_000);

    if (platform !== "android") {
      test.skip(true, "Android-specific: the HandlerThread and its release are Kotlin-side");
    }

    // Mobilewright relaunches the app before every test, and the engine is only
    // constructed once JS reaches the native module during init. Touch the UI
    // first so the baseline is measured against an initialized SDK rather than a
    // still-booting one.
    await screen.getByLabel("Native tab").tap();

    // A pid of 0 means the app is not running, and the counts below are vacuous.
    const pid = await androidPidOf(BUNDLE_ID);
    expect(pid).toBeGreaterThan(0);

    const before: Record<string, number> = {};
    for (const name of ENGINE_THREADS) {
      before[name] = await androidThreadCount(pid, name);
    }

    // The HandlerThread is created when the engine arms, so it must be up — a
    // baseline of zero there would make the comparison below trivially true.
    //
    // The snapshot store's executor is deliberately NOT asserted: it spawns its
    // thread only once a write has actually been PARKED, which needs two snapshot
    // updates inside the 500ms debounce, and nothing in this test controls that
    // timing. Its non-accumulation check below still catches the leak whenever the
    // thread exists, which is the only situation in which it can leak.
    expect(before["gc-rum-engine"]).toBeGreaterThan(0);

    const reloads = 3;
    for (let i = 0; i < reloads; i++) {
      await androidReloadJs(BUNDLE_ID);
      // Wait for the app to come back rather than sleeping blind: the reload has
      // to have completed for the next one to mean anything.
      await screen.getByLabel("Native tab").tap();
    }

    // Same process throughout — otherwise this would measure a restart, not a
    // teardown, and the count would reset for uninteresting reasons.
    expect(await androidPidOf(BUNDLE_ID)).toBe(pid);

    // The claim: no engine-owned thread accumulates across the reloads. A leak
    // would read `reloads + before` for that thread.
    const after: Record<string, number> = {};
    for (const name of ENGINE_THREADS) {
      after[name] = await androidThreadCount(pid, name);
    }

    // The HandlerThread is created when the engine arms, so its count is stable
    // and equality is the right assertion.
    expect(after["gc-rum-engine"]).toBe(before["gc-rum-engine"]);

    // The flush executor's thread is LAZY — it spawns only once a write has been
    // PARKED — and the reloads themselves can be what parks the first one. So a
    // baseline of 0 becoming 1 is legitimate creation, not a leak, and equality
    // would reject it as a flake.
    //
    // ONE is the real property. A leak is a thread per reload, so a broken
    // teardown reads `before + 3` here — which this bound still catches, while
    // lazy creation passes.
    expect(after["gc-rum-snapshot-flush"]).toBeLessThanOrEqual(1);
  });
});
