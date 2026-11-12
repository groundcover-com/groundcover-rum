import {
  ConfigManager,
  EventEnricher,
  EventsPool,
  handleError,
  LogEventsListener,
  ManualEventEmitter,
  RandomIdGenerator,
  SessionLifecycle,
  SessionState,
  type LogLevel,
} from "@groundcover/rum-core";

import {
  RN_ACTIVITY_EVENT_TYPES,
  RN_IGNORED_EVENT_TYPES,
  type RNEventType,
  type RNExtraEventType,
} from "./rn-event-types";
import { reportSafely } from "../internal/report-safely";
import { NetworkEventsListener } from "./listeners/network-events-listener";
import { ErrorsEventsListener } from "./listeners/errors-events-listener";
import { InteractionListener } from "./listeners/interaction-listener";
import {
  NavigationTracker,
  type NavigationContainerRefLike,
  type ScreenHolder,
} from "./listeners/navigation-tracker";
import type { ScreenAttributes } from "./rn-event-types";
import { RNPresenceMonitor } from "./rn-presence-monitor";
import { HangsEventsListener } from "./listeners/hangs-listener";
import { AppStartListener } from "./listeners/app-start-listener";
import { VitalsEventsListener } from "./listeners/vitals-listener";
import { NativeSignalsRouter } from "./native-signals-router";
import { markAutoInteractive } from "../internal/interactive-mark";
import { resolveTtiSource } from "../config/constants";
import type { GroundcoverNativeModule } from "../platform/native-types";
import { flushFrameSegment } from "../platform/native-bridge";
import {
  installTextInputInstrumentation,
  uninstallTextInputInstrumentation,
} from "../react/text-input-instrumentation";
import { getTouchHistory, type RawGesture, type RawInput } from "../internal/touch-bridge";
import { correlateGesture } from "./gesture-correlation";
import {
  shouldSuppressJsGesture,
  NO_NATIVE_COVERAGE,
  type NativeGestureCoverage,
} from "./gesture-suppression";
import { EMPTY_WALK } from "../react/fiber-walk";
import type {
  NativeGesturePayload,
  NativeGesturesAttachedPayload,
} from "../platform/native-types";

export interface InstrumentationManagerDeps {
  config: ConfigManager;
  session: SessionState;
  eventsPool: EventsPool<RNEventType>;
  enricher: EventEnricher;
  screenHolder: ScreenHolder;
  /**
   * Fired after a session rotation mints a new id. The composition root uses it
   * to re-push the session envelope to native, so a crash after a rotation is
   * attributed to the new session rather than the retired one.
   */
  onSessionIdentityChanged?: () => void;
  /** Absent in Expo Go and in any binary predating the native package — the
   *  native-backed listeners then simply never arm. */
  nativeModule?: GroundcoverNativeModule | null;
}

// RN's instrumentation orchestrator (mirror of the browser's): constructs and
// owns the listeners and the presence monitor. Session POLICY (reconciliation,
// rotation, the ghost gate) is delegated to the platform-agnostic
// SessionLifecycle — this class only feeds it presence and reacts to config.
//
// TRotationContext is `void`: RN ships no replay, so there is nothing to
// capture/restore around a rotation.
export class RNInstrumentationManager {
  private readonly configManager: ConfigManager;
  private readonly session: SessionState;
  private readonly eventsPool: EventsPool<RNEventType>;
  private readonly enricher: EventEnricher;
  private readonly screenHolder: ScreenHolder;
  private readonly lifecycle: SessionLifecycle<void, RNEventType>;
  private readonly manualEvents: ManualEventEmitter<RNExtraEventType>;
  private readonly presenceMonitor: RNPresenceMonitor;
  private idGenerator = new RandomIdGenerator();

  private logEventsListener: LogEventsListener<RNExtraEventType> | null = null;
  private networkEventsListener: NetworkEventsListener | null = null;
  private errorsEventsListener: ErrorsEventsListener | null = null;
  private interactionListener: InteractionListener | null = null;
  private navigationTracker: NavigationTracker | null = null;
  private hangsListener: HangsEventsListener | null = null;
  private appStartListener: AppStartListener | null = null;
  private vitalsListener: VitalsEventsListener | null = null;
  private nativeSignals: NativeSignalsRouter | null = null;
  private readonly nativeModule: GroundcoverNativeModule | null;
  private nativeCoverage: NativeGestureCoverage = NO_NATIVE_COVERAGE;
  private screenChangeUnsub: (() => void) | null = null;
  private instrumented = false;

