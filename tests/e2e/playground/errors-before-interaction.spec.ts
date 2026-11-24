import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { EventType } from "./utils";

/**
 * Visits before the first interaction, end to end.
 *
 * The SDK sends nothing for a session until the user first interacts, and drops
 * what it held if they never do (see ghost-sessions.spec.ts). The exception:
 * when the visitor leaves before touching anything, the session is sent with
 * everything it held if the page was visible (they could see it), or if it
 * caught a real exception (a page that threw in a background tab). A page
 * nobody could see, with no error, is still dropped.
 *
 * Playwright pages are visible, so the error cases load the page out of sight
 * (`openPlaygroundOutOfSight`): only the error can send those.
 *
 * Harness notes:
 * - The batches go to a collector stub this spec runs (the playground's
 *   `?gcdsn=` hook), not just to page.on("request"): the send happens while
 *   the page is being torn down, and the point is that it ARRIVES. The stub is
 *   on another origin than the page (127.0.0.1 vs localhost), and the SDK's
 *   `apikey` header makes the browser send a CORS preflight first, as against
 *   a real collector. That preflight is why the send must be a keepalive
 *   request: an ordinary one is cancelled with the page, after the stub sees
 *   the OPTIONS and before the POST. "OPTIONS but no POST" is that bug.
 * - No clicks, no pointer, no keys: any of them is an interaction and would
 *   open the gate the normal way. Errors are thrown from an injected script,
 *   which is an uncaught error like any other.
 * - page.clock.install() doesn't freeze time: timers run in real time, and
 *   fastForward fires the batch heartbeat at once instead of after 10 s. The
 *   gate holds the heartbeat's send either way, so no result here depends on
 *   when it fires.
 */
const BASE = process.env.PLAYGROUND_URL || "http://localhost:4173";
const BATCH_TIMEOUT_MS = 10_000; // SDK default transport.batchTimeout
// Real time for an in-flight send to reach the stub before asserting none did.
const SETTLE_MS = 1_000;
const LOAD_ERROR = "Failed to load level data";

type ReceivedBatch = {
  sessionAttributes?: { session_id?: string };
  events?: Array<{ type: string; attributes?: Record<string, unknown> }>;
};

type Collector = { origin: string; batches: ReceivedBatch[]; close: () => Promise<void> };

async function startCollector(): Promise<Collector> {
  const batches: ReceivedBatch[] = [];
  const server: Server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type, content-encoding, apikey");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // The playground turns compression off, so a batch is plain JSON.
      try {
        batches.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        /* not a batch */
      }
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    batches,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function eventsOf(batches: ReceivedBatch[], type?: EventType) {
  const events = batches.flatMap((batch) => batch.events ?? []);
  return type ? events.filter((event) => event.type === type) : events;
}

async function openPlayground(page: Page, collector: Collector): Promise<void> {
  await page.clock.install({ time: new Date() });
  const params = new URLSearchParams({ gcdsn: collector.origin });
  await page.goto(`${BASE}/?${params}`);
  await expect(page.getByText("groundcover SDK Playground")).toBeVisible();
}

// A page loaded out of sight (a background tab). Playwright can't open one, so
// the document reads "hidden" from before the SDK starts, and never changes.
async function openPlaygroundOutOfSight(page: Page, collector: Collector): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  await openPlayground(page, collector);
}

// Runs `source` as a page script, so what it throws is uncaught like any other.
async function runPageScript(page: Page, source: string): Promise<void> {
  await page.evaluate((text) => {
    const script = document.createElement("script");
    script.textContent = text;
    document.head.appendChild(script);
  }, source);
}

const throwUncaught = (page: Page, message: string) =>
  runPageScript(page, `throw new Error(${JSON.stringify(message)});`);

const rejectUnhandled = (page: Page, message: string) =>
  runPageScript(page, `Promise.reject(new Error(${JSON.stringify(message)}));`);

// Past the heartbeat, with time for a send to land: a gated session sends
// nothing, so the stub stays empty.
async function expectNothingSentWhileOnPage(page: Page, collector: Collector): Promise<void> {
  await page.clock.fastForward(BATCH_TIMEOUT_MS + 1_000);
  await page.waitForTimeout(SETTLE_MS);
  expect(collector.batches, "nothing is sent while the visitor is still on the page").toHaveLength(0);
}

