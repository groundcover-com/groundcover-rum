import { SDKConfigInput, SDKConfigUpdate } from "../config/types";
import { InstrumentationManager } from "../events/instrumentation-manager";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { BROWSER_CONFIG_EXTENSION } from "../config/config-extension";
import { isDomNode } from "../common/dom-node";
import { UserIdentifiers, LogLevel } from "@groundcover/rum-core/events/types";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";
import { Transporter, encodeInline } from "@groundcover/rum-core/transporter/transporter";
import { WorkerClient } from "../worker/worker-client";
import { RandomIdGenerator } from "@groundcover/rum-core/common/id-generator";
import { handleError } from "@groundcover/rum-core/common/error-handler";
import { safeWarn } from "@groundcover/rum-core/common/safe-warn";

import { Logger } from "@groundcover/rum-core/common/logger";
import { msToNs } from "@groundcover/rum-core/common/global";
import { SafeStorage } from "@groundcover/rum-core/common/storage";
import { SessionState } from "@groundcover/rum-core/session/session-state";
import {
  bootstrapSession,
  resolveSamplingDecision,
} from "@groundcover/rum-core/session/bootstrap";
import {
  getSessionStoragePlatform,
  makeWebViewProvider,
  getWebDeviceAttributes,
} from "@/platform/web-platform";

// Event types that never trigger an immediate size-based flush on the
// browser — interactions/navigations ride along with the next flushing event.
const BROWSER_EVENTS_TO_SKIP_FLUSH = ["navigation", "dom.event"] as const;

// The full set of per-init collaborators, built together in the constructor
// and set ATOMICALLY: `core` is either null (not initialized / not sampled /
// destroyed) or every handle is live. Public methods guard on this one field
// instead of per-field null checks.
interface CoreHandles {
  config: ConfigManager;
  session: SessionState;
  pool: EventsPool;
  instrumentation: InstrumentationManager;
}

// SessionManager is the browser SDK's COMPOSITION ROOT: it constructs every
// core object (config, session state, pool, transporter, enricher,
// instrumentation) and wires the browser-specific implementations
// (sessionStorage, UA device attributes, location view provider, worker-backed
// encoding, visibilitychange hide-wiring) into them. Everything below this
// layer takes its collaborators through its constructor, with two deliberate
// exceptions: the internal debug Logger (ambient console wrapper — injecting
// it is viral churn for zero platform gain) and the browser-only WorkerClient
// singleton.
export class SessionManager {
  private logger: ReturnType<typeof Logger.initialize>;
  private readonly storage: SafeStorage;
  private idGenerator: RandomIdGenerator;
  private core: CoreHandles | null = null;
  private hideWired = false;