  /**
   * Bumped by every `instrument()`, so work that outlives the run which scheduled it can tell.
   *
   * `instrumented` alone cannot: a Metro reload is `uninstrument()` then `instrument()`, after
   * which it is true again — so a promise that resolves across the reload would pass a liveness
   * check and be reported under the NEW session. The native engines carry the same guard for the
   * same reason (`GCRumEngine.startGeneration` / `isCurrentRun`).
   */
  private instrumentGeneration = 0;

  constructor(deps: InstrumentationManagerDeps) {
    this.configManager = deps.config;
    this.session = deps.session;
    this.eventsPool = deps.eventsPool;
    this.enricher = deps.enricher;
    this.screenHolder = deps.screenHolder;
    this.nativeModule = deps.nativeModule ?? null;

    this.manualEvents = new ManualEventEmitter<RNExtraEventType>({
      config: this.configManager,
      pool: this.eventsPool,
      enricher: this.enricher,
    });

    const onSessionIdentityChanged = deps.onSessionIdentityChanged;
    this.lifecycle = new SessionLifecycle<void, RNEventType>({
      session: this.session,
      pool: this.eventsPool,
      idGenerator: this.idGenerator,
      activityEventTypes: RN_ACTIVITY_EVENT_TYPES,
      ignoredEventTypes: RN_IGNORED_EVENT_TYPES,
      hooks: onSessionIdentityChanged
        ? { afterRotate: () => onSessionIdentityChanged() }
        : undefined,
    });

    // AppState "active" transitions feed reconcile() — the browser's raw-DOM-
    // input presence source has no RN analogue, so AppState + taps carry it.
    this.presenceMonitor = new RNPresenceMonitor(this.lifecycle);
  }

  private listenerDeps() {
    return {
      config: this.configManager,
      eventsPool: this.eventsPool,
      enricher: this.enricher,
    };
  }

  private isEnabled(name: string): boolean {
    const configured = this.configManager.getConfig()?.options?.enabledEvents;
    return !configured || configured.length === 0 || configured.includes(name);
  }

  instrument(): void {
    // Idempotent: a second instrument() (e.g. an RN fast-refresh re-run) must not
    // re-install listeners — that would re-patch globals and orphan the first
    // set's patches, so uninstrument() could no longer restore them.
    if (this.instrumented) return;
    this.instrumented = true;
    // Identifies THIS run for work that outlives the thread of control which scheduled it — see
    // the field. Bumped inside the idempotence guard, so a no-op second call does not invalidate
    // work the first one legitimately started.
    this.instrumentGeneration += 1;

    // Arm session policy (enqueue-hook reconciliation + ghost-session flush
    // gate) BEFORE listeners, so the gate is in place before the first event.
    this.lifecycle.install();
    this.presenceMonitor.initialize();

    if (this.isEnabled("logs")) {
      this.logEventsListener = new LogEventsListener<RNExtraEventType>(this.listenerDeps());
      this.logEventsListener.initialize();
    }
    if (this.isEnabled("network")) {
      this.networkEventsListener = new NetworkEventsListener(this.listenerDeps());
      this.networkEventsListener.initialize();
    }
    if (this.isEnabled("exceptions")) {
      // Automatic uncaught-JS-error capture (via ErrorUtils) + the manual
      // captureException path. Gated by enabledEvents like the browser.
      this.errorsEventsListener = new ErrorsEventsListener(this.listenerDeps());
      this.errorsEventsListener.initialize();
    }
    if (this.isEnabled("interaction")) {
      this.interactionListener = new InteractionListener(this.listenerDeps());
      this.interactionListener.initialize();
      // Automatic typing capture: patch TextInput so a finished edit emits an
      // `input` interaction. Best-effort — a patch failure never blocks taps.
      installTextInputInstrumentation((input) => this.reportInput(input));
    }

    // Gated by "navigation" like every other listener: when it's excluded from
    // enabledEvents the tracker isn't built, so BOTH auto tracking and the manual
    // startNavigation/endNavigation API no-op (the `?.` calls below hit null).
    if (this.isEnabled("navigation")) {
      this.navigationTracker = new NavigationTracker({
        ...this.listenerDeps(),
        screenHolder: this.screenHolder,
      });
    }

    this.instrumentNativeSignals();

    // React to navigation HERE rather than from a decorator in the composition root: anchor
    // TTI on the first landing, and close the outgoing screen's frame segment on every change.
    //
    // ORDER AGAINST THE ROOT'S SUBSCRIBER (the native snapshot push) DOES NOT MATTER — it is not a
    // dependency anybody must preserve. Two independent reasons: the segment's screen is passed
    // EXPLICITLY as `outgoing` rather than read from the session snapshot, and
    // [flushFrameSegmentForScreen] resolves asynchronously, so its continuation lands after the
    // holder's notify loop has ended whichever order the listeners ran in. The push and this
    // subscriber touch different state — native's crash envelope versus a JS event's attributes —
    // and neither reads the other's.
    this.screenChangeUnsub = this.screenHolder.subscribe(({ outgoing, incoming, isFirstScreen }) => {
      // Self-contain: this runs inside the ScreenHolder's set(), which the host drives on every
      // navigation. notifyScreenLanded() runs a pending app-start callback whose event builder
      // can throw; a throw here must never reach the navigation caller (never break the host
      // app: CONTRIBUTING.md), regardless of
      // whether that particular holder happens to isolate its listeners.
      try {
        if (isFirstScreen) {
          // The automatic TTI anchor and any held-back app-start metric key on the first landing.
          if (incoming.name) this.notifyScreenLanded(Date.now());
          return;
        }
        // No outgoing screen to attribute anything to on the first landing, and native has had no
        // time to count a frame; every later change closes the segment under the screen being left.
        this.flushFrameSegmentForScreen(outgoing);
      } catch (error) {
        reportSafely(error);
      }
    });
  }

