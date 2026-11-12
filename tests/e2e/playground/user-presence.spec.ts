import { expect, test, type Page } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType } from "./utils";

/**
 * UserPresenceMonitor coverage with REAL browser input (page.mouse), not
 * synthetic dispatchEvent — the passive capture window listeners, input event
 * timing, and the 30s presence throttle behave differently in real browsers
 * than in jsdom, so these paths need e2e exercise:
 *
 * 1. Raw-input-only engagement (mouse movement, zero clicks) keeps the
 *    session alive — no spurious gap rotation mid-engagement.
 * 2. After an idle gap, raw input ALONE rotates the session and revives
 *    replay — no click required.
 * 3. An explicit stopReplayRecording() survives the gap: the session still
 *    rotates, but no presence signal may turn recording back on.
 *
 * The playground's 60s sessionMaxDuration would mask gap behavior (any
 * post-cap signal rotates), so each test raises the cap to 8h first —
 * after that, only the inactivity gap can explain a rotation.
 *
 * Mocked-clock mechanics are the same as session-inactivity-gap.spec.ts:
 * page.clock freezes timers/rAF, so rrweb snapshots and pool flushes only
 * happen when we advance the clock (runFor ticks rAF; fastForward doesn't).
 */
const BATCH_TIMEOUT_MS = 10_000;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
// Clock time for a restarted recording to emit: page.clock freezes rrweb's
// timers/rAF, so its snapshot only lands while the clock advances. Not tied
// to rrweb's checkout interval (5 minutes).
const REPLAY_SETTLE_MS = 30_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

type CapturedBatch = {
  sessionAttributes?: { session_id?: string };
  events?: Array<{ type: string }>;
};

function captureRumBatches(page: Page): CapturedBatch[] {
  const batches: CapturedBatch[] = [];
  page.on("request", (request) => {
    if (request.url().includes("json/rum")) {
      try {
        batches.push(JSON.parse(request.postData() || "{}"));
      } catch {
        /* ignore parse errors */
      }
    }
  });
  return batches;
}

// Boot the playground with a frozen clock, start replay, flush a first batch,
// raise the cap so only the gap can rotate, and return the original session id.
async function bootWithReplay(page: Page, playgroundPage: PlaygroundPage, batches: CapturedBatch[]): Promise<string> {
  await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");
  await playgroundPage.validatePage();

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

  // After validatePage's Update Config clicks, so the merge keeps our cap.
  await playgroundPage.callGroundcoverMethod("updateConfig", {
    options: { sessionMaxDuration: EIGHT_HOURS_MS },
  });

  const sessionId = batches[batches.length - 1]?.sessionAttributes?.session_id;
  expect(sessionId, "boot batch should carry a session_id").toBeTruthy();
  return sessionId!;
}