  // App-hide wiring (host-driven — core exposes only the public methods this
  // calls). Persist the EXACT activity timestamp (steady-state writes are
  // throttled, so a reload could otherwise read a value up to a minute stale
  // and gap-rotate that much early), then flush synchronously so the fetch is
  // queued before the browser can freeze the tab being hidden / closed.
  private hideHandler = (): void => {
    // Contained: runs as a document event handler in arbitrary embeds — a
    // throwing visibilityState read must not leak into the host app.
    try {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        return;
      }
      this.core?.session.persistLastActivity();
      this.core?.pool.flush({ lifecycle: true });
    } catch (error) {
      handleError(error);
    }
  };

  constructor(config: SDKConfigInput) {
    this.logger = Logger.initialize({
      debug: config.options?.debug || false,
      prefix: "[groundcover]",
    });

    this.logger.log("[session-manager] initialize called");

    this.storage = new SafeStorage(getSessionStoragePlatform());
    this.idGenerator = new RandomIdGenerator();

    const configManager = new ConfigManager(BROWSER_CONFIG_EXTENSION);
    configManager.initialize(config);

    const sessionState = new SessionState({
      storage: this.storage,
      getMaxDurationMs: () => configManager.getConfig()?.options?.sessionMaxDuration,
    });

    // Resolve session identity + init-time expiry BEFORE reading the sampling
    // verdict. bootstrapSession is the ONLY place that clears a persisted
    // verdict when the session rotates — a different provided id, or a session
    // that expired / went idle across a reload. If sampling were resolved
    // first, a stored "0" would take the early return below before the session
    // it belongs to could re-roll, pinning that browser sampled-out for the
    // whole storage lifetime instead of once per session.
    bootstrapSession({
      session: sessionState,
      idGenerator: this.idGenerator,
      providedSessionId: config.sessionId,
    });

    const shouldSampleSession = resolveSamplingDecision({
      storage: this.storage,
      sessionSampleRate: config.options?.sessionSampleRate,
    });

    if (!shouldSampleSession) {
      this.logger.log("[session-manager] session is not sampled");
      return;
    }

    const transporter = new Transporter({
      config: configManager,
      // The browser's network primitive. Resolved at call time rather than
      // captured, so a host that installs its own fetch after init still sees
      // it (and so our own network listener can instrument around it).
      sendBatch: (endpoint, request) => fetch(endpoint, request),
      // Browser-only optimization: offload gzip to the Web Worker, falling
      // back to the universal inline path on any worker failure.
      encodeAsync: (data, enableCompression) =>
        WorkerClient.withFallback(
          (worker) => worker.encodeBatch(data, enableCompression),
          () => encodeInline(data, enableCompression),
          "transporter",
        ),
    });

    const eventsPool = new EventsPool({
      config: configManager,
      session: sessionState,
      transporter,
      getDeviceAttributes: getWebDeviceAttributes,
      eventsToSkipFlush: BROWSER_EVENTS_TO_SKIP_FLUSH,
    });

    // Core knows nothing about "the current view" — it merges whatever this
    // returns into every event's attributes. The browser's contribution is the
    // `location` block, which is what keeps the wire payload unchanged.
    const getCurrentView = makeWebViewProvider(configManager);
    const enricher = new EventEnricher({
      enrichAttributes: () => ({ location: getCurrentView() }),
      reservedAttributeKeys: ["location"],
      isOpaqueNode: isDomNode,
      idGenerator: this.idGenerator,
    });

    const instrumentationManager = new InstrumentationManager({
      config: configManager,
      session: sessionState,
      eventsPool,
      enricher,
    });

    // Everything past this point arms live resources (pool heartbeat timer,
    // document listener, DOM instrumentation). `core` is assigned LAST, so a
    // mid-startup throw would strand them beyond destroy()'s reach — tear
    // them down here and leave the SDK cleanly uninitialized instead of
    // leaking a timer/listener into the host app. Contained: init must never
    // crash the host.
    try {
      eventsPool.initialize();

      // Warm the worker now so the first flush doesn't pay the spawn cost.
      // Sampling already gated this — non-sampled sessions never reach here.
      WorkerClient.getInstance();

      this.wireHideHandler();

      instrumentationManager.instrument();

      this.core = {
        config: configManager,
        session: sessionState,
        pool: eventsPool,
        instrumentation: instrumentationManager,
      };
    } catch (error) {
      this.logger.log("[session-manager] initialization failed — tearing down partial startup:", error);
      // destroy()-ordered teardown of THIS constructor's resources only.
      // - Session STORAGE is kept: it's valid state for a retry init, and a
      //   failed init must not erase the user's session id.
      // - The shared WorkerClient is NOT terminated: it's a page-global a retry
      //   init will reuse, and an idle freshly-warmed worker is harmless.
      try {
        instrumentationManager.uninstrument();
      } catch (teardownError) {
        handleError(teardownError);
      }
      eventsPool.destroy();
      this.unwireHideHandler();
      this.core = null;
      // Rethrow so the `manager = new SessionManager(...)` assignment in init()
      // never completes; init()'s try/catch contains it at the public boundary.
      throw error;
    }
  }

  private wireHideHandler(): void {
    if (this.hideWired || typeof document === "undefined") return;
    this.hideWired = true;
    try {
      document.addEventListener("visibilitychange", this.hideHandler);
    } catch (error) {
      handleError(error);
    }
  }

  private unwireHideHandler(): void {
    if (!this.hideWired || typeof document === "undefined") return;
    this.hideWired = false;
    try {
      document.removeEventListener("visibilitychange", this.hideHandler);
    } catch (error) {
      handleError(error);
    }
  }

  identifyUser(userIdentifier: Partial<UserIdentifiers>) {
    this.logger.log("[session-manager] identifyUser called");

    if (!this.core) {
      this.logger.log(
        "[session-manager] cannot identify user: SDK not initialized"
      );
      return;
    }

    this.core.config.updateConfig({ user: userIdentifier });
  }

  updateConfig(params: SDKConfigUpdate) {
    try {
      if (params === null || typeof params !== "object") {
        safeWarn(
          "[groundcover] updateConfig requires a configuration object; the update was ignored."
        );
        return;
      }
      if ("appId" in params) {
        safeWarn(
          "[groundcover] updateConfig does not accept appId; the entire update was ignored. Remove appId from the update."
        );
        return;
      }

      if (!this.core) {
        this.logger.log("[session-manager] cannot update config: SDK not initialized");
        return;
      }

      this.core.config.updateConfig(params);

      // rrweb mask/block selectors and canvas options are fixed at record() time. If this update
      // touched a record()-time replay option, restart the active replay so it
      // applies (non-replay events pick up privacy automatically via getPrivacy()).
      // Own keys only, matching SDKConfig's merge: an inherited key never changes
      // the effective config, so restarting for it would only split the recording.
      const opts = params.options;
      const privacyChanged = !!opts && Object.hasOwn(opts, "privacy");
      // `replay.blockedSelectors` (→ rrweb `blockSelector`) and `replay.canvas`
      // (→ rrweb `recordCanvas`/`sampling.canvas`/`dataURLOptions`) are both fixed
      // at record() time, so a runtime change to either needs a restart too —
      // same as privacy.
      const replay =
        !!opts
        && Object.hasOwn(opts, "replay")
        && typeof opts.replay === "object"
        && opts.replay !== null
          ? opts.replay
          : undefined;
      const blockedSelectorsChanged = !!replay && Object.hasOwn(replay, "blockedSelectors");
      const canvasChanged = !!replay && Object.hasOwn(replay, "canvas");
      if (privacyChanged || blockedSelectorsChanged || canvasChanged) {
        this.core.instrumentation.restartReplayForConfigChange();
      }
    } catch (error) {
      handleError(error);
    }
  }

  sendCustomEvent(event: {
    event: string;
    attributes: Record<string, unknown>;
  }) {
    if (!this.core) {
      this.logger.log(
        "[session-manager] cannot send custom event: SDK not initialized"
      );
      return;
    }

    this.core.instrumentation.sendCustomEvent(event);
  }

  startNavigation(metadata: Record<string, unknown>) {
    if (!this.core) {
      this.logger.log("[session-manager] cannot start navigation: SDK not initialized");
      return;
    }

    this.core.instrumentation.startNavigation(metadata);
  }

  endNavigation(metadata: Record<string, unknown>) {
    if (!this.core) {
      this.logger.log("[session-manager] cannot end navigation: SDK not initialized");
      return;
    }

    this.core.instrumentation.endNavigation(metadata);
  }

  captureException(error: unknown, metadata?: Record<string, unknown>) {
    if (!this.core) {
      this.logger.log(
        "[session-manager] Cannot capture exception: SDK not initialized"
      );
      return;
    }

    this.core.instrumentation.captureException(error, metadata);
  }

  emitLog(
    message: string,
    level: LogLevel,
    attributes?: Record<string, unknown>
  ) {
    if (!this.core) {
      this.logger.log(
        "[session-manager] Cannot emit log: SDK not initialized"
      );
      return;
    }

    this.core.instrumentation.emitLog(message, level, attributes);
  }

  getSessionId(): string {
    if (!this.core) {
      this.logger.log(
        "[session-manager] cannot get session ID: SDK not initialized"
      );
      return "";
    }

    return this.core.session.getSessionId();
  }

  async setSessionId(newSessionId?: string) {
    this.logger.log("[session-manager] setSessionId called");

    if (!this.core) {
      this.logger.log(
        "[session-manager] cannot set session ID: SDK not initialized"
      );
      return;
    }

    try {
      // Sync-drain any pending scheduled replay batch before the id flip so
      // a setTimeout(0) pack can't enqueue under the new id.
      this.core.instrumentation.flushPendingReplay();

      await this.core.pool.flushSync();

      const sessionId = newSessionId || this.idGenerator.generateId();

      this.core.session.setSessionId(sessionId);
      this.core.session.setSessionStartTime(msToNs(Date.now()));

      this.logger.log("[session-manager] session ID set successfully:", sessionId);
    } catch (error) {
      this.logger.log("[session-manager] failed to set session ID:", error);
    }
  }

  startReplayRecording(): void {
    if (!this.core) {
      this.logger.log("[session-manager] cannot start replay recording: SDK not initialized");
      return;
    }

    this.core.instrumentation.startReplayRecording();
  }

  stopReplayRecording(): void {
    if (!this.core) {
      this.logger.log("[session-manager] cannot stop replay recording: SDK not initialized");
      return;
    }

    this.core.instrumentation.stopReplayRecording();
  }

  // Full teardown for a clean shutdown (SPA unmount / logout): stop
  // instrumentation, drop the buffer, unwire the hide handler, terminate the
  // shared worker, and forget the session.
  destroy() {
    const core = this.core;
    if (!core) {
      return;
    }

    core.instrumentation.uninstrument();
    core.pool.destroy();
    this.unwireHideHandler();
    // terminate() drops the singleton so a future manager gets a fresh worker.
    WorkerClient.getInstance().terminate();
    core.session.clearSessionState();
    this.core = null;
  }
}
