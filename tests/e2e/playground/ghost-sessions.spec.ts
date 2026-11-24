import { expect, test, type Page } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, collectRumBatches } from "./utils";

/**
 * Ghost sessions = backend sessions that carry a few events (background
 * network calls, programmatic custom events, a pageload) but have NO replay
 * recording and NO real user. Without presence gating on event flushing (the
 * way replay recording is gated), the instant a tab loads, pageload +
 * background fetch/XHR + programmatic sendCustomEvent would ship under the
 * session id, no human required.
 *
 * These specs pin that nothing reaches the backend for a session until a
 * genuine interaction (raw input or a dom.event) is observed.
 *
 * Harness notes (mirrors session-inactivity-gap.spec.ts / user-presence.spec.ts):
 * - page.clock freezes timers, so pool flushes only happen when we fastForward
 *   past the batchTimeout heartbeat.
 * - Every spec deliberately AVOIDS PlaygroundPage.validatePage() — it performs
 *   real "Update Config" clicks (a dom.event = genuine presence) that would
 *   confirm the session and mask a regression.
 * - Background traffic is fired PROGRAMMATICALLY (page.evaluate) so it carries
 *   no interaction; genuine interaction, where needed, uses real page.mouse input.
 */
const BATCH_TIMEOUT_MS = 10_000; // default transport.batchTimeout
const SESSION_MAX_DURATION_MS = 60_000; // playground main.tsx sessionMaxDuration

type CapturedBatch = {
  sessionAttributes?: { session_id?: string };
  events?: Array<{ type: string; attributes?: Record<string, unknown> }>;
};

function captureRumBatches(page: Page): CapturedBatch[] {
  return collectRumBatches(page);
}

// Fire background traffic with NO user interaction: a programmatic custom event
// (the exact "custom" path that mints ghosts) plus a same-origin fetch (a
// "network" event). Neither is a dom.event and neither moves the pointer.
async function fireBackgroundTraffic(page: Page, customName: string): Promise<void> {
  await page.evaluate(async (name) => {
    window.groundcover?.sendCustomEvent({ event: name, attributes: { source: "background" } });
    try {
      await fetch("/");
    } catch {
      /* a failed fetch still produces a network event */
    }
  }, customName);
}

const PLAYGROUND_URL = process.env.PLAYGROUND_URL || "http://localhost:4173";

test.describe("RUM SDK | Ghost sessions", () => {
  test("A: a load with no user interaction sends nothing to the backend", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const batches = captureRumBatches(page);

    await page.goto(PLAYGROUND_URL);
    // No validatePage(), no clicks, no pointer — just background traffic.
    await fireBackgroundTraffic(page, "ghost_probe");

    // Advance past the batch heartbeat: without the presence gate this would
    // flush the buffered pageload + network + custom events.
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await page.waitForTimeout(500);

    expect(
      batches,
      "a load with no genuine interaction must not send any RUM batch (ghost session)"
    ).toHaveLength(0);
  });

  test("B: an abandoned once-active tab mints no ghost session at the max-duration cap", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const batches = captureRumBatches(page);

    await page.goto(PLAYGROUND_URL);

    // Genuine interaction (a real click = dom.event) → session A is a real
    // session and flushes.
    await page.locator("h1").first().click();
    await page.evaluate(() =>
      window.groundcover?.sendCustomEvent({ event: "real_user", attributes: {} })
    );
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await page.waitForTimeout(500);

    const sessionIdA = batches.find((b) => b?.sessionAttributes?.session_id)?.sessionAttributes
      ?.session_id;
    expect(sessionIdA, "session A should flush under a confirmed interaction").toBeTruthy();
    const countAfterA = batches.length;

    // User leaves, tab stays open. Cross the max-duration cap with NO interaction,
    // then a lone background poll fires. Without the gate, the cap rotation would
    // mint session B and ship B's network batch — a pure ghost (no recording, no
    // user).
    await page.clock.fastForward(SESSION_MAX_DURATION_MS + 5_000);
    await fireBackgroundTraffic(page, "background_poll");
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await page.waitForTimeout(500);

    const ghostBatches = batches
      .slice(countAfterA)
      .filter(
        (b) => b?.sessionAttributes?.session_id && b.sessionAttributes.session_id !== sessionIdA
      );
    expect(
      ghostBatches,
      "background traffic in an abandoned tab must not mint a sent ghost session id"
    ).toHaveLength(0);
  });

  test("C: buffered lead-up is released on the first genuine interaction", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const batches = captureRumBatches(page);

    await page.goto(PLAYGROUND_URL);

    // Background traffic while nobody has interacted yet — must be held.
    await fireBackgroundTraffic(page, "ghost_probe");
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await page.waitForTimeout(500);
    expect(batches, "events must be held until a genuine interaction").toHaveLength(0);

    // First genuine interaction — raw input (mouse move), NOT a click — confirms
    // the session and drains the buffered lead-up. Exercises the raw-input path:
    // pageload must not have consumed the 30s throttle, or this move is suppressed.
    await page.mouse.move(140, 140);
    await page.mouse.move(180, 180);
    await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
    await page.waitForTimeout(500);

    expect(batches.length, "a batch should be sent after the interaction").toBeGreaterThan(0);

    const events = batches.flatMap((b) => b.events ?? []);
    const drainedCustom = events.find(
      (e) => e.type === EventType.CUSTOM && e.attributes?.custom_event_name === "ghost_probe"
    );
    expect(
      drainedCustom,
      "the pre-interaction custom event should be drained in the released batch"
    ).toBeTruthy();
    expect(
      events.some((e) => e.type === EventType.PAGELOAD),
      "the buffered pageload lead-up should be released too"
    ).toBeTruthy();
  });
});