test.describe("RUM SDK | User presence", () => {
  test("mouse-only engagement keeps the session alive — no gap rotation without a single click", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const batches = captureRumBatches(page);
    const playgroundPage = new PlaygroundPage(page);
    const sessionIdBefore = await bootWithReplay(page, playgroundPage, batches);

    // 40 minutes of passive engagement: real mouse movement every 5 minutes,
    // zero clicks. Each movement is raw-input presence — the activity clock
    // keeps moving and no inactivity gap ever opens.
    for (let i = 0; i < 8; i++) {
      await page.clock.fastForward(5 * 60 * 1000);
      await page.mouse.move(100 + i * 17, 120 + i * 11);
      await page.mouse.move(140 + i * 17, 160 + i * 11);
      // Tick so rrweb's sampled mousemove emit and the presence handler run.
      await page.clock.runFor(1_000);
    }

    // A real click after the passive stretch — still the same session.
    await playgroundPage.sendCustomEvent();
    await page.clock.runFor(REPLAY_SETTLE_MS + 2_000);
    await page.waitForTimeout(100);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);
    await page.waitForTimeout(300);

    const sessionIds = new Set(
      batches.map((b) => b?.sessionAttributes?.session_id).filter(Boolean)
    );
    expect([...sessionIds], "no rotation: every batch carries the original session id").toEqual([sessionIdBefore]);

    // And replay kept flowing during/after the passive stretch.
    const hasLateReplay = batches
      .slice(1)
      .some((b) => b.events?.some((e) => e.type === EventType.REPLAY));
    expect(hasLateReplay, "replay should keep recording through mouse-only engagement").toBeTruthy();
  });

  test("after an idle gap, raw input alone rotates the session and revives replay — no click required", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const batches = captureRumBatches(page);
    const playgroundPage = new PlaygroundPage(page);
    const sessionIdBefore = await bootWithReplay(page, playgroundPage, batches);

    // Idle past the window: replay pauses; rotation is lazy — nothing happens
    // while the user is away (cap is 8h, so it can't be the rotator here).
    await page.clock.fastForward(INACTIVITY_TIMEOUT_MS + 60_000);
    const postIdleCount = batches.length;

    // The user "comes back" by only moving the mouse — never clicking.
    await page.mouse.move(200, 200);
    await page.mouse.move(260, 240);
    await page.clock.runFor(REPLAY_SETTLE_MS + 2_000);
    await page.waitForTimeout(100);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);

    let sessionIdAfter: string | undefined;
    let hasReplay = false;
    for (let i = 0; i < 30; i++) {
      const fresh = batches
        .slice(postIdleCount)
        .filter(
          (b) => b?.sessionAttributes?.session_id && b.sessionAttributes.session_id !== sessionIdBefore
        );
      if (fresh.length) {
        sessionIdAfter = fresh[fresh.length - 1].sessionAttributes!.session_id;
        hasReplay = fresh.some((b) =>
          b.events?.some((e) => e.type === EventType.REPLAY)
        );
        if (hasReplay) break;
      }
      await page.waitForTimeout(200);
    }

    expect(sessionIdAfter, "mouse movement after the gap should rotate the session").toBeTruthy();
    expect(sessionIdAfter).not.toBe(sessionIdBefore);
    expect(hasReplay, "replay should revive from raw input alone").toBeTruthy();
  });

  test("a programmatic startReplayRecording into an idle-gapped tab records under a fresh session, never the stale one", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const batches = captureRumBatches(page);
    const playgroundPage = new PlaygroundPage(page);
    const sessionIdBefore = await bootWithReplay(page, playgroundPage, batches);

    // Idle past the window: replay pauses, session rotation stays lazy. The
    // pause flushes a final batch of PRE-gap frames under session A (correct) —
    // let it drain before sampling, so the slice below contains only what the
    // programmatic start produces.
    await page.clock.fastForward(INACTIVITY_TIMEOUT_MS + 60_000);
    await page.waitForTimeout(500);
    const postStartCount = batches.length;

    // App restarts replay PROGRAMMATICALLY (not via a click). rrweb must not begin
    // under the stale session — the gap is resolved first — and frames are withheld
    // by the gate until the input below confirms the fresh session, never the stale.
    await page.evaluate(() => window.groundcover!.startReplayRecording!());
    // The user returns (raw input) → confirms the fresh session → replay flushes.
    await page.mouse.move(250, 250);
    await page.mouse.move(300, 280);
    await page.clock.runFor(REPLAY_SETTLE_MS + 2_000);
    await page.waitForTimeout(100);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);

    // Poll for replay batches produced after the programmatic start.
    let replayAfter: CapturedBatch[] = [];
    for (let i = 0; i < 30 && replayAfter.length === 0; i++) {
      replayAfter = batches
        .slice(postStartCount)
        .filter((b) => b.events?.some((e) => e.type === EventType.REPLAY));
      if (replayAfter.length === 0) await page.waitForTimeout(200);
    }

    expect(replayAfter.length, "replay should record after the programmatic start").toBeGreaterThan(0);
    // The core guarantee: no replay frame recorded after the start is attributed
    // to the stale (pre-gap) session.
    const staleReplay = replayAfter.filter(
      (b) => b.sessionAttributes?.session_id === sessionIdBefore
    );
    expect(staleReplay.length, "no replay should land under the stale session").toBe(0);
  });

  test("explicit stopReplayRecording survives the gap — session rotates, recording stays off", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const batches = captureRumBatches(page);
    const playgroundPage = new PlaygroundPage(page);
    const sessionIdBefore = await bootWithReplay(page, playgroundPage, batches);

    // The app explicitly turns replay off — the privacy guarantee under test.
    await playgroundPage.stopSessionReplay();
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);

    // Idle past the window, then a full return: movement AND clicks.
    await page.clock.fastForward(INACTIVITY_TIMEOUT_MS + 60_000);
    const postIdleCount = batches.length;
    await page.mouse.move(220, 180);
    await playgroundPage.sendCustomEvent();
    await playgroundPage.clickConsoleLog();

    // Give a revived recording every chance to emit and flush before the
    // negative assertion (two settle + batch windows).
    for (let i = 0; i < 2; i++) {
      await page.clock.runFor(REPLAY_SETTLE_MS + 2_000);
      await page.waitForTimeout(100);
      await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);
    }

    // Poll for the rotated-id batch (delivery timing varies per browser) …
    const freshBatches = () =>
      batches
        .slice(postIdleCount)
        .filter(
          (b) => b?.sessionAttributes?.session_id && b.sessionAttributes.session_id !== sessionIdBefore
        );
    let fresh: CapturedBatch[] = [];
    for (let i = 0; i < 30 && fresh.length === 0; i++) {
      fresh = freshBatches();
      if (fresh.length === 0) await page.waitForTimeout(200);
    }
    const sessionIdAfter = fresh[fresh.length - 1]?.sessionAttributes?.session_id;

    // … then one more full window so a (wrongly) revived recording would have
    // flushed too, before the negative assertion.
    await page.clock.runFor(REPLAY_SETTLE_MS + BATCH_TIMEOUT_MS + 3_000);
    await page.waitForTimeout(300);
    const hasReplay = freshBatches().some((b) =>
      b.events?.some((e) => e.type === EventType.REPLAY)
    );

    expect(sessionIdAfter, "the gap should still rotate the session").toBeTruthy();
    expect(sessionIdAfter).not.toBe(sessionIdBefore);
    expect(hasReplay, "no presence signal may revive an explicitly stopped replay").toBeFalsy();
  });
});