async function expectLoadErrorArrives(collector: Collector, message = LOAD_ERROR): Promise<void> {
  await expect
    .poll(() => eventsOf(collector.batches, EventType.EXCEPTION).length, {
      message: "the error should reach the collector after the page was hidden or left",
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const exception = eventsOf(collector.batches, EventType.EXCEPTION)[0]!;
  expect(exception.attributes).toMatchObject({ error_message: message, error_handled: false });
  // Sent with what the session held, as context for the error.
  expect(eventsOf(collector.batches, EventType.PAGELOAD).length).toBeGreaterThan(0);
  const sessionIds = new Set(collector.batches.map((batch) => batch.sessionAttributes?.session_id));
  expect(sessionIds.size, "one session").toBe(1);
  expect([...sessionIds][0]).toBeTruthy();
}

test.describe("RUM SDK | Visits before the first interaction", () => {
  let collector: Collector;

  test.beforeEach(async () => {
    collector = await startCollector();
  });

  test.afterEach(async () => {
    await collector.close();
  });

  test("a load error reaches the collector when the visitor navigates away without interacting", async ({ page }) => {
    await openPlaygroundOutOfSight(page, collector);
    await throwUncaught(page, LOAD_ERROR);
    await expectNothingSentWhileOnPage(page, collector);

    await page.goto("about:blank");

    await expectLoadErrorArrives(collector);
  });

  test("an unhandled rejection while loading reaches the collector too", async ({ page }) => {
    await openPlaygroundOutOfSight(page, collector);
    await rejectUnhandled(page, LOAD_ERROR);
    await expectNothingSentWhileOnPage(page, collector);

    await page.goto("about:blank");

    await expectLoadErrorArrives(collector);
  });

  test("a load error reaches the collector when the visitor closes the tab without interacting", async ({ page, browserName }) => {
    test.skip(
      browserName === "webkit",
      "Playwright's WebKit closes the page without running its unload handlers (no beforeunload, pagehide or visibilitychange); navigating away covers WebKit"
    );
    await openPlaygroundOutOfSight(page, collector);
    await throwUncaught(page, LOAD_ERROR);
    await expectNothingSentWhileOnPage(page, collector);

    await page.close({ runBeforeUnload: true });

    await expectLoadErrorArrives(collector);
  });

  test("a load error reaches the collector on pagehide alone, with no visibilitychange", async ({ page }) => {
    await openPlaygroundOutOfSight(page, collector);
    // A page already hidden when it unloads (a tab opened in the background and closed unseen)
    // gets pagehide and no visibilitychange. The browser still sees this page as visible and
    // fires one when it is left, so this stops it before any listener sees it.
    await page.evaluate(() => {
      window.addEventListener("visibilitychange", (event) => event.stopImmediatePropagation(), true);
    });
    await throwUncaught(page, LOAD_ERROR);
    await expectNothingSentWhileOnPage(page, collector);

    await page.goto("about:blank");

    await expectLoadErrorArrives(collector);
  });

  test("an error the app throws in its own hide listener goes with that send", async ({ page }) => {
    const HIDE_ERROR = "Failed to save draft on hide";
    await openPlaygroundOutOfSight(page, collector);
    // Added after the SDK started, as an app's (or web-vitals') hide listener is.
    await runPageScript(
      page,
      `document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") throw new Error(${JSON.stringify(HIDE_ERROR)});
      });`
    );
    await expectNothingSentWhileOnPage(page, collector);

    // A tab switch, simulated: Playwright can't hide a page, and leaving it would also fire
    // pagehide, which sends the error on its own. The event bubbles, as the browser's does.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    });

    await expectLoadErrorArrives(collector, HIDE_ERROR);
  });

  test("a visit without interaction or error reaches the collector when the visitor leaves a page they could see", async ({ page }) => {
    await openPlayground(page, collector);
    await page.evaluate(() =>
      window.groundcover?.sendCustomEvent({ event: "seen_no_error", attributes: {} })
    );
    await expectNothingSentWhileOnPage(page, collector);

    await page.goto("about:blank");

    await expect
      .poll(
        () =>
          eventsOf(collector.batches, EventType.CUSTOM).some(
            (event) => event.attributes?.custom_event_name === "seen_no_error"
          ),
        { message: "the visit should reach the collector after the page was left", timeout: 10_000 }
      )
      .toBe(true);
    expect(eventsOf(collector.batches, EventType.PAGELOAD).length).toBeGreaterThan(0);
    expect(eventsOf(collector.batches, EventType.EXCEPTION)).toHaveLength(0);
  });

  test("a visit nobody could see, without an error, is still not sent", async ({ page }) => {
    await openPlaygroundOutOfSight(page, collector);
    await page.evaluate(() =>
      window.groundcover?.sendCustomEvent({ event: "background", attributes: {} })
    );
    await expectNothingSentWhileOnPage(page, collector);

    await page.goto("about:blank");
    await page.waitForTimeout(SETTLE_MS);

    expect(collector.batches, "never visible and no error, so the gate drops the session").toHaveLength(0);
  });
});
