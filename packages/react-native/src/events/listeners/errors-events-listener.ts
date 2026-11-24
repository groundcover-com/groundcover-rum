import {
  BaseListener,
  coerceToError,
  handleError,
  shapeErrorEvent,
  msToNs,
  type ListenerDeps,
  type BaseEvent,
  type DedupeableEvent,
  type EnrichedEvent,
  type ErrorCaptureOptions,
  type CoreEventType,
} from "@groundcover/rum-core";
import { reportSafely } from "../../internal/report-safely";
import type { GroundcoverNativeModule, PendingJsFatal } from "../../platform/native-types";
import type { RNExtraEventType } from "../rn-event-types";
import { loadRejectionTracking } from "../../platform/optional-modules";

// Automatic + manual JS error capture, emitting the shared `"exception"` wire type so
// mobile errors land in the same view as web ones. Three sources: uncaught errors
// via RN's global `ErrorUtils` handler (chained, so the host's redbox survives),
// `captureException`, and unhandled rejections via the engine's rejection tracker — RN
// has no DOM `unhandledrejection` and its own tracker is a DEV-only console.warn. Native
// crashes and hangs arrive through the native module instead (native-crash-drain.ts,
// hangs-listener.ts).
//
// Version-fragile, like fiber-walk: every access is guarded, the handlers are idempotent
// and best-effort restorable, and any failure degrades to "no error capture".

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

// The subset of RN's global ErrorUtils we use, typed structurally so the SDK
// never hard-depends on react-native's ambient globals.
type ErrorUtilsLike = {
  getGlobalHandler?: () => GlobalErrorHandler | undefined;
  setGlobalHandler?: (handler: GlobalErrorHandler) => void;
};

export function observeGlobalErrors(capture: GlobalErrorHandler): (() => void) | undefined {
  try {
    const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    if (typeof utils?.getGlobalHandler !== "function" || typeof utils.setGlobalHandler !== "function") {
      return undefined;
    }
    const previous = utils.getGlobalHandler();
    let active = true;
    const handler: GlobalErrorHandler = (error, fatal) => {
      try {
        if (active) capture(error, fatal);
      } catch (failure) {
        reportSafely(failure);
      } finally {
        previous?.(error, fatal);
      }
    };
    utils.setGlobalHandler(handler);
    return () => {
      active = false;
      try {
        if (utils.getGlobalHandler?.() === handler) utils.setGlobalHandler?.(previous ?? (() => {}));
      } catch (failure) {
        reportSafely(failure);
      }
    };
  } catch (failure) {
    reportSafely(failure);
    return undefined;
  }
}

// The engine rejection tracker's shape (same options object on Hermes' native
// tracker and the JSC `promise` polyfill module).
type RejectionOptions = {
  allRejections: boolean;
  onUnhandled: (id: number, error: unknown) => void;
  onHandled: (id: number) => void;
};
type HermesWithRejection = { enablePromiseRejectionTracker?: (options: RejectionOptions) => void };
type RejectionTrackingModule = { enable?: (options: RejectionOptions) => void; disable?: () => void };

export class ErrorsEventsListener extends BaseListener<RNExtraEventType> {
  private stopObserving?: () => void;
  // Dedup keys of the fatal errors that already have a file in this run.
  private readonly savedFatals = new Set<number>();

  constructor(
    deps: ListenerDeps<RNExtraEventType>,
    private readonly native?: Pick<GroundcoverNativeModule, "writePendingCrashReport"> | null,
    private readonly onFatalSaved?: () => void
  ) {
    super(deps);
  }

  // Rejection tracking is a SEPARATE engine hook from ErrorUtils; track its own
  // install state. `rejectionModule` is set only on the JSC path (it exposes a
  // disable()); Hermes' native tracker has no un-set (single slot, no restore).
  private rejectionTrackingInstalled = false;
  private rejectionModule: RejectionTrackingModule | null = null;
  // Guards against post-destroy emission: the engine rejection trackers (esp.
  // Hermes' single, un-settable slot) keep our onUnhandled closure alive, so a
  // rejection fired after destroy() would otherwise queue into a torn-down pool.
  private active = true;

  initialize(): void {
    this.stopObserving ??= observeGlobalErrors((error, fatal) => {
      if (fatal) this.captureFatal(error, Date.now());
      else this.handleEvent(error, { handled: false });
    });
    this.installRejectionTracking();
  }

  captureFatal(error: unknown, atMs: number): void {
    try {
      const event = this.buildEvent(coerceToError(error), { handled: false }, msToNs(atMs));
      const id = event.id;
      // A fatal that already has a file is a repeat: the queue counts it, as on main.
      const hasFile = event.dedup !== undefined && this.savedFatals.has(event.dedup.key);
      this.eventsPool.addEvent(event, hasFile ? undefined : accepted => this.persistFatal(id, accepted, event.dedup?.key));
    } finally {
      this.eventsPool.flush({ lifecycle: true });
    }
  }

