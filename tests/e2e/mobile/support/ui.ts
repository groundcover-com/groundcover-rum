import { expect } from "@mobilewright/test";
import type { Locator, Screen } from "@mobilewright/core";
import { expectEvents } from "./ingest-client";

/** Clearance a control needs below it before its centre is a safe tap target. */
const TAB_BAR_CLEARANCE = 24;

/** The part of a control the driver reports, in the coordinates it reports them. */
export type Box = { x: number; y: number; width: number; height: number };

/**
 * Where to tap a control the tab bar overlaps, or why there is nowhere to tap it.
 * Separate from `tapScrolling` because it is the part that can be WRONG and a device
 * cannot check it — given a box and a limit the answer is arithmetic.
 */
export type FallbackTap = { y: number } | { unreachable: string };

/**
 * The y to tap on a control whose bottom is under the tab bar: the centre of the strip
 * still in front of it, `[box.y, limit]`. That strip can be EMPTY when `box.y > limit`,
 * and clamping to `limit` then returns a row ABOVE the control's own top edge — so the
 * tap lands on whatever is drawn there and the spec fails as a missed interaction, or
 * hits a different control and fails a screen later. "Unreachable" names the cause.
 */
export function fallbackTapY(box: Box, limit: number): FallbackTap {
  const top = box.y;
  const bottom = Math.min(box.y + box.height, limit);
  if (bottom < top) {
    return {
      unreachable:
        `the control sits entirely below the tab-bar clearance line ` +
        `(top y=${top}, clearance line y=${limit}), so no part of it is tappable. ` +
        `The scroll view could not lift it any further.`,
    };
  }
  return { y: (top + bottom) / 2 };
}

/** How many nudges to spend lifting a control out from under the tab bar. */
const MAX_NUDGES = 4;

/**
 * The floor under a nudge, in the pixels `boundingBox` and `swipe` both speak. Android
 * discards a drag shorter than its touch slop — 8dp, 21px at the emulator's 420dpi —
 * before a scroll begins, so the bare overlap works while it is large and does nothing
 * at all over the last few pixels. 48dp clears the slop with room to settle short.
 */
const NUDGE_FLOOR = 126;

/** How far to drag to clear `overlap` pixels of tab bar. Overshooting costs nothing —
 *  the loop re-measures and taps the control wherever it came to rest. */
export function nudgeDistance(overlap: number): number {
  return Math.max(overlap, 0) + NUDGE_FLOOR;
}

/** The driver settles 200ms after its own swipes; ours needs the same or more, or the
 *  next `boundingBox` is read mid-fling and the loop chases a moving control. */
const NUDGE_SETTLE_MS = 250;

/** How long `tapScrolling` lets a just-opened screen draw its control before scrolling for it.
 *  Spent in full only on a control that really is below the fold. */
const DRAW_GRACE_MS = 2_000;

/** How far short of the screen's top edge `dragUpFrom` stops, in driver units. */
const TOP_EDGE_MARGIN = 10;

/**
 * How far a drag starting at `startY` can travel upward and still end on the screen.
 *
 * `locator.swipe({ direction: "up" })` travels half the screen from the element's centre, so it
 * ends above the top edge whenever the element sits in the upper half, as the first visible
 * `Row N` does once a list has scrolled. Since mobilecli 1.0.11 Android input goes through an
 * on-device agent that rejects such a gesture outright ("finger 0 has negative coordinates").
 * Stopping just short of the edge keeps the gesture valid on both platforms.
 */
export function dragUpDistance(startY: number): number {
  return Math.max(1, Math.floor(startY) - TOP_EDGE_MARGIN);
}

/** Drag upward from `anchor`'s centre to just short of the top edge. See `dragUpDistance`. */
export async function dragUpFrom(screen: Screen, anchor: Locator): Promise<void> {
  const box = await anchor.boundingBox();
  const startY = Math.round(box.y + box.height / 2);
  await screen.swipe("up", {
    startX: Math.round(box.x + box.width / 2),
    startY,
    distance: dragUpDistance(startY),
  });
}