  // Native-backed listeners. All no-ops without the native module, which is the
  // Expo Go path — the JS SDK above is complete on its own.
  private instrumentNativeSignals(): void {
    const native = this.nativeModule;
    if (!native) return;

    if (this.isEnabled("hangs")) {
      this.hangsListener = new HangsEventsListener(this.listenerDeps());
      this.hangsListener.initialize();
    }
    if (this.isEnabled("appStart")) {
      // `unknown`, not a cast to the union: the value is host-supplied config, and asserting the
      // union here would let `"Manual"` through as auto. `resolveTtiSource` is the check.
      const options = this.configManager.getConfig()?.options as
        | { native?: { tti?: unknown } }
        | undefined;
      this.appStartListener = new AppStartListener({
        ...this.listenerDeps(),
        screenHolder: this.screenHolder,
        ttiSource: resolveTtiSource(options?.native?.tti),
        idGenerator: this.idGenerator,
      });
      this.appStartListener.initialize();
    }

    if (this.isEnabled("vitals")) {
      this.vitalsListener = new VitalsEventsListener({
        ...this.listenerDeps(),
        idGenerator: this.idGenerator,
        // The idle gate (see VitalsEventsListener). Read live, through the same rule gap rotation
        // uses, so the emitter and the lifecycle cannot disagree on when the session went quiet.
        isSessionInactive: () => this.session.isSessionInactive(Date.now()),
      });
      this.vitalsListener.initialize();
    }

    // Always route when native is present: an unregistered handler is a no-op in the router
    // (see its dispatch), so a "no listener armed" guard here would only duplicate that — and
    // need editing every time a native-backed listener is added. The subscription is one
    // emitter listener, torn down in uninstrument().
    //
    // REUSE a router that a previous uninstrument() could not detach (see there): a fresh one
    // would add a SECOND emitter subscription while the first is still live, so every native
    // signal would fire twice. Its initialize() below no-ops when the subscription survives, and
    // its handlers deref the current listeners live, so the reused router routes to this cycle's.
    this.nativeSignals ??= new NativeSignalsRouter(native);
    this.nativeSignals.initialize({
      hang: (payload) => this.hangsListener?.handleEvent(payload),
      app_start: (payload) => this.appStartListener?.handleEvent(payload),
      frame_segment: (payload) => this.vitalsListener?.handleEvent(payload),
      gesture: (payload) => this.handleNativeGesture(payload),
      gestures_attached: (payload) => this.setNativeGesturesAttached(true, payload),
    });
  }

