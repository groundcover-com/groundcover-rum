import {
  BaseListener,
  type EnrichedEvent,
  type IdGenerator,
  type CoreEventType,
  type ListenerDeps,
  type PerformanceEventAttributes,
} from "@groundcover/rum-core";

import type { AppStartMetricName, RNExtraEventType } from "../rn-event-types";
import type { NativeAppStartPayload } from "../../platform/native-types";
import { getInteractiveMark, onInteractiveMark } from "../../internal/interactive-mark";
import { reportSafely, runEachContained } from "../../internal/report-safely";
import { warnOnce } from "../../internal/safe-warn";
import type { ScreenHolder } from "./navigation-tracker";

// App start and time-to-interactive, as `performance` events — one per metric,
// the same shape the browser uses for web vitals.
//
// Native measures how long until the first frame was drawn. JavaScript adds the
// interactive mark and composes TTI, because only JS knows when a screen is
// actually usable.

/** How long to hold a start metric waiting for the landing screen. Launch
 *  metrics are far more useful attributed to the screen the user arrived on,
 *  but a screenless app must not lose them entirely. */
const SCREEN_WAIT_TIMEOUT_MS = 5_000;

/**
 * Which metric each native start type reports under, and whether it anchors TTI.
 *
 * A table rather than a chain of comparisons, because a check like `payload.type !== "warm"` would
 * silently make every unrecognised value a COLD start. Cold-start duration is the number anyone
 * actually watches, so that puts a misclassified point in the one series where it does most
 * damage, and passes the offending string on to the wire as `performance_metric_navigation_type`.
 *
 * `anchorsTti` is a property of COLD starts only: TTI is measured from the same origin as the cold
 * start, so letting a foreground return set that origin would measure TTI from a resume hours into
 * the process.
 */
const APP_START_TYPES: Record<string, { metric: AppStartMetricName; anchorsTti: boolean }> = {
  cold: { metric: "app_start_cold", anchorsTti: true },
  cold_prewarmed: { metric: "app_start_cold", anchorsTti: true },
  warm: { metric: "app_start_warm", anchorsTti: false },
  hot: { metric: "app_start_hot", anchorsTti: false },
};

/**
 * The metric for a native start type, or null when the type is not one we know.
 *
 * Rejects rather than guessing, which is the opposite of `NativeFrameSegmentReason`'s deliberate
 * pass-through — and the difference is what the value does. A segment reason LABELS data that is
 * still good, so discarding the segment over it loses more than it saves. This string CHOOSES the
 * series, so a guess writes a point into a metric it does not belong to, where nothing downstream
 * can tell it apart from a real one.
 *
 * Only reachable on version skew: the producer is our own native code, so an unknown value means an
 * installed binary newer than this JS bundle. That is worth saying out loud once.
 *
 * `Object.hasOwn` and not a bare lookup: the table is an object literal, so it inherits
 * `Object.prototype`, and `APP_START_TYPES["constructor"]` finds the `Object` constructor. That is
 * truthy, so a plain `if (!known)` reads it as a KNOWN type, and spreading a function contributes no
 * `metric` — the event would be emitted anyway, carrying `performance_metric_name: undefined` and
 * the offending string as its navigation type. Five inherited names, alone out of every possible
 * string, would take the success path through the guard written to stop exactly this.
 */
export function resolveAppStartType(
  raw: unknown
): { metric: AppStartMetricName; anchorsTti: boolean; navigationType: string } | null {
  const known =
    typeof raw === "string" && Object.hasOwn(APP_START_TYPES, raw)
      ? APP_START_TYPES[raw]
      : undefined;
  if (!known) return null;
  return { ...known, navigationType: raw as string };
}

export interface AppStartListenerDeps extends ListenerDeps<RNExtraEventType> {
  screenHolder: ScreenHolder;
  /** "auto" waits for the first screen landing; "manual" waits for the app to
   *  call markAppInteractive(). */
  ttiSource: "auto" | "manual";
  /** Supplies `performance_metric_id`. The browser gets that id from the
   *  web-vitals library; mobile metrics are ours, so we mint it. */
  idGenerator: IdGenerator;
}

export class AppStartListener extends BaseListener<RNExtraEventType> {
  private readonly screenHolder: ScreenHolder;
  private readonly ttiSource: "auto" | "manual";
  private readonly idGenerator: IdGenerator;

  private active = false;
  private unsubscribeMark: (() => void) | null = null;
  private screenTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingScreenWait: Array<() => void> = [];

  /** The cold-start anchor and value, kept so TTI can be measured from the same
   *  origin and clamped against the same floor. */
  private coldStartMs: number | null = null;
  private coldDurationMs: number | null = null;
  private reportedTti = false;

  constructor(deps: AppStartListenerDeps) {
    super(deps);
    this.screenHolder = deps.screenHolder;
    this.ttiSource = deps.ttiSource;
    this.idGenerator = deps.idGenerator;
  }

  initialize(): void {
    this.active = true;
    this.unsubscribeMark = onInteractiveMark(() => this.maybeReportTti());
  }

  destroy(): void {
    this.active = false;
    this.unsubscribeMark?.();
    this.unsubscribeMark = null;
    if (this.screenTimer) {
      clearTimeout(this.screenTimer);
      this.screenTimer = null;
    }
    this.pendingScreenWait = [];
  }

