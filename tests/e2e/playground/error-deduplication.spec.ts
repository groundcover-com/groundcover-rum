import { expect, test, type Page } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, collectedEvents, trackRumBatches } from "./utils";

/**
 * Error deduplication against the playground's "Error Loop" button,
 * which throws the same uncaught error ERROR_LOOP_COUNT times in a row.
 *
 * Expected on the wire: each batch carries ONE event for the loop, the first
 * occurrence in it, with `error_repeat_count` set to the throws it stands for.
 * A batch is sent once that count reaches batchSize, so the loop arrives as
 * ceil(ERROR_LOOP_COUNT / BATCH_SIZE) events. Nothing is lost.
 *
 * page.clock drives the timers: the batch heartbeat sends the batch. The
 * throws themselves run in microtasks, which the fake clock leaves alone, so
 * they fire on the click.
 */
const BATCH_TIMEOUT_MS = 10_000; // SDK default transport.batchTimeout
// Set by the playground's "Update Config" button, which validatePage clicks.
const BATCH_SIZE = 7;
// Real time to let an in-flight send (the worker encode round-trip) reach the
// network before asserting that nothing more was sent.
const SETTLE_MS = 500;
// Both match apps/playground/src/App.tsx.
const ERROR_LOOP_COUNT = 50;
const ERROR_LOOP_MESSAGE = "Unable to decode file";
// Events one loop arrives as: seven of 7, then one of 1.
const LOOP_EVENTS = Math.ceil(ERROR_LOOP_COUNT / BATCH_SIZE);

function playgroundUrl(override?: Record<string, unknown>): string {
  const base = process.env.PLAYGROUND_URL || "http://localhost:4173";
  return override ? `${base}/?gcp=${btoa(JSON.stringify(override))}` : base;
}

// The loop's exception events, in the order they were sent.
function loopEvents(batches: any[]): any[] {
  return collectedEvents(batches, EventType.EXCEPTION).filter(
    (event) => event.attributes?.error_message === ERROR_LOOP_MESSAGE
  );
}

// Occurrences the events stand for: a merged event counts its
// error_repeat_count, any other exception counts one.
function occurrences(events: any[]): number {
  return events.reduce((sum, event) => sum + (event.attributes?.error_repeat_count ?? 1), 0);
}

async function openPlayground(page: Page, override?: Record<string, unknown>): Promise<any[]> {
  await page.clock.install({ time: new Date() });
  const batches = trackRumBatches(page);
  await page.goto(playgroundUrl(override));
  const playground = new PlaygroundPage(page);
  // Clicks, so the presence gate is open before the loop runs.
  await playground.validatePage();
  return batches;
}

async function runErrorLoop(page: Page): Promise<void> {
  await new PlaygroundPage(page).triggerErrorLoop();
}

async function hidePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.describe("RUM SDK | Error deduplication", () => {
  test("an error loop is sent as one event per batch, keeping the count", async ({ page }) => {
    const batches = await openPlayground(page);

    await runErrorLoop(page);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);

    // Every throw is counted, one event per batchSize throws.
    await expect.poll(() => occurrences(loopEvents(batches))).toBe(ERROR_LOOP_COUNT);
    const events = loopEvents(batches);
    expect(events).toHaveLength(LOOP_EVENTS);
    expect(events[0].attributes).toMatchObject({
      error_type: "Error",
      error_message: ERROR_LOOP_MESSAGE,
      error_fingerprint: `Error:${ERROR_LOOP_MESSAGE}`,
      error_handled: false,
      error_repeat_count: BATCH_SIZE,
    });
    expect(Array.isArray(events[0].attributes.error_stacktrace)).toBe(true);

    // Later batches carry nothing more for the loop.
    await page.clock.runFor(BATCH_TIMEOUT_MS * 3);
    await page.waitForTimeout(SETTLE_MS);
    expect(loopEvents(batches)).toHaveLength(LOOP_EVENTS);
    expect(occurrences(loopEvents(batches))).toBe(ERROR_LOOP_COUNT);
  });

  test("hiding the page sends the rest of the loop right away", async ({ page }) => {
    const batches = await openPlayground(page);

    await runErrorLoop(page);
    // No heartbeat yet: the size sends carry all but the last few throws, and
    // only the lifecycle flush can send those.
    await hidePage(page);

    await expect.poll(() => occurrences(loopEvents(batches))).toBe(ERROR_LOOP_COUNT);
    expect(loopEvents(batches)).toHaveLength(LOOP_EVENTS);
  });

  test("with deduplication off, every occurrence is sent in full", async ({ page }) => {
    const batches = await openPlayground(page, { errors: { deduplication: { enabled: false } } });

    await runErrorLoop(page);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);

    await expect.poll(() => loopEvents(batches).length).toBe(ERROR_LOOP_COUNT);
    for (const event of loopEvents(batches)) {
      expect(event.attributes).not.toHaveProperty("error_repeat_count");
    }
  });

  test("turning it off at runtime sends every later occurrence on its own", async ({ page }) => {
    const batches = await openPlayground(page);

    await runErrorLoop(page);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);
    await expect.poll(() => occurrences(loopEvents(batches))).toBe(ERROR_LOOP_COUNT);
    expect(loopEvents(batches)).toHaveLength(LOOP_EVENTS);

    await page.evaluate(() =>
      window.groundcover?.updateConfig({ options: { errors: { deduplication: { enabled: false } } } })
    );

    // A second loop, now with deduplication off.
    await runErrorLoop(page);
    await page.clock.runFor(BATCH_TIMEOUT_MS + 1_000);
    await expect.poll(() => loopEvents(batches).length).toBe(LOOP_EVENTS + ERROR_LOOP_COUNT);
    expect(occurrences(loopEvents(batches))).toBe(ERROR_LOOP_COUNT * 2);
  });
});
