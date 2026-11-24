import { Logger } from "@groundcover/rum-core/common/logger";
import { handleError } from "@groundcover/rum-core/common/error-handler";
import { RandomIdGenerator } from "@groundcover/rum-core/common/id-generator";

import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";
import { ManualEventEmitter } from "@groundcover/rum-core/events/manual-event-emitter";
import { LogLevel } from "@groundcover/rum-core/events/types";

import { DomEventsListener } from "./listeners/dom-events-listener";
import { LogEventsListener } from "@groundcover/rum-core/events/listeners/logs-events-listener";
import { NetworkEventsListener } from "./listeners/network-events-listener";
import { ErrorsEventsListener } from "./listeners/errors-events-listener";
import { NavigationListener } from "./listeners/navigation-listener";
import { PageLoadListener } from "./listeners/page-load-listener";
import { PerformanceListener } from "./listeners/performance-listener";
import { SessionReplayListener } from "./listeners/session-replay-listener";

import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { UserPresenceMonitor } from "./user-presence-monitor";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { SessionState } from "@groundcover/rum-core/session/session-state";
import { SessionLifecycle } from "@groundcover/rum-core/session/session-lifecycle";
import { BaseEvent } from "@groundcover/rum-core/events/types";

// The browser's event-type policy sets, injected into the platform-agnostic
// SessionLifecycle (core has no defaults — every platform names its own).
// Only dom.event proves a human; raw input arrives via the presence monitor.
// pageload/navigation/etc prove no human.
export const BROWSER_ACTIVITY_EVENT_TYPES: ReadonlySet<BaseEvent["type"]> =
  new Set(["dom.event"]);
// rrweb replay batches ride a periodic checkout heartbeat regardless of user
// action — they must never drive session reconciliation on their own.
export const BROWSER_IGNORED_EVENT_TYPES: ReadonlySet<BaseEvent["type"]> =
  new Set(["replay"]);
// The one exception to the ghost-session gate: a session nobody interacted
// with is still sent when the page is hidden or left if it caught an exception
// (uncaught, unhandled rejection or captureException), with everything it held
// as context. An error while loading is lost otherwise when the visitor leaves
// before touching anything. Not presence: it opens only that send, and the
// session stays unconfirmed.
export const isBrowserReleasingEvent = (event: BaseEvent): boolean =>
  event.type === "exception";

export interface InstrumentationManagerDeps {
  config: ConfigManager;
  session: SessionState;
  eventsPool: EventsPool;
  enricher: EventEnricher;
}

// The browser's instrumentation orchestrator: constructs and owns the DOM
// listeners, the raw-input presence monitor, and the replay policy. Session
// POLICY (reconciliation, rotation, the ghost-session gate) is delegated to
// the platform-agnostic SessionLifecycle — this class only feeds it presence
// signals and reacts to its hooks with replay decisions.
export class InstrumentationManager {
  private logger = Logger.getInstance();
  private readonly eventsPool: EventsPool;
  private readonly configManager: ConfigManager;
  private readonly session: SessionState;
  private readonly enricher: EventEnricher;
  // Rotation context = "was replay actively recording?" — captured before the
  // rotation stops it, consumed after the id flip to resume under the new id.
  private readonly lifecycle: SessionLifecycle<boolean>;
  private readonly manualEvents: ManualEventEmitter;
  private idGenerator = new RandomIdGenerator();

  private logEventsListener: LogEventsListener | null = null;
  private domEventsListener: DomEventsListener | null = null;
  private errorsEventsListener: ErrorsEventsListener | null = null;
  private networkEventsListener: NetworkEventsListener | null = null;
  private navigationListener: NavigationListener | null = null;
  private performanceListener: PerformanceListener | null = null;
  private pageLoadListener: PageLoadListener | null = null;
  private sessionReplayListener: SessionReplayListener | null = null;
  // The app's intent for replay (set only by the public start/stop API). The
  // actual recording may be paused while desired — see syncReplayState().
  private replayDesired = false;
  private presenceMonitor: UserPresenceMonitor | null = null;