  /**
   * A gesture the NATIVE tracker measured. Native supplies the kinematics, having watched the
   * gesture past where the JS stream was cancelled; JS supplies the labels native cannot produce
   * for an RCTView, recovered from the touch it grew out of. When correlation finds nothing the
   * event still ships with an empty target: unlabelled beats missing.
   */
  private handleNativeGesture(payload: NativeGesturePayload): void {
    // Contained end to end: this runs inside the NativeEventEmitter callback. The router already
    // catches a handler throw, but it reports via handleError — which can ITSELF throw (a broken
    // host logger) and escape into React Native. Guarding here with a reporter that never rethrows
    // keeps both the handling AND the reporting off the host's dispatch (never break the host
    // app: CONTRIBUTING.md).
    try {
      // A gesture confirms presence even when interaction capture is disabled or beforeSend drops it.
      this.lifecycle.reconcile(Date.now(), true);
      const correlated = correlateGesture(payload, getTouchHistory());

      // Mapped to the one interaction shape here, at the boundary, so native rides the same
      // listener, builder and masking as every JS touch instead of a parallel path of its own.
      this.interactionListener?.handleEvent({
        kind: payload.kind,
        // Where the finger LANDED: that identifies the element, not where it was
        // lifted after scrolling half a screen away.
        x: payload.startX,
        y: payload.startY,
        target: correlated ?? EMPTY_WALK,
        captureSource: "native",
        startedAtMs: payload.startedAtMs,
        direction: payload.direction,
        // Native carries raw floats where the JS classifier already rounds; round here so one
        // field does not mean two different precisions depending on who measured it.
        distanceDp: Math.round(payload.distanceDp),
        velocityDpS: Math.round(payload.velocityDpS),
        durationMs: Math.max(0, Math.round(payload.endedAtMs - payload.startedAtMs)),
        pointerCount: payload.pointerCount,
        // Native watches the gesture through to its end, so its numbers are never lower bounds.
        partial: false,
      });
    } catch (error) {
      reportSafely(error);
    }
  }

  /**
   * The first screen landed. Two things depend on it: the automatic TTI anchor,
   * and any app-start metric held back so it can be attributed to the screen
   * the user actually arrived on. Driven by the screen-change subscription in instrument().
   */
  private notifyScreenLanded(nowMs: number): void {
    markAutoInteractive(nowMs);
    this.appStartListener?.notifyScreenKnown();
  }

  /**
   * The screen is changing: close the open frame segment and report it under the screen
   * being LEFT. A pull, because a native push crosses the bridge asynchronously and would
   * be stamped with the destination — drawing a stuttering transition under the screen
   * the user just arrived at. Fire-and-forget: a screen change must never wait on native.
   * Driven by the screen-change subscription in instrument().
   */
  private flushFrameSegmentForScreen(outgoing: ScreenAttributes): void {
    const native = this.nativeModule;
    if (!native || !this.vitalsListener) return;

    // Captured BEFORE the hop, checked after it. `this.vitalsListener?.` is a live read, so without
    // this a segment answered by native across an `uninstrument()`/`instrument()` pair lands on the
    // REPLACEMENT listener — reporting the previous screen's frames under the new session, with the
    // old screen's name stamped on them. A Metro reload is exactly that pair, so it is the common
    // path in development rather than an exotic race.
    const generation = this.instrumentGeneration;
    // And the SESSION, for the same reason one step finer. The generation only changes on
    // uninstrument/instrument, so it cannot see a rotation — and the pool stamps the session at SEND
    // time, so a segment enqueued after one ships under the id that replaced the session whose
    // frames it measured. Dropping is the only correct option left: the old id is already retired.
    const sessionId = this.session.getSessionId();

    void flushFrameSegment(native)
      .then((segment) => {
        if (!segment || generation !== this.instrumentGeneration) return;
        if (this.session.getSessionId() !== sessionId) return;
        this.vitalsListener?.handleEvent(segment, outgoing);
      })
      .catch(handleError);
  }

  // A touch confirms presence independently of event capture and beforeSend filtering.
  reportPresence(nowMs: number): void {
    this.lifecycle.reconcile(nowMs, true);
  }

  /**
   * An interaction the JS classifier resolved — a tap or a gesture. Movement kinds are
   * suppressed once the native tracker is confirmed attached; that policy lives in
   * {@link shouldSuppressJsGesture}.
   */
  reportInteraction(interaction: RawGesture): void {
    // Stamp presence before capture controls can drop the interaction.
    this.lifecycle.reconcile(Date.now(), true);
    if (shouldSuppressJsGesture(interaction, this.nativeCoverage)) return;
    this.interactionListener?.handleEvent(interaction);
  }

  /**
   * Records that the native gesture tracker actually attached — driven by its own
   * `gestures_attached` signal, NOT `nativeInit`'s status, which resolves before any recognizer
   * exists. Suppressing on the status would drop every scroll until the attach lands, or forever
   * if it never does. Erring towards NOT suppressing: a JS gesture has worse numbers than a native
   * one, but a gesture reported by nobody is a hole in the timeline.
   */
  setNativeGesturesAttached(attached: boolean, payload?: NativeGesturesAttachedPayload): void {
    // `coversAllSurfaces` is the tracker's own statement of reach, and a MISSING one is read as
    // false: an older binary that predates the field cannot promise coverage it was never asked
    // about, and guessing yes there would drop modal gestures on exactly the builds least able
    // to report them.
    this.nativeCoverage = {
      attached,
      coversAllSurfaces: attached ? payload?.coversAllSurfaces === true : false,
    };
  }

