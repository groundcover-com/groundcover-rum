import { expect, test } from "@playwright/test";
import PlaygroundPage from "./playground.page";

/**
 * The downstream contract, asserted on the real wire in a real browser: a batch
 * must never claim its session started AFTER an event it carries.
 *
 * Consumers derive session duration from last event − session_start_time, so
 * an inverted pair yields a negative duration.
 *
 * Scope of this spec, stated plainly: it is a REGRESSION GUARD on the wire, not
 * a reproduction of the millisecond interleave that can invert the pair.
 * page.clock freezes time, so the enricher's stamp and the rotation's stamp read
 * the same Date.now(), and a clock-derived start would equal the triggering
 * event's timestamp — equal, not later. Reproducing the sub-millisecond
 * ordering is the unit tier's job (session-lifecycle.test.ts, which pins the
 * derivation to the event rather than the clock).
 *
 * What this DOES catch, and what nothing below the e2e tier can: a rotation
 * shipping a start that postdates events already queued in the pool, across the
 * real built bundle, the real gzip/transport path and a real cap rotation.
 *
 * One path is NOT reachable from here: the retained-buffer candidate, where a
 * rotation adopts an event the drain left behind. That needs `cluster` to be
 * absent so flush() returns without draining, and the playground always
 * configures one — so the drain always succeeds and the pool is empty by the
 * time the start is derived. That path is covered in
 * packages/core/ts/src/session/session-lifecycle.test.ts.
 */

const BATCH_TIMEOUT_MS = 10_000;
// Matches apps/playground/src/main.tsx — the 1-minute minimum, so the cap is
// cheap to cross.
const SESSION_MAX_DURATION_MS = 60_000;

type Batch = {
  sessionAttributes?: { session_id?: string; session_start_time?: number };
  events?: Array<{ type: string; timestamp?: number; start_timestamp?: number }>;
};

// network events carry start_timestamp instead of timestamp; both are ns.
function eventTimes(batch: Batch): number[] {
  return (batch.events ?? [])
    .map((event) => event.timestamp ?? event.start_timestamp)
    .filter((time): time is number => typeof time === "number");
}

test.describe("RUM SDK | session_start_time ordering", () => {
  test("never ships a batch whose session started after an event it carries", async ({ page }) => {
    await page.clock.install({ time: new Date() });

    const batches: Batch[] = [];
    page.on("request", (request) => {
      if (request.url().includes("json/rum")) {
        try {
          batches.push(JSON.parse(request.postData() || "{}") as Batch);
        } catch {
          /* ignore parse errors */
        }
      }
    });

    await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");
    const playgroundPage = new PlaygroundPage(page);
    await playgroundPage.validatePage();

    // Session 1. Register the request promise BEFORE the action so we don't race
    // a flush that already fired during page load / validatePage.
    const firstBatchPromise = page.waitForRequest((r) => r.url().includes("json/rum"), {
      timeout: 30_000,
    });
    await playgroundPage.sendCustomEvent();
    await playgroundPage.clickConsoleLog();
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await firstBatchPromise;
    await page.waitForTimeout(200);

    const sessionIdBefore = batches.at(-1)?.sessionAttributes?.session_id;
    expect(sessionIdBefore, "first batch should have a session_id").toBeTruthy();

    // Leave an event BUFFERED across the cap, so the rotation happens with the
    // pool non-empty rather than against a freshly drained one. dom.event is in
    // EVENTS_TO_SKIP_FLUSH, so it does not trigger a size flush.
    await playgroundPage.clickConsoleLog();

    // setSystemTime, not fastForward: it moves the wall clock past the cap
    // WITHOUT running timers, so the batch heartbeat can't drain the buffer
    // first. No rotation fires yet either — rotation is lazy.
    await page.clock.setSystemTime(new Date(Date.now() + SESSION_MAX_DURATION_MS + 5_000));

    // The first post-cap event rotates. The buffered dom.event flushes under the
    // OLD id as part of that rotation, so its batch is covered by the assertion
    // below too.
    await playgroundPage.sendCustomEvent();
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);

    // Poll for a batch carrying the rotated id, so the assertion below covers
    // both sides of the rotation.
    let sessionIdAfter: string | undefined;
    for (let i = 0; i < 30; i++) {
      const rotated = batches.find(
        (b) =>
          b.sessionAttributes?.session_id && b.sessionAttributes.session_id !== sessionIdBefore
      );
      if (rotated) {
        sessionIdAfter = rotated.sessionAttributes!.session_id;
        break;
      }
      await page.waitForTimeout(200);
    }

    expect(sessionIdAfter, "a batch with a rotated session id should arrive").toBeTruthy();
    expect(sessionIdAfter).not.toBe(sessionIdBefore);

    // The invariant, over every batch this session produced — both ids.
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      const times = eventTimes(batch);
      if (!times.length) continue;

      const startTime = batch.sessionAttributes?.session_start_time;
      expect(typeof startTime, "every batch carries a numeric session_start_time").toBe("number");
      // Nanoseconds since epoch, and never after the batch's earliest event.
      expect(
        startTime,
        `session ${batch.sessionAttributes?.session_id} started after an event it carries`
      ).toBeLessThanOrEqual(Math.min(...times));
    }
  });
});