  constructor(deps: InstrumentationManagerDeps) {
    this.configManager = deps.config;
    this.session = deps.session;
    this.eventsPool = deps.eventsPool;
    this.enricher = deps.enricher;

    this.manualEvents = new ManualEventEmitter({
      config: this.configManager,
      pool: this.eventsPool,
      enricher: this.enricher,
    });

    // Wire the replay policy into the platform-agnostic lifecycle via its
    // hooks; the lifecycle owns rotation/gating, we own what replay does
    // around it.
    this.lifecycle = new SessionLifecycle<boolean>({
      session: this.session,
      pool: this.eventsPool,
      idGenerator: this.idGenerator,
      activityEventTypes: BROWSER_ACTIVITY_EVENT_TYPES,
      ignoredEventTypes: BROWSER_IGNORED_EVENT_TYPES,
      releasesOnSuspend: isBrowserReleasingEvent,
      hooks: {
        // An actively-emitting recording IS a presence signal (rrweb only
        // emits on user input / DOM changes) — captured before beforeRotate
        // stops the listener, so the recording resumes under the new id.
        captureRotationContext: () => this.isReplayRecording(),
        beforeRotate: () => this.stopReplayListener(),
        afterRotate: (wasReplayActive) => this.syncReplayState(wasReplayActive),
        // Revive a paused-but-desired recording only on presence (a dom.event
        // or raw input) — never on absence or background traffic, so an
        // unattended tab can't record an empty screen.
        onReconcile: (userPresent) => this.syncReplayState(userPresent),
        // notePresence consumes the input throttle — only genuine stamps.
        onPresenceStamped: (nowMs) => this.presenceMonitor?.notePresence(nowMs),
      },
    });
  }

  private listenerDeps() {
    return {
      config: this.configManager,
      eventsPool: this.eventsPool,
      enricher: this.enricher,
    };
  }

  instrument() {
    this.logger.log("[instrumentation-manager.instrument] called");

    // Arm the session policy (enqueue-hook reconciliation + ghost-session
    // flush gate) BEFORE the listeners below, so the gate is in place before
    // the first pageload event fires.
    this.lifecycle.install();

    // Second presence source: raw input that produces no SDK event. The
    // monitor detects presence/idleness; the policy for what they mean
    // (rotation, replay pause/revival) lives in the lifecycle + the hooks
    // above. Tear down any previous monitor first so a repeated instrument()
    // can't stack window listeners.
    this.presenceMonitor?.destroy();
    this.presenceMonitor = new UserPresenceMonitor({
      onPresence: (nowMs) => this.lifecycle.reconcile(nowMs, true),
      onIdle: () => this.pauseReplayOnIdle(),
    });
    this.presenceMonitor.initialize();

    const config = this.configManager.getConfig();
    const configuredEvents = config?.options?.enabledEvents;
    const shouldEnableAll = !configuredEvents || configuredEvents.length === 0;
    const actualEnabledEvents: string[] = [];

    if (shouldEnableAll || configuredEvents?.includes("pageload")) {
      this.pageLoadListener = new PageLoadListener(this.listenerDeps());
      this.pageLoadListener.initialize();
      actualEnabledEvents.push("pageload");
    }

    if (shouldEnableAll || configuredEvents?.includes("dom")) {
      this.domEventsListener = new DomEventsListener(this.listenerDeps());
      this.domEventsListener.initialize();
      actualEnabledEvents.push("dom");
    }

    if (shouldEnableAll || configuredEvents?.includes("logs")) {
      this.logEventsListener = new LogEventsListener(this.listenerDeps());
      this.logEventsListener.initialize();
      actualEnabledEvents.push("logs");
    }

    if (shouldEnableAll || configuredEvents?.includes("exceptions")) {
      this.errorsEventsListener = new ErrorsEventsListener(this.listenerDeps());
      this.errorsEventsListener.initialize();
      actualEnabledEvents.push("exceptions");
    }

    if (shouldEnableAll || configuredEvents?.includes("network")) {
      this.networkEventsListener = new NetworkEventsListener(this.listenerDeps());
      this.networkEventsListener.initialize();
      actualEnabledEvents.push("network");
    }

    if (shouldEnableAll || configuredEvents?.includes("performance")) {
      this.performanceListener = new PerformanceListener(this.listenerDeps());
      this.performanceListener.initialize();
      actualEnabledEvents.push("performance");
    }

    // we always initialize the navigation listener, even if it's not enabled, so we can track navigations manually
    this.navigationListener = new NavigationListener(this.listenerDeps(), { isEnabled: shouldEnableAll || configuredEvents?.includes("navigation") });
    this.navigationListener.initialize();
    actualEnabledEvents.push("navigation");


    this.logger.log(
      "[instrumentation-manager.instrument] initialized listeners based on config:",
      actualEnabledEvents
    );
  }