  // A finished text-field edit from the TextInput patch. Stamp presence before building
  // the event so beforeSend filtering cannot prevent session confirmation.
  reportInput(input: RawInput): void {
    this.lifecycle.reconcile(Date.now(), true);
    this.interactionListener?.handleInputEvent(input);
  }

  sendCustomEvent(event: { event: string; attributes: Record<string, unknown> }): void {
    this.manualEvents.sendCustomEvent(event);
  }

  // Manually report a handled error. A no-op when "exceptions" isn't enabled
  // (mirrors the browser's captureException → errorsEventsListener gate).
  captureException(error: unknown, metadata?: Record<string, unknown>): void {
    this.errorsEventsListener?.captureException(error, metadata);
  }

  emitLog(message: string, level: LogLevel, attributes?: Record<string, unknown>): void {
    // Respect enabledEvents: if the log listener wasn't installed, explicit
    // logger.* calls are a no-op too (mirrors the browser).
    if (!this.logEventsListener) return;
    this.manualEvents.emitLog(message, level, attributes);
  }

  startNavigation(metadata?: Record<string, unknown>): void {
    this.navigationTracker?.startNavigation(metadata);
  }

  endNavigation(metadata?: Record<string, unknown>): void {
    this.navigationTracker?.endNavigation(metadata);
  }

  startNavigationTracking(ref: NavigationContainerRefLike): void {
    this.navigationTracker?.startTracking(ref);
  }

  stopNavigationTracking(): void {
    this.navigationTracker?.stopTracking();
  }

  uninstrument(): void {
    // The lifecycle owns teardown ordering: enqueue hook cleared before listener
    // teardown, flush gate cleared after (a teardown-time enqueue must not
    // re-trigger rotation; an unconfirmed session's final batch stays gated).
    this.lifecycle.uninstall(() => {
      // Isolate each teardown: a throw from one (e.g. presenceMonitor.destroy)
      // must not strand the rest — otherwise a later step like the XHR-patch
      // restore is skipped and the global patch leaks for the app's lifetime.
      const safe = (fn: () => void) => {
        try {
          fn();
        } catch (error) {
          handleError(error);
        }
      };
      // Drop the screen-change subscription first, or a re-instrument() would stack a second
      // and fire every TTI-anchor / frame-flush twice.
      safe(() => {
        this.screenChangeUnsub?.();
        this.screenChangeUnsub = null;
      });
      safe(() => uninstallTextInputInstrumentation());
      safe(() => this.presenceMonitor.destroy());
      safe(() => this.logEventsListener?.destroy());
      safe(() => this.networkEventsListener?.destroy());
      safe(() => this.errorsEventsListener?.destroy());
      safe(() => this.interactionListener?.destroy());
      safe(() => this.navigationTracker?.destroy());
      // The emitter subscription goes FIRST among the native teardowns: leaving
      // it attached across a re-init is what makes every hang report twice.
      // Capture whether it actually detached — a failed removeListeners() leaves the listener
      // live, and treating that as detached is what lets the next instrument() stack a second.
      let nativeDetached = false;
      safe(() => {
        nativeDetached = this.nativeSignals ? this.nativeSignals.destroy() : true;
      });
      safe(() => this.hangsListener?.destroy());
      safe(() => this.appStartListener?.destroy());
      safe(() => this.vitalsListener?.destroy());
      this.logEventsListener = null;
      this.networkEventsListener = null;
      this.errorsEventsListener = null;
      this.interactionListener = null;
      this.navigationTracker = null;
      // Drop the router only once its listener is actually gone; otherwise keep it so the next
      // instrument() REUSES the still-live subscription instead of adding a second.
      if (nativeDetached) this.nativeSignals = null;
      this.hangsListener = null;
      this.appStartListener = null;
      this.vitalsListener = null;
      // The native gesture tracker is gone after teardown; clear the suppression flag so a
      // re-instrument() does not keep dropping every JS swipe/scroll until (or unless) native
      // re-broadcasts gestures_attached.
      this.nativeCoverage = NO_NATIVE_COVERAGE;
      this.instrumented = false;
    });
  }
}
