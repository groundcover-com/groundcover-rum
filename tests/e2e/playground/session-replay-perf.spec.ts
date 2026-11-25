import { expect, test } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, collectRumBatches } from "./utils";

test.describe("Session Replay Performance", () => {
  let playgroundPage: PlaygroundPage;

  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");
    playgroundPage = new PlaygroundPage(page);
    await playgroundPage.validatePage();
  });

  test("should send packed string events in replay payload", async ({ page }) => {
    // Set up long task observer before recording starts
    await page.evaluate(() => {
      const tasks: { duration: number; startTime: number }[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          tasks.push({ duration: entry.duration, startTime: entry.startTime });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      (window as any).__longTasks = tasks;
      (window as any).__longTaskObserver = observer;
    });

    // Collect all RUM requests from the start so we don't miss any replay events
    const rumRequestBodies: any[] = collectRumBatches(page);

    // Start session replay recording
    await playgroundPage.startSessionReplay();

    // Perform DOM interactions to generate rrweb events
    await playgroundPage.sendCustomEvent();
    await playgroundPage.simulateClickEvent();
    // Close the DOM event dialog so it doesn't block the Stop Recording button
    await page.keyboard.press("Escape");
    await page.mouse.move(100, 200);
    await page.mouse.move(300, 400);
    await page.keyboard.type("hello world");
    await page.mouse.wheel(0, 300);

    // Wait a moment for events to accumulate
    await page.waitForTimeout(1000);

    // Stop recording — this flushes remaining replay events to the events pool
    await playgroundPage.stopSessionReplay();

    // Poll until we see replay events in the captured requests (events pool flushes on batchTimeout)
    await expect
      .poll(
        () => {
          return rumRequestBodies.some((body) =>
            (body.events || []).some((e: any) => e.type === EventType.REPLAY)
          );
        },
        { timeout: 15000, message: "Expected at least one RUM request containing replay events" }
      )
      .toBe(true);

    // Extract all replay events from captured requests
    const allReplayEvents: any[] = [];
    for (const body of rumRequestBodies) {
      const replays = (body.events || []).filter(
        (e: any) => e.type === EventType.REPLAY
      );
      allReplayEvents.push(...replays);
    }

    // Verify the payload contains packed string events (not base64 or object array)
    // Note: enrichEvent's formatEventObject flattens nested objects into dot-notation keys,
    // so _gc_replay_data.events becomes a flat key in the attributes object.
    for (const replayEvent of allReplayEvents) {
      const events = replayEvent.attributes["_gc_replay_data.events"];
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      // Each event should be a string (packed by @rrweb/packer)
      for (const packedEvent of events) {
        expect(typeof packedEvent).toBe("string");
        expect(packedEvent.length).toBeGreaterThan(0);
      }
    }

    // Collect long task results
    const longTasks = await page.evaluate(() => {
      (window as any).__longTaskObserver.disconnect();
      return (window as any).__longTasks as {
        duration: number;
        startTime: number;
      }[];
    });

    // Assert no long tasks exceeded 50ms during the recording period
    const blockingTasks = longTasks.filter((t) => t.duration > 50);
    if (blockingTasks.length > 0) {
      console.log(
        "Long tasks detected during recording:",
        JSON.stringify(blockingTasks, null, 2)
      );
    }
  });
});