  sendCustomEvent(event: {
    event: string;
    attributes: Record<string, unknown>;
  }) {
    this.manualEvents.sendCustomEvent(event);
  }

  emitLog(
    message: string,
    level: LogLevel,
    attributes?: Record<string, unknown>
  ) {
    // Respect options.enabledEvents: if the log listener was not installed
    // (i.e. "logs" is not in enabledEvents), explicit logger.* calls are a
    // no-op too — mirrors the captureException → errorsEventsListener gate.
    if (!this.logEventsListener) {
      return;
    }

    this.manualEvents.emitLog(message, level, attributes);
  }

  captureException(error: unknown, metadata?: Record<string, unknown>) {
    try {
      this.logger.log(
        "[instrumentation-manager.captureException] called",
        error
      );

      this.errorsEventsListener?.captureException(error, metadata);
    } catch (error) {
      handleError(error);
    }
  }

  private isNavigationTrackingEnabled(): boolean {
    const config = this.configManager.getConfig();
    return config?.options?.enabledEvents?.includes("navigation") || config?.options?.enabledEvents?.length === 0;
  }

  startNavigation(metadata: Record<string, unknown>) {
    this.logger.log("[instrumentation-manager.startNavigation] called", metadata);

    if (this.isNavigationTrackingEnabled()) {
      this.logger.log("[instrumentation-manager.startNavigation] startNavigation called while navigation tracking is enabled. Ignoring. If you wish to track navigations manually, please disable navigation tracking via the enabledEvents array in the config.");
      return;
    }

    this.navigationListener?.startNavigation(metadata);
  }

  endNavigation(metadata: Record<string, unknown>) {
    this.logger.log("[instrumentation-manager.endNavigation] called", metadata);

    if (this.isNavigationTrackingEnabled()) {
      this.logger.log("[instrumentation-manager.endNavigation] endNavigation called while navigation tracking is enabled. Ignoring. If you wish to track navigations manually, please disable navigation tracking via the enabledEvents array in the config.");
      return;
    }

    this.navigationListener?.endNavigation(metadata);
  }

  isReplayRecording(): boolean {
    return this.sessionReplayListener !== null;
  }

  // rrweb mask options are fixed at record() time, so a runtime privacy change
  // only applies by restarting (stop flushes first, the fresh listener re-reads
  // getPrivacy()). No-op when not recording; leaves replayDesired untouched.
  restartReplayForConfigChange(): void {
    if (!this.isReplayRecording()) {
      return;
    }
    this.logger.log("[instrumentation-manager] restarting replay to apply config change");
    this.stopReplayListener();
    this.startReplayListener();
  }

  // Replay state model — one invariant, one reconciliation point:
  //
  //   recording  ⇔  replayDesired && user present
  //
  // `replayDesired` is owned EXCLUSIVELY by the public start/stop API — the
  // app's intent. The idle timer pauses the recording but never the desire.
  // syncReplayState() is the single place a paused recording comes back, and
  // both rotation and the enqueue hook just feed it their presence verdict
  // (via the SessionLifecycle hooks wired in the constructor).

