import { inflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, collectRumBatches, collectedEvents } from "./utils";

/**
 * E2E coverage for opt-in session-replay canvas capture (options.replay.canvas).
 *
 * The playground draws a chart to a <canvas> (2D context) and reads a base64
 * `?gcp=` options override (see apps/playground/src/main.tsx), so we can boot
 * the SDK with canvas capture on/off, record, and inspect the REAL replay
 * payload — unpacking the @rrweb/packer strings and looking for canvas-mutation
 * events (rrweb IncrementalSnapshot with source CanvasMutation).
 *
 * This proves the flag flows all the way through pack → transport, not just
 * that record() received an option (that is unit-tested).
 */

// rrweb enums (rrweb 2.1.0). Canvas frames arrive as IncrementalSnapshot events
// whose data.source is CanvasMutation.
const RRWEB_INCREMENTAL_SNAPSHOT = 3;
const RRWEB_SOURCE_CANVAS_MUTATION = 9;

const BASE = process.env.PLAYGROUND_URL || "http://localhost:4173";

function urlFor(config: Record<string, unknown>): string {
  const gcp = Buffer.from(JSON.stringify(config)).toString("base64");
  return `${BASE}/?gcp=${encodeURIComponent(gcp)}`;
}

async function boot(page: Page, config: Record<string, unknown>) {
  const batches = collectRumBatches(page);
  await page.goto(urlFor(config));
  const pg = new PlaygroundPage(page);
  await expect(page.getByRole("heading", { name: "Canvas Chart" })).toBeVisible();
  return { batches, pg };
}

/** Record while drawing to the canvas, then flush so the batch is delivered. */
async function recordCanvasSession(page: Page, pg: PlaygroundPage) {
  await pg.startSessionReplay();
  // Draw repeatedly so the fps sampler has changing canvas content to snapshot.
  for (let i = 0; i < 4; i++) {
    await pg.drawCanvasChart();
    await page.waitForTimeout(200);
  }
  await pg.stopSessionReplay();
  // Force the events pool to flush the buffered replay batch (10 logs > batchSize).
  await pg.flushEvents();
}

// @rrweb/packer's `pack` is zlib-compressed JSON stored as a latin1 string, so
// node:zlib reverses it. Decoding here rather than importing `unpack` keeps
// @rrweb/packer out of the root package.json: any root package.json or lockfile
// change starts the RN and Flutter CI lanes.
function unpack(packed: string): unknown {
  return JSON.parse(inflateSync(Buffer.from(packed, "latin1")).toString("utf8"));
}

/** Unpack every replay event across all batches into rrweb events. */
function unpackReplayEvents(batches: any[]): any[] {
  const replayEvents = collectedEvents(batches, EventType.REPLAY);
  const events: any[] = [];
  for (const replay of replayEvents) {
    // enrichEvent flattens _gc_replay_data.events into a dot-notation key.
    const packed: unknown = replay.attributes?.["_gc_replay_data.events"];
    if (!Array.isArray(packed)) continue;
    for (const p of packed) {
      try {
        events.push(unpack(p as string));
      } catch {
        // Skip anything that isn't a packed rrweb event.
      }
    }
  }
  return events;
}

function hasCanvasMutation(events: any[]): boolean {
  return events.some(
    (e) =>
      e?.type === RRWEB_INCREMENTAL_SNAPSHOT &&
      e?.data?.source === RRWEB_SOURCE_CANVAS_MUTATION,
  );
}

test.describe("Session Replay — canvas capture", () => {
  test("captures canvas frames when options.replay.canvas.enabled is true", async ({
    page,
  }) => {
    const { batches, pg } = await boot(page, {
      replay: { canvas: { enabled: true, fps: 8 } },
    });

    await recordCanvasSession(page, pg);

    // Poll until an unpacked canvas-mutation event shows up in a delivered batch.
    await expect
      .poll(() => hasCanvasMutation(unpackReplayEvents(batches)), {
        timeout: 20000,
        message: "expected a canvas-mutation event in the replay payload",
      })
      .toBe(true);
  });

  test("does not capture canvas frames by default (opt-in gate)", async ({
    page,
  }) => {
    // No canvas override → canvas capture stays off (default behavior).
    const { batches, pg } = await boot(page, {});

    await recordCanvasSession(page, pg);

    // Wait until replay events are actually delivered, so "no canvas mutation"
    // is a real assertion and not just "nothing arrived yet".
    await expect
      .poll(() => collectedEvents(batches, EventType.REPLAY).length, {
        timeout: 20000,
        message: "expected replay events to be delivered",
      })
      .toBeGreaterThan(0);

    expect(hasCanvasMutation(unpackReplayEvents(batches))).toBe(false);
  });
});
