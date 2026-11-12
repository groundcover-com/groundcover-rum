import {
  BaseListener,
  handleError,
  msToNs,
  type EnrichedEvent,
  type ErrorEventAttributes,
  type CoreEventType,
  type ListenerDeps,
} from "@groundcover/rum-core";

import type { RNExtraEventType } from "../rn-event-types";
import type { NativeHangPayload } from "../../platform/native-types";
import { normalizeStackFrames } from "../../platform/native-bridge";

// Main-thread stalls, reported as `exception` events rather than a bespoke "hang" type: a frozen
// app is an error the user experienced, so reusing the shape lands it in the same view with the
// same fingerprint rules. The signals come from the native watchdogs, which report only stalls
// the app RECOVERED from — one that killed the process arrives separately, from the system's
// post-mortem record.

/** Group by duration BUCKET, not exact milliseconds — otherwise every hang is
 *  its own issue and the pattern (this screen freezes for ~5s) never surfaces. */
function bucketDuration(durationMs: number): string {
  if (durationMs < 1_000) return "<1s";
  if (durationMs >= 30_000) return "30s+";
  return `${Math.floor(durationMs / 1_000)}s`;
}

export class HangsEventsListener extends BaseListener<RNExtraEventType> {
  // Guards a signal that arrives after teardown: the native side is not
  // synchronized with JS lifecycle, so a hang can be delivered mid-destroy.
  private active = false;

  constructor(deps: ListenerDeps<RNExtraEventType>) {
    super(deps);
  }

  initialize(): void {
    this.active = true;
  }

  destroy(): void {
    this.active = false;
  }

  handleEvent(payload: NativeHangPayload): void {
    if (!this.active) return;

    try {
      this.queueEvent(this.buildEvent(payload));
      // A recovered hang often precedes a force-quit or an OS kill, and the
      // default batch timeout would lose it. Same reasoning as the fatal-JS
      // path in the errors listener.
      this.eventsPool.flush({ lifecycle: true });
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent(payload: NativeHangPayload): EnrichedEvent<CoreEventType | RNExtraEventType> {
    const durationMs = Math.max(0, Math.round(payload.durationMs));
    // "ANR" is Android's own term for this and what its docs/tooling use;
    // "AppHang" is Apple's. Keeping each platform's name makes the events
    // searchable by what an engineer would actually type.
    //
    // The cost is deliberate: one stall is two `error_type`s, so a consumer must match BOTH to find
    // every hang. The README's "Querying hangs" section documents that rather than unifying the
    // value or adding a discriminator, because either alternative trades a name engineers actually
    // search for against a query that is one `IN` clause.
    const errorType = payload.kind === "anr" ? "ANR" : "AppHang";

    const attributes: ErrorEventAttributes = {
      error_type: errorType,
      error_message: `Main thread blocked for ${durationMs}ms`,
      // iOS ships no stack for a hang (capturing another thread's backtrace needs machine-context
      // code KSCrash does not expose); Android does. Either way the event is worth sending, and the
      // same predicate guards the crash-record path — see native-bridge.
      error_stacktrace: normalizeStackFrames(payload.mainThreadStack),
      error_fingerprint: `${errorType}:${bucketDuration(durationMs)}`,
      // The user could not use the app: not something anyone handled.
      error_handled: false,
      error_metadata: {
        native: true,
        hang_duration_ms: durationMs,
        hang_started_at: payload.startedAtMs,
        // Distinguishes this from the post-mortem ANR record, which reports a
        // stall the process never came back from.
        recovered: true,
      },
    };

    // WHEN THE STALL BEGAN, not now. A hang is reported only on recovery — after
    // the taps and navigations it blocked — so defaulting to the enrich-time clock
    // would place it on the timeline after them. Mirrors vitals-listener (segment
    // end) and native-crash-drain (crash time), the other native-signal paths.
    return this.enricher.enrich({
      type: "exception",
      timestamp: msToNs(payload.startedAtMs),
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