  handleEvent(payload: NativeAppStartPayload): void {
    if (!this.active) return;

    try {
      const durationMs = Math.round(payload.firstFrameMs - payload.startMs);
      if (!Number.isFinite(durationMs) || durationMs < 0) return;

      const resolved = resolveAppStartType(payload.type);
      if (!resolved) {
        warnOnce(
          `[groundcover] this build's native engine reported an app start of an unknown kind ` +
            `("${String(payload.type)}"), so it will not be reported. The installed app is newer ` +
            `than the JavaScript bundle — update the bundle. (groundcoverIgnore)`
        );
        return;
      }
      if (resolved.anchorsTti) {
        this.coldStartMs = payload.startMs;
        this.coldDurationMs = durationMs;
      }

      this.whenScreenKnown(() => {
        try {
          this.queueEvent(this.buildEvent(resolved.metric, durationMs, resolved.navigationType));
        } finally {
          // The mark may already have landed while we waited for the screen.
          //
          // `finally`, so a start metric that failed to compose (id generation and enrichment run
          // outside queueEvent's own catch) does not take TTI down with it — they are independent
          // metrics from independent inputs. The error still propagates to the caller's
          // containment and gets reported; only the coupling goes.
          this.maybeReportTti();
        }
      });
    } catch (error) {
      // `reportSafely`, not `handleError` — and this catch is load-bearing on the SYNCHRONOUS path.
      //
      // When a screen is already known, `whenScreenKnown` runs the callback inline instead of
      // buffering it, so `runEachContained` never sees it and this is the only containment between
      // a failed metric and the caller. The caller is the native signal router's dispatch, i.e.
      // React Native's own event delivery. A bare `handleError` can itself throw (the host's logger
      // is reachable and patchable), which would move the escape one line down instead of removing
      // it. The two paths must contain identically, or the guarantee depends on whether a screen
      // had landed yet.
      reportSafely(error);
    }
  }

  buildEvent(
    name: AppStartMetricName,
    valueMs: number,
    navigationType: string
  ): EnrichedEvent<CoreEventType | RNExtraEventType> {
    const attributes: PerformanceEventAttributes = {
      performance_metric_name: name,
      performance_metric_value: valueMs,
      performance_metric_id: this.idGenerator.generateId(),
      performance_metric_navigation_type: navigationType,
    };
    return this.enricher.enrich({ type: "performance", attributes });
  }

  queueEvent(event: EnrichedEvent<CoreEventType | RNExtraEventType>): void {
    try {
      this.eventsPool.addEvent(event);
    } catch (error) {
      // The twin of the catch above: a pool failure on the synchronous path reaches the same
      // host callback, so it needs the same non-throwing reporter.
      reportSafely(error);
    }
  }

  /**
   * TTI = the interactive mark measured from the SAME origin as cold start.
   *
   * Cold only: a warm start has no comparable "the app became usable" moment,
   * and the mark is set once per JS lifetime anyway.
   */
  private maybeReportTti(): void {
    if (!this.active || this.reportedTti) return;

    const coldStartMs = this.coldStartMs;
    const coldDurationMs = this.coldDurationMs;
    if (coldStartMs === null || coldDurationMs === null) return;

    const markMs = getInteractiveMark(this.ttiSource);
    if (markMs === null) return;

    this.reportedTti = true;
    // Clamped to the first frame: an app holding a native splash screen can run
    // JS before anything is drawn, which would otherwise report the app as
    // interactive BEFORE it was visible.
    const ttiMs = Math.max(coldDurationMs, Math.round(markMs - coldStartMs));
    this.queueEvent(this.buildEvent("app_start_tti", ttiMs, "cold"));
  }

  /** Runs `emit` once a screen is known, or after a timeout if none ever is. */
  private whenScreenKnown(emit: () => void): void {
    if (this.screenHolder.get().name) {
      emit();
      return;
    }

    this.pendingScreenWait.push(emit);
    if (this.screenTimer) return;

    this.screenTimer = setTimeout(() => {
      this.screenTimer = null;
      const waiting = this.pendingScreenWait;
      this.pendingScreenWait = [];
      // Contained per callback. Each one runs id generation, enrichment and a pool
      // add, any of which can throw — and this is a TIMER callback, so an escape is an uncaught
      // error with no caller to attribute it to, not a rejected promise somebody is awaiting.
      runEachContained(waiting);
    }, SCREEN_WAIT_TIMEOUT_MS);
  }

  /** Called by the composition root when the first screen lands, so buffered
   *  start metrics can go out attributed to it instead of waiting out the
   *  timeout. */
  notifyScreenKnown(): void {
    if (!this.pendingScreenWait.length) return;
    if (this.screenTimer) {
      clearTimeout(this.screenTimer);
      this.screenTimer = null;
    }
    const waiting = this.pendingScreenWait;
    this.pendingScreenWait = [];
    // Per callback, not one try around the loop: these are independent metrics, and
    // the first throw would otherwise drop every later one — a cold-start failure silently taking
    // TTI with it. Same contract the ScreenHolder's own subscriber notification already keeps.
    runEachContained(waiting);
  }
}
