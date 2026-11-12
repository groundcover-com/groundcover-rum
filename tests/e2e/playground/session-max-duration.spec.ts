import { expect, test } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType } from "./utils";

/**
 * Drives rotation against the playground's 60s cap with a mocked clock.
 *
 * Rotation is lazy — advancing the clock alone never rotates; the first event
 * AFTER the cap does. And page.clock freezes timers/rAF, so the restarted
 * replay's snapshot only emits when we advance the clock. Hence the shape:
 * fast-forward just past the cap → emit an event (rotates) → advance so the
 * restarted recording emits, then past the batch timeout to flush replay under
 * the new id.
 * Avoids modal/dialog flows (e.g. simulateClickEvent) whose frozen
 * transitions would hang.
 */
const BATCH_TIMEOUT_MS = 10_000;
// Matches apps/playground/src/main.tsx — the playground configures the 1-minute
// minimum so the cap is cheap to cross in a test.
const SESSION_MAX_DURATION_MS = 60_000;
// Clock time for a restarted recording to emit: page.clock freezes rrweb's
// timers/rAF, so its snapshot only lands while the clock advances. Not tied
// to rrweb's checkout interval (5 minutes).
const REPLAY_SETTLE_MS = 30_000;

test.describe("RUM SDK | Session max duration", () => {
  test("rotates session id when sessionMaxDuration is exceeded, and resumes replay", async ({ page }) => {
    await page.clock.install({ time: new Date() });

    const requestBodies: any[] = [];
    page.on("request", (request) => {
      if (request.url().includes("json/rum")) {
        try {
          requestBodies.push(JSON.parse(request.postData() || "{}"));
        } catch {
          /* ignore parse errors */
        }
      }
    });

    await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");
    const playgroundPage = new PlaygroundPage(page);
    await playgroundPage.validatePage();

    // Session 1: start replay + send events, advance past batchTimeout to flush.
    // Register the request promise BEFORE the action so we don't race a flush
    // that already fired during page load / validatePage.
    const firstBatchPromise = page.waitForRequest(
      (r) => r.url().includes("json/rum"),
      { timeout: 30_000 }
    );
    await playgroundPage.startSessionReplay();
    await playgroundPage.sendCustomEvent();
    await playgroundPage.clickConsoleLog();
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await firstBatchPromise;
    // Allow the response handler to push into requestBodies.
    await page.waitForTimeout(200);

    const beforeBatch = requestBodies[requestBodies.length - 1];
    const sessionIdBefore = beforeBatch?.sessionAttributes?.session_id;
    expect(sessionIdBefore, "first batch should have a session_id").toBeTruthy();

    // Just past the cap — NOT hours: a big jump would also trip the 30-min
    // replay-inactivity timer first, turning replay off before the max-duration
    // rotation can resume it. No rotation fires yet (lazy).
    await page.clock.fastForward(SESSION_MAX_DURATION_MS + 5_000);

    // Anything after this with a different session id is the rotated session
    // (the rotation's own flush may still carry the OLD id).
    const postRotationCount = requestBodies.length;

    // First post-cap event triggers rotation; replay was active so it resumes.
    await playgroundPage.sendCustomEvent();
    await playgroundPage.clickConsoleLog();

    // Let the restarted recording emit its snapshot, then the batch/pool flush,
    // within one cap window so we don't re-rotate. runFor (not fastForward)
    // ticks the clock so rrweb's rAF-driven snapshot fires (notably on WebKit).
    await page.clock.runFor(REPLAY_SETTLE_MS + 2_000);
    await page.waitForTimeout(100);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);

    // Poll for a rotated-id batch carrying a replay event (id is stable here).
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
    expect(hasReplay, "replay should resume under the new session id").toBeTruthy();
  });
});