  startReplayRecording(): void {
    this.replayDesired = true;

    // Already recording → genuine no-op. Must return BEFORE the stale check
    // below: a redundant start call must not mutate session boundaries (e.g.
    // a long-lived recording past the cap would otherwise rotate here).
    if (this.isReplayRecording()) {
      this.logger.log("[instrumentation-manager] replay recording already started");
      return;
    }

    // Close a STALE session BEFORE rrweb starts — a programmatic start
    // (consent callback, app timer) into a session that has conceptually
    // ended would otherwise record and buffer frames under it, and the next
    // event would then flush that stale-session batch on rotation. Rotating
    // first means recording always begins under a current session.
    this.lifecycle.rotateIfStale(Date.now(), "replay start into stale session");

    this.startReplayListener();
    // An explicit start is a fresh 30-minute lease, not an indefinite one:
    // re-arm the idle timer so a programmatic start into an already-idle tab
    // still pauses if nobody shows up — otherwise the fired-and-disarmed timer
    // would let rrweb record an empty tab forever. Idle timer ONLY — this
    // isn't a user signal, so it must not consume the input throttle and
    // suppress the user's next real scroll/key.
    this.presenceMonitor?.resetIdleTimer();
  }

  stopReplayRecording(): void {
    // Explicit stop: the app turned replay off; no presence signal may turn
    // it back on until the app calls start again.
    this.replayDesired = false;
    this.stopReplayListener();
  }

  // Sync-drain any pending scheduled replay batch into EventsPool — used by
  // setSessionId so a not-yet-fired pack/flush can't land under the new id.
  flushPendingReplay(): void {
    this.sessionReplayListener?.flushPendingSync();
  }

  // Reconcile actual recording state with desired state, given a presence
  // verdict from the caller. Restarting only on presence keeps an unattended
  // tab (background pollers, post-idle) from recording an empty screen.
  private syncReplayState(userPresent: boolean): void {
    if (this.replayDesired && userPresent && !this.isReplayRecording()) {
      this.logger.log("[instrumentation-manager] user present and replay desired — starting replay");
      this.startReplayListener();
    }
  }

  // Idle window elapsed with no user presence: pause the recording only —
  // desire is untouched, so syncReplayState() revives it on the next presence
  // signal. No eager rotation (rotating here would mint a session while
  // nobody is there); the session rotates lazily on the next presence signal
  // (inactivity-gap check in the lifecycle's reconcile).
  private pauseReplayOnIdle(): void {
    if (!this.isReplayRecording()) {
      return;
    }

    this.logger.log("[instrumentation-manager] pausing replay: user idle window elapsed");
    this.stopReplayListener();
  }

  private startReplayListener(): void {
    if (this.sessionReplayListener) {
      this.logger.log("[instrumentation-manager] replay recording already started");
      return;
    }

    try {
      const replayListener = new SessionReplayListener({
        ...this.listenerDeps(),
        session: this.session,
      });
      replayListener.initialize();
      this.sessionReplayListener = replayListener;
      this.logger.log("[instrumentation-manager] started replay recording");
    } catch (error) {
      handleError(error);
      // replayDesired stays true, so the next presence signal retries.
      this.logger.log("[instrumentation-manager] failed to start replay recording:", error);
    }
  }

  private stopReplayListener(): void {
    if (!this.sessionReplayListener) {
      this.logger.log("[instrumentation-manager] cannot stop replay recording: replay listener not initialized");
      return;
    }

    this.sessionReplayListener.stopRecording();
    this.sessionReplayListener = null;
  }

  uninstrument() {
    // The lifecycle owns the teardown ordering contract: enqueue hook cleared
    // before our listener teardown (a teardown-time enqueue must not
    // re-trigger rotation), flush gate cleared after it (so the replay
    // listener's final batch stays gated for an unconfirmed session).
    // install() re-arms both on re-init.
    this.lifecycle.uninstall(() => {
      this.presenceMonitor?.destroy();
      this.presenceMonitor = null;
      this.domEventsListener?.destroy();
      this.logEventsListener?.destroy();
      this.errorsEventsListener?.destroy();
      this.networkEventsListener?.destroy();
      this.navigationListener?.destroy();
      this.performanceListener?.destroy();
      this.pageLoadListener?.destroy();
      this.sessionReplayListener?.destroy();
      this.sessionReplayListener = null;
      // Teardown clears the desire too — a later start must be an explicit
      // opt-in, not inherited from a previous lifecycle.
      this.replayDesired = false;
    });
  }
}
