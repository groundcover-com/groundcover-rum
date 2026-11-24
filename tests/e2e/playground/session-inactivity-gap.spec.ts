import { expect, test } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, collectRumBatches } from "./utils";

/**
 * Guards against "events but no recording" ghost sessions: a tab idle past
 * the 30-minute window stops replay (bandwidth bound) but must NOT rotate the
 * session eagerly; the first user-activity event after the gap rotates the
 * session AND restarts replay for the returning user. An eager rotation would
 * leave the new session with events but no recording.
 *
 * Same mocked-clock shape as session-max-duration.spec.ts: page.clock freezes
 * timers/rAF, so the restarted replay's snapshot only emits when we advance
 * the clock; runFor (not fastForward) ticks rAF-driven snapshots.
 */
const BATCH_TIMEOUT_MS = 10_000;
// Mirrors SESSION_INACTIVITY_TIMEOUT_MS — the shared 30-minute idle window.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
// Clock time for a restarted recording to emit: page.clock freezes rrweb's
// timers/rAF, so its snapshot only lands while the clock advances. Not tied
// to rrweb's checkout interval (5 minutes).
const REPLAY_SETTLE_MS = 30_000;

test.describe("RUM SDK | Session inactivity gap", () => {
  test("rotates session id and resumes replay on the first activity after a 30-minute idle gap", async ({ page }) => {
    await page.clock.install({ time: new Date() });

    const requestBodies: any[] = collectRumBatches(page);

    await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");
    const playgroundPage = new PlaygroundPage(page);
    await playgroundPage.validatePage();

    // Session 1: start replay + send events, advance past batchTimeout to flush.
    const firstBatchPromise = page.waitForRequest(
      (r) => r.url().includes("json/rum"),
      { timeout: 30_000 }
    );
    await playgroundPage.startSessionReplay();
    await playgroundPage.sendCustomEvent();
    await playgroundPage.clickConsoleLog();
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await firstBatchPromise;
    await page.waitForTimeout(200);

    const beforeBatch = requestBodies[requestBodies.length - 1];
    const sessionIdBefore = beforeBatch?.sessionAttributes?.session_id;
    expect(sessionIdBefore, "first batch should have a session_id").toBeTruthy();

    // Idle past the 30-minute window: the replay-inactivity timer stops
    // recording, but rotation is lazy — no new session id is minted while the
    // user is away. (This jump also exceeds the playground's 60s cap; the gap
    // rotation runs first and refreshes the start time, so only one rotation
    // fires on the next event.)
    await page.clock.fastForward(INACTIVITY_TIMEOUT_MS + 60_000);

    // Anything after this with a different session id is the rotated session
    // (the rotation's own flush may still carry the OLD id).
    const postRotationCount = requestBodies.length;

    // The user "comes back": the first activity event rotates the session and
    // restarts replay — the behaviour under test.
    await playgroundPage.sendCustomEvent();
    await playgroundPage.clickConsoleLog();

    // Let the restarted recording emit its snapshot, then the batch/pool flush,
    // staying within one cap window so we don't re-rotate.
    await page.clock.runFor(REPLAY_SETTLE_MS + 2_000);
    await page.waitForTimeout(100);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);

    // Poll for a rotated-id batch carrying a replay event.
    let sessionIdAfter: string | undefined;
    let hasReplay = false;
    for (let i = 0; i < 30; i++) {
      const fresh = requestBodies
        .slice(postRotationCount)
        .filter(
          (b) => b?.sessionAttributes?.session_id && b.sessionAttributes.session_id !== sessionIdBefore
        );
      if (fresh.length) {
        sessionIdAfter = fresh[fresh.length - 1].sessionAttributes.session_id;
        hasReplay = fresh.some((b) =>
          b.events?.some((e: { type: string }) => e.type === EventType.REPLAY)
        );
        if (hasReplay) break;
      }
      await page.waitForTimeout(200);
    }

    expect(sessionIdAfter, "a batch with a rotated session id should arrive").toBeTruthy();
    expect(sessionIdAfter).not.toBe(sessionIdBefore);
    expect(hasReplay, "replay should resume under the new session id after the idle gap").toBeTruthy();
  });
});
