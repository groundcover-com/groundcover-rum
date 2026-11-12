import { test, expect } from "@mobilewright/test";
import { getEvents, settleAndClear } from "../support/ingest-client";
import { describeReporters, findForeignReporters } from "../support/foreign-reporter";
import { BUNDLE_ID } from "../support/app";

// Fails the run when a device OTHER than the one under test is posting to the mock ingest.
// A playground left running on a booted simulator keeps POSTing to localhost:9393, and a
// simulator's `localhost` IS the host's, so it reaches every Android run's ingest too.
//
// Positive assertions shrug that off; NEGATIVE ones cannot, and their failure would point at
// the SDK rather than the room.
//
// The tell is the session envelope, in TWO readings — `os.name` for a cross-platform
// intruder, and the session id for a same-platform one, which reports the same `os.name`
// and cannot be told apart by `device.model`. See `support/foreign-reporter.ts`.
test.describe("rn-playground — environment", () => {
  test("no other device is reporting to the mock ingest", async ({ platform }) => {
    test.setTimeout(60_000);

    await settleAndClear();

    // Watch without touching anything. A foreign reporter is by definition not
    // driven by this suite, so it announces itself on its own schedule — an idle
    // window is exactly when it shows up, and this one spans many of a reporting
    // app's batch flushes.
    await new Promise((r) => setTimeout(r, 8_000));

    // Both kinds of intruder: another PLATFORM and another device on THIS one,
    // which reports the same `os.name` and does the same damage. See
    // findForeignReporters for why a second session id in this window can only be
    // someone else.
    const foreign = findForeignReporters(await getEvents(), platform);

    if (foreign.length > 0) {
      const seen = describeReporters(foreign);
      throw new Error(
        `Another device is POSTing to the mock ingest while the ${platform} suite runs.\n` +
          `  foreign batches from: ${seen}\n` +
          `  Every negative assertion in this suite is unreliable until it stops.\n` +
          `  Usual cause: a playground build still running on a booted simulator/emulator\n` +
          `  (a simulator shares the host's localhost, so it reaches :9393 too — and a\n` +
          `  spare device on THIS platform reaches it the same way).\n` +
          `  Fix: xcrun simctl terminate <udid> ${BUNDLE_ID}   # a playground on a simulator\n` +
          `       xcrun simctl shutdown <spare-udid>  # and/or shut the spare device down\n` +
          `       adb -s <other> shell am force-stop ${BUNDLE_ID}`
      );
    }

    // Nothing to assert beyond the guard above; stated so the spec reads as a
    // check rather than as an empty test.
    expect(foreign).toHaveLength(0);
  });
});