  private persistFatal(id: string, fatal: BaseEvent, dedupKey?: number): boolean {
    try {
      if (!this.native?.writePendingCrashReport) return false;
      const session = this.eventsPool.getSessionAttributes();
      if (!session.session_id) return false;
      // The queued events would be sent under this same session, so they are saved with the fatal.
      const record: PendingJsFatal<BaseEvent> = {
        jsFatalId: id,
        events: [...this.eventsPool.getPendingEvents(), fatal],
        sessionSnapshotJson: JSON.stringify(session),
      };
      const saved = this.native.writePendingCrashReport(id, JSON.stringify(record)) === true;
      if (saved) {
        if (dedupKey !== undefined) this.savedFatals.add(dedupKey);
        // The file now holds these events; the queue must not send them a second time.
        this.eventsPool.discardBuffer();
        this.onFatalSaved?.();
      }
      return saved;
    } catch (failure) {
      reportSafely(failure);
      return false;
    }
  }

  // Install the engine's unhandled-rejection tracker. Single-slot per engine:
  // this OVERWRITES RN's default tracker (the DEV-only "Possible Unhandled
  // Promise Rejection" warning), and — unlike ErrorUtils — there is no getter to
  // chain/restore the previous one. That is accepted: a structured `exception`
  // with a stack beats an unreliable dev console.warn.
  private installRejectionTracking(): void {
    if (this.rejectionTrackingInstalled) return;
    const options: RejectionOptions = {
      // Report every rejection unhandled past a tick; the engine already delays
      // before firing, so a synchronously-caught rejection won't reach us.
      allRejections: true,
      onUnhandled: (_id, error) => this.handleRejection(error),
      onHandled: () => {
        // A late-attached handler resolved it. We report on unhandled and don't
        // retract; no-op (kept for the tracker's expected shape).
      },
    };
    try {
      // Hermes (default engine): native tracker. The JSC `promise` polyfill
      // module can't hook Hermes' native Promise, so this path must come first.
      const hermes = (globalThis as { HermesInternal?: HermesWithRejection }).HermesInternal;
      if (typeof hermes?.enablePromiseRejectionTracker === "function") {
        hermes.enablePromiseRejectionTracker(options);
        this.rejectionTrackingInstalled = true;
        return;
      }
      // JSC / older engines: RN's bundled `promise` polyfill IS the global
      // Promise, so its rejection-tracking module hooks it.
      const mod = loadRejectionTracking<RejectionTrackingModule>();
      if (typeof mod?.enable === "function") {
        mod.enable(options);
        this.rejectionModule = mod;
        this.rejectionTrackingInstalled = true;
      }
    } catch (error) {
      handleError(error);
    }
  }

  destroy(): void {
    this.stopObserving?.();
    this.stopObserving = undefined;
    // Best-effort rejection-tracking teardown: only the JSC polyfill module
    // exposes disable(); Hermes' native tracker has no un-set (single slot),
    // so we simply stop being able to re-install and leave it in place.
    try {
      this.rejectionModule?.disable?.();
    } catch (error) {
      handleError(error);
    }
    this.rejectionModule = null;
    this.rejectionTrackingInstalled = false;
    // Last: a still-armed engine tracker (Hermes' un-settable slot) may fire our
    // closure after this — the guard makes those late calls no-ops.
    this.active = false;
  }

  // The unhandled-rejection entry. A non-Error rejection reason gets a distinct
  // "UnhandledRejection" type (matching the browser's grouping) instead of the
  // generic "Error"; a real Error keeps its own name. The reason is coerced
  // inside handleEvent, after its post-destroy `active` guard and inside its
  // try: the tracker calls this from a timer, where a throw is fatal.
  private handleRejection(reason: unknown): void {
    this.handleEvent(reason, { handled: false }, "UnhandledRejection");
  }

  // Public entry for groundcover.captureException — a manually reported (handled)
  // error.
  captureException(error: unknown, metadata?: Record<string, unknown>): void {
    this.handleEvent(error, { handled: true, metadata });
  }

  handleEvent(
    raw: unknown,
    config?: { handled?: boolean; metadata?: Record<string, unknown> },
    name = "Error"
  ): void {
    if (!this.active) return; // torn down — a late tracker callback must not queue
    try {
      const error = coerceToError(raw, name);
      this.queueEvent(this.buildEvent(error, config));
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent(
    error: Error,
    config?: ErrorCaptureOptions,
    timestamp?: number
  ): DedupeableEvent<CoreEventType | RNExtraEventType> {
    const shaped = shapeErrorEvent(error, config, this.config.getPrivacy());
    return this.enricher.enrich({ ...shaped, timestamp });
  }

  queueEvent(event: EnrichedEvent<CoreEventType | RNExtraEventType>): void {
    try {
      this.eventsPool.addEvent(event);
    } catch (error) {
      handleError(error);
    }
  }
}
