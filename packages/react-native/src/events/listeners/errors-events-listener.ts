import {
  BaseListener,
  coerceToError,
  handleError,
  shapeErrorEvent,
  type EnrichedEvent,
  type ErrorCaptureOptions,
  type CoreEventType,
} from "@groundcover/rum-core";
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

// The engine rejection tracker's shape (same options object on Hermes' native
// tracker and the JSC `promise` polyfill module).
type RejectionOptions = {
  allRejections: boolean;
  onUnhandled: (id: number, error: unknown) => void;
  onHandled: (id: number) => void;
};
type HermesWithRejection = { enablePromiseRejectionTracker?: (options: RejectionOptions) => void };
type RejectionTrackingModule = { enable?: (options: RejectionOptions) => void; disable?: () => void };

function getErrorUtils(): ErrorUtilsLike | null {
  try {
    const eu = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    return eu && typeof eu === "object" ? eu : null;
  } catch {
    return null;
  }
}

export class ErrorsEventsListener extends BaseListener<RNExtraEventType> {
  // The previous global handler, restored on destroy. `wrapped` is the handler
  // we installed, so destroy only restores when we are STILL the current handler
  // (mirrors the network/console guarded-restore discipline).
  private previousHandler: GlobalErrorHandler | undefined;
  private wrapped: GlobalErrorHandler | null = null;
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
    this.installGlobalHandler();
    this.installRejectionTracking();
  }

  private installGlobalHandler(): void {
    // Idempotent (per the contract above): if we already installed our wrapper,
    // a second initialize() must NOT re-capture it as `previousHandler` — that
    // would make destroy() restore our own wrapper and drop the host's handler.
    if (this.wrapped) return;
    const eu = getErrorUtils();
    // Only take over the global handler if we can also CAPTURE the previous one —
    // otherwise destroy() can't restore it and uncaught errors would stop
    // reaching the host redbox/crash path. Both must be functions.
    if (typeof eu?.setGlobalHandler !== "function" || typeof eu?.getGlobalHandler !== "function") {
      return;
    }
    try {
      this.previousHandler = eu.getGlobalHandler?.();
      const wrapped: GlobalErrorHandler = (error, isFatal) => {
        // Capture first (guarded), then always chain the previous handler so the
        // host's crash/redbox behavior is untouched even if we throw.
        try {
          this.handleEvent(error, { handled: false });
        } catch (e) {
          handleError(e);
        }
        // A FATAL JS error tears the process down before the pool's heartbeat /
        // size-triggered flush can fire, so the crash would be queued and lost.
        // Force a best-effort lifecycle flush (inline encode — the same
        // "going away" path AppState-background uses). Guarded so it can never
        // block chaining the host handler below.
        if (isFatal) {
          try {
            this.eventsPool.flush({ lifecycle: true });
          } catch (e) {
            handleError(e);
          }
        }
        this.previousHandler?.(error, isFatal);
      };
      this.wrapped = wrapped;
      eu.setGlobalHandler(wrapped);
    } catch (error) {
      handleError(error);
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
    const eu = getErrorUtils();
    try {
      if (eu?.setGlobalHandler && this.wrapped && eu.getGlobalHandler?.() === this.wrapped) {
        eu.setGlobalHandler(this.previousHandler ?? (() => {}));
      }
    } catch (error) {
      handleError(error);
    }
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
    this.wrapped = null;
    this.previousHandler = undefined;
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

  buildEvent(error: Error, config?: ErrorCaptureOptions): EnrichedEvent<CoreEventType | RNExtraEventType> {
    return this.enricher.enrich(shapeErrorEvent(error, config, this.config.getPrivacy()));
  }

  queueEvent(event: EnrichedEvent<CoreEventType | RNExtraEventType>): void {
    try {
      this.eventsPool.addEvent(event);
    } catch (error) {
      handleError(error);
    }
  }
}
