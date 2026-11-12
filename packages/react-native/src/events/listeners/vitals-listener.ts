import {
  BaseListener,
  EventEnricher,
  handleError,
  msToNs,
  type EnrichedEvent,
  type IdGenerator,
  type CoreEventType,
  type ListenerDeps,
} from "@groundcover/rum-core";

import type {
  FrameVitalsEventAttributes,
  RNExtraEventType,
  ScreenAttributes,
} from "../rn-event-types";
import type { NativeFrameSegment } from "../../platform/native-types";
import { warnOnce } from "../../internal/safe-warn";

// Frame vitals as `performance` events — one per SEGMENT, the same shape the
// browser uses for web vitals.
//
// A segment is one screen's dwell, so these events are attributable: "the feed
// stuttered" rather than "the app stuttered somewhere in the last five seconds".
//
// THE METRIC IS NOT A RATE, and that is the whole design. A `slow / total` rate reads as "the
// fraction of frames that stuttered" and is not that on iOS, because the two platforms do not
// count the same frames:
//
//   - Android's FrameMetrics fires only when the app DRAWS, so `total` is rendering work.
//   - iOS's CADisplayLink fires on every display refresh, drawn or not, so `total` is elapsed
//     time x refresh rate.
//
// iOS's frames-per-second is therefore the refresh rate handed straight back, while Android's is
// genuine render activity, so the same app would report a tiny rate on iOS and a large one on
// Android — a consumer comparing the two would be comparing different quantities. Seconds spent
// reading a still screen dilute iOS's numerator away entirely.
//
// The metric shipped is immune to that because it does not divide by a frame count: it is
// milliseconds lost, and a consumer normalizes it by TIME — the segment bounds — never by frames.
//
// NO REFRESH-RATE METRIC is emitted either, average or minimum. A minimum would come from a
// SINGLE frame (the worst non-frozen one in the segment), which makes it very noisy: one stutter
// anywhere in a long otherwise-smooth screen dominates it, and identical underlying jank produces
// wildly different numbers depending on how long the segment happens to be.

// `frames_delay_total`: its `performance_metric_value` is the SEGMENT's cumulative lost
// milliseconds (summed over every slow frame), not one frame's delay. A bare name reads as
// per-frame, so quantiling it would look like a single frame took two-thirds of a second — the
// `_total` suffix says outright that it is an aggregate.
export type FrameVitalsMetricName = "frames_delay_total";

/**
 * The value if it is a usable number, else null — which means "this engine did not send it" and is
 * deliberately distinct from a legitimate 0. A perfectly smooth segment reports `delayMs: 0`, and
 * treating that as missing would suppress vitals for exactly the screens that are working.
 */