/**
 * Tap a control by its text, scrolling to it first — `getByText` resolves only what is VISIBLE, so
 * anything below the fold fails as "no matching element found".
 *
 * Scrolling alone is not enough: `scrollIntoViewIfNeeded` stops once the element is inside the
 * screen RECTANGLE, while the tab bar overlays its bottom tenth — so a control can be "in view"
 * and entirely BEHIND the bar, resting a pixel above the bar's top edge.
 *
 * The nudge is what has to work. Nudging by the bare overlap fails with the control a few pixels
 * under the line: every nudge is under the slop, so nothing moves. The resting position varies run
 * to run on an unchanged image, so a single run can miss this.
 *
 * Nor can it be the first thing after a tab tap. `scrollIntoViewIfNeeded` reads the tree once,
 * and a control it cannot find it takes to be below the fold and swipes for — so a read that
 * lands before the new screen has drawn scrolls a screen that needed nothing. The control is still
 * found and tapped, but everything above it is now off-screen, such as the `Session:` readout at
 * the top of Config. With fast tree reads (see in-app-agent-stub.mjs) the first read can beat the
 * render.
 */
export async function tapScrolling(screen: Screen, text: string | RegExp): Promise<void> {
  const control = screen.getByText(text);
  // A wait, not a check: false only means "below the fold", which the scroll handles.
  await control.isVisible({ timeout: DRAW_GRACE_MS });
  await control.scrollIntoViewIfNeeded();

  // The tab bar is on every playground screen, so its first item marks where the
  // overlay starts. Measured rather than assumed: the bar's height differs
  // between the two platforms and between device sizes.
  const limit = (await screen.getByLabel("Taps tab").boundingBox()).y - TAB_BAR_CLEARANCE;

  let restingY: number | undefined;
  for (let nudge = 0; nudge < MAX_NUDGES; nudge++) {
    const box = await control.boundingBox();
    if (box.y + box.height <= limit) {
      // Clear of the bar — the ordinary path, and the only one taken unless the
      // control came to rest in the overlaid band.
      await control.tap();
      return;
    }
    // Unmoved by the last nudge: the scroll view is at its end and further nudges
    // are just spent time. Take the fallback now.
    if (box.y === restingY) break;
    restingY = box.y;

    await screen.swipe("up", { distance: nudgeDistance(box.y + box.height - limit) });
    await new Promise((resolve) => setTimeout(resolve, NUDGE_SETTLE_MS));
  }

  // Still overlapped: the scroll view has hit its end and cannot lift the control any
  // further. Tap the strip of it that IS in front of the bar — a partly visible control
  // is still a real target, and this is closer to what a user would do than giving up.
  const box = await control.boundingBox();
  const fallback = fallbackTapY(box, limit);
  if ("unreachable" in fallback) {
    // Fail HERE, naming the geometry. The alternative is a tap delivered to
    // whatever else occupies that row, which fails later and somewhere else.
    throw new Error(`tapScrolling(${String(text)}): ${fallback.unreachable}`);
  }
  await screen.tap(box.x + box.width / 2, fallback.y);
}

/**
 * Prove the app is alive and processing touches, WITHOUT reading telemetry — for the negative
 * specs, where "no events arrived" is equally satisfied by a wedged app or a missed locator.
 *
 * Uses the Config screen's first card and the status line above it, so nothing has to scroll
 * (`scrollIntoViewIfNeeded` will not scroll back UP). Deliberately NOT the Taps counter, whose
 * accessibilityLabel replaces its visible text for iOS queries, so a text locator times out on iOS.
 */
export async function expectAppAlive(screen: Screen): Promise<void> {
  await screen.getByLabel("Config tab").tap();
  await tapScrolling(screen, /tap survivor/);
  await expect(screen.getByText(/Last action: survivor: done/)).toBeVisible();
}

export async function expectTapped(label: string | RegExp): Promise<void> {
  await expectEvents("interaction", {
    timeout: 30_000,
    where: (event) => {
      const captured = String(
        (event.attributes as Record<string, unknown>)["interaction_target.label"] ?? ""
      );
      return typeof label === "string" ? captured.includes(label) : label.test(captured);
    },
    describe: `a tap on ${String(label)}`,
  });
}