function finiteNonNegative(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export interface VitalsListenerDeps extends ListenerDeps<RNExtraEventType> {
  /** Supplies `performance_metric_id` — the browser gets it from web-vitals. */
  idGenerator: IdGenerator;
  /**
   * Has the session gone quiet? Segments are dropped while it is true. Required rather than
   * optional: a default of "always active" would let a new construction site grow sessions without
   * bound by forgetting a line, and the failure mode is extra events nothing asserts on.
   */
  isSessionInactive: () => boolean;
}

// The SDK's only PASSIVE emitter: native closes a segment every `vitalsMaxSegmentMs` while the
// screen is on, with nobody there, and consumers derive session duration from last event −
// session_start_time — so unstopped it would grow one session for as long as the screen stays on.
// The idle gate in handleEvent is RN's answer to the browser pausing rrweb.
export class VitalsEventsListener extends BaseListener<RNExtraEventType> {
  private readonly idGenerator: IdGenerator;
  private readonly isSessionInactive: () => boolean;
  private active = false;

  constructor(deps: VitalsListenerDeps) {
    super(deps);
    this.idGenerator = deps.idGenerator;
    this.isSessionInactive = deps.isSessionInactive;
  }

  initialize(): void {
    this.active = true;
  }

  destroy(): void {
    this.active = false;
  }

  /**
   * Reports one closed frame segment as a single `frames_delay_total` metric.
   *
   * @param screenOverride the screen the segment belongs to, when it is NOT the
   *   ambient one. Supplied on the navigation close, where JavaScript has already
   *   moved the screen holder on and the ambient stamp would name the destination.
   */
  handleEvent(segment: NativeFrameSegment, screenOverride?: ScreenAttributes): void {
    if (!this.active) return;
    // "Nothing rendered" is not a vitals signal, and an empty segment would report zero lost time
    // as though the screen had been smooth.
    if (!segment || segment.total <= 0) return;
    // The idle gate — see the note above the class.
    if (this.isSessionInactive()) {
      this.logger.log("[vitals-listener] dropping frame segment: session is inactive");
      return;
    }

    // A native binary that predates these fields cannot produce the metric. Say so once rather
    // than shipping nothing: an app whose vitals silently stop is indistinguishable from a smooth
    // one.
    const delayMs = finiteNonNegative(segment.delayMs);
    if (delayMs === null) {
      warnOnce(
        `[groundcover] this build's native engine reports frame segments without timing detail, so ` +
          `frame vitals will not be reported. The installed app predates the JavaScript bundle — ` +
          `rebuild the app (a Metro reload updates JS only). (groundcoverIgnore)`
      );
      return;
    }

    const enricher = this.enricherFor(screenOverride);

    try {
      this.queueEvent(this.buildEvent("frames_delay_total", delayMs, segment, enricher));
    } catch (error) {
      handleError(error);
    }
  }

  /**
   * The enricher to compose this segment's events with.
   *
   * A local one is the ONLY way to name a screen other than the current one:
   * `enrichAttributes` is merged AFTER the attributes are dot-flattened, so the
   * ambient `screen` block wins over anything passed in through `attributes`.
   * Same pattern `native-crash-drain.ts` uses to stamp the crash-time screen.
   */
  private enricherFor(screenOverride?: ScreenAttributes): EventEnricher {
    if (!screenOverride) return this.enricher;
    return new EventEnricher({
      enrichAttributes: () => ({ screen: screenOverride }),
      idGenerator: this.idGenerator,
    });
  }

  /**
   * @param value MILLISECONDS — the segment's cumulative lost time, not one frame's. Milliseconds
   *   rather than seconds because every other duration this SDK ships is milliseconds
   *   (`hang_duration_ms`, `app_start_cold`'s value).
   *
   * NEITHER an average refresh rate NOR `performance_frames_total` is emitted, for one reason: a
   * frame COUNT is not the same quantity on the two platforms, so anything derived from one is
   * incomparable across them. iOS's CADisplayLink ticks on every display refresh whether or not the
   * app drew, Android's FrameMetrics only on a real draw. iOS's frames-per-second is therefore the
   * refresh rate handed back, carrying nothing the segment bounds do not, while Android's is
   * genuine render activity: `slow / total` would read near zero on iOS and high on Android for
   * the same class of app, and `total / elapsed` would tell a reader an idle Android app runs at a
   * few fps.
   *
   * The counts that DO ship — slow and frozen — are absolute and mean the same thing on both. To
   * normalize them, use TIME: `start_timestamp` and `end_timestamp` ship on every segment and a
   * second is a second on either platform.
   */
  buildEvent(
    name: FrameVitalsMetricName,
    value: number,
    segment: NativeFrameSegment,
    enricher: EventEnricher = this.enricher
  ): EnrichedEvent<CoreEventType | RNExtraEventType> {
    const budgetMs = finiteNonNegative(segment.budgetMs);
    const attributes: FrameVitalsEventAttributes = {
      performance_metric_name: name,
      // Two decimals. The value is a physical quantity rather than a fraction, so more places would
      // be noise — but whole milliseconds would round a single marginally-slow frame's delay
      // (0.28ms at 60Hz) down to zero and make it indistinguishable from a segment with no slow
      // frames at all.
      performance_metric_value: Math.round(value * 100) / 100,
      performance_metric_id: this.idGenerator.generateId(),
      // Launch context is meaningless for a steady-state metric; the `screen`
      // stamp is what gives these events their attribution.
      performance_metric_navigation_type: "",
      performance_refresh_rate_hz: segment.refreshRate,
      // A per-segment reading rather than a summable total, carried on the event itself so a
      // consumer never has to join to another row to learn what bar produced the counts.
      // `finiteNonNegative`, not a bare `> 0`: Infinity passes a positivity check and then
      // serializes as JSON `null`, which reads downstream as "native sent nothing" while native in
      // fact sent garbage. The bridge strips a non-finite budget before this, so reaching here is
      // belt and braces — but the two guards protect different callers, and the helper exists for
      // exactly this reason on `delayMs`.
      ...(budgetMs !== null && budgetMs > 0
        ? { performance_frame_budget_ms: Math.round(budgetMs * 100) / 100 }
        : {}),
      performance_segment_reason: segment.reason,
      // Nanoseconds, matching what `navigation` events already ship under these
      // same names — so a consumer can intersect a segment with the navigations
      // around it with no unit conversion and no name mapping.
      start_timestamp: msToNs(segment.segmentStartMs),
      end_timestamp: msToNs(segment.segmentEndMs),
    };
    // The counts ride the `frames_delay_total` event ONLY. They are absolute totals a consumer sums
    // to combine segments, so they must appear on exactly one event per segment — stamped on two,
    // a sum across rows would double-count every frame. The name check keeps that true should a
    // second metric ever be emitted per segment.
    if (name === "frames_delay_total") {
      attributes.performance_frames_slow = segment.slow;
      attributes.performance_frames_frozen = segment.frozen;
    }
    return enricher.enrich({
      type: "performance",
      // The segment's END, not now. A segment describes a past interval, and
      // timestamping it at emit time would place a screen's jank AFTER the
      // navigation that ended it — the exact ordering a consumer keys on.
      timestamp: msToNs(segment.segmentEndMs),
      attributes,
    });
  }

  queueEvent(event: EnrichedEvent<CoreEventType | RNExtraEventType>): void {
    try {
      this.eventsPool.addEvent(event);
    } catch (error) {
      handleError(error);
    }
  }
}
