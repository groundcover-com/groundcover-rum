import { Logger, type UserIdentifiers } from "@groundcover/rum-core";
import { reportSafely } from "./internal/report-safely";

import { RNSessionManager } from "./session-manager/session-manager";
import { observeGlobalErrors } from "./platform/global-errors";
import { HydratedStorage } from "./platform/hydrated-storage";
import { RNLogger } from "./logger/logger";
import { clearTouchHistory, setTouchHandlers } from "./internal/touch-bridge";
import { safeWarn } from "./internal/safe-warn";
import { loadNativeModule } from "./platform/native-bridge";
import {
  __resetInteractiveMarkForTest,
  markManualInteractive,
} from "./internal/interactive-mark";
import { GroundcoverProvider } from "./react/GroundcoverProvider";
import type { SDKConfigInput, SDKConfigUpdate } from "./config/types";
import type { NavigationContainerRefLike } from "./events/listeners/navigation-tracker";

// Internal alias for the public `SDKConfigInput`, which is what consumers import.
// Deliberately not exported: a second exported name for the same type is surface
// area with no meaning of its own.
type InitParams = SDKConfigInput;

// Cap on calls buffered between init() and readiness. A misbehaving app that
// calls the API in a hot loop before init resolves can't grow this without
// bound; oldest is dropped first (a single warning), newest kept.
const MAX_PENDING_CALLS = 100;

let manager: RNSessionManager | null = null;
let initializedAppId: string | undefined;
let initPromise: Promise<void> = Promise.resolve();
const pendingCalls: Array<() => void> = [];
let droppedWarned = false;

const logger = new RNLogger();
// Route logger.* through the same delegate-or-buffer path as every other public
// method, so logs emitted before hydration completes are buffered (and drained
// on ready) rather than silently dropped against a not-yet-wired sink.
logger.setSink((message, level, attributes) =>
  delegateOrBuffer("logger", (m) => m.emitLog(message, level, attributes))
);

function warnNotInitialized(method: string): void {
  // safeWarn, not raw console.warn: this runs on EVERY public call before init(), the
  // hottest pre-init path, and a host that patched console.warn to throw must not turn the
  // SDK's own advisory into a crash. groundcoverIgnore keeps it out of console capture.
  safeWarn(`[groundcover] ${method}: not initialized, call init() first (groundcoverIgnore)`);
}

// Push a pre-ready task onto the bounded FIFO (drop-oldest, one warning).
function enqueue(task: () => void): void {
  if (pendingCalls.length >= MAX_PENDING_CALLS) {
    pendingCalls.shift();
    if (!droppedWarned) {
      droppedWarned = true;
      safeWarn(
        `[groundcover] pre-init call buffer full (${MAX_PENDING_CALLS}); dropping oldest (groundcoverIgnore)`
      );
    }
  }
  pendingCalls.push(task);
}

// Delegate to the live manager, or buffer until ready, or warn-noop if init()
// was never called. Query methods (getSessionId) do NOT use this — a deferred
// answer is meaningless.
function delegateOrBuffer(method: string, run: (m: RNSessionManager) => void): void {
  if (manager) {
    // Contain manager failures so a public API call never throws into the host.
    // (The buffered path drains through drainPending, which is already guarded.)
    try {
      run(manager);
    } catch (error) {
      reportSafely(error);
    }
    return;
  }
  if (initializedAppId !== undefined) {
    enqueue(() => {
      if (manager) run(manager);
    });
    return;
  }
  warnNotInitialized(method);
}

// Async variant: returns a Promise that resolves when the delegated async call
// settles (or when a buffered call finally runs after init). On a failed init the
// buffered task is drained as a no-op, so the promise resolves rather than hangs.
function delegateOrBufferAsync(
  method: string,
  run: (m: RNSessionManager) => Promise<void>
): Promise<void> {
  if (manager) return run(manager).catch(reportSafely);
  if (initializedAppId !== undefined) {
    return new Promise<void>((resolve) => {
      enqueue(() => {
        if (manager) run(manager).then(() => resolve(), (e) => (reportSafely(e), resolve()));
        else resolve();
      });
    });
  }
  warnNotInitialized(method);
  return Promise.resolve();
}

function drainPending(): void {
  const calls = pendingCalls.splice(0, pendingCalls.length);
  for (const call of calls) {
    try {
      call();
    } catch (error) {
      reportSafely(error);
    }
  }
}

/**
 * Stops the native engine directly, for the failed-init path where no manager is
 * left to ask. Contained: a host without the native module (Expo Go) has nothing
 * to stop, and a throw here must not replace the init error being handled.
 */
function stopNativeEngine(): void {
  try {
    loadNativeModule()?.stop();
  } catch (error) {
    reportSafely(error);
  }
}

async function runInit(params: InitParams, appId: string): Promise<void> {
  try {
    // Capture the validated identity before hydration; caller mutations must not replace it.
    const config: InitParams = {
      appId,
      apiKey: params.apiKey,
      cluster: params.cluster,
      environment: params.environment,
      dsn: params.dsn,
      namespace: params.namespace,
      releaseId: params.releaseId,
      user: params.user,
      options: params.options,
      sessionId: params.sessionId,
      storage: params.storage,
    };
    Logger.initialize({ debug: !!config.options?.debug, prefix: "[groundcover]" });
    const enabled = config.options?.enabledEvents;
    const stopObserving = !enabled?.length || enabled.includes("exceptions")
      ? observeGlobalErrors((error, fatal) => {
          if (!fatal) return;
          const atMs = Date.now();
          delegateOrBuffer("captureStartupFatal", sdk => sdk.captureStartupFatal(error, atMs));
        })
      : undefined;
    let storage;
    try {
      storage = await HydratedStorage.hydrate(config.storage);
    } finally {
      stopObserving?.();
    }
    const next = new RNSessionManager(config, storage);

    manager = next;
    setTouchHandlers({
      onPresence: (nowMs) => next.reportPresence(nowMs),
      onInteraction: (interaction) => next.reportInteraction(interaction),
    });

    drainPending();
  } catch (error) {
    reportSafely(error);
    manager = null;
    // Stop partial startup before releasing the identity for a retry.
    stopNativeEngine();
    // Drain what was buffered during init: sync calls no-op (manager null),
    // async waiters resolve rather than hang.
    drainPending();
    initializedAppId = undefined;
  }
}

function init(params: InitParams): void {
  if (initializedAppId !== undefined) return;

  try {
    const appId = params?.appId;
    // An appId getter can start another initialization before returning.
    if (initializedAppId !== undefined) return;
    if (typeof appId !== "string" || appId.trim().length === 0) {
      safeWarn("[groundcover] init requires a nonblank appId; the SDK was not initialized. (groundcoverIgnore)");
      return;
    }

    // Claim before other getters, hydration, or instrumentation can call back into init.
    initializedAppId = appId;
    initPromise = runInit(params, appId);
  } catch (error) {
    // runInit owns failure cleanup; a throwing appId getter may have started another init.
    reportSafely(error);
  }
}

function identifyUser(user: Partial<UserIdentifiers>): void {
  delegateOrBuffer("identifyUser", (m) => m.identifyUser(user));
}

function updateConfig(updates: SDKConfigUpdate): void {
  delegateOrBuffer("updateConfig", (m) => m.updateConfig(updates));
}

function sendCustomEvent(event: { event: string; attributes: Record<string, unknown> }): void {
  delegateOrBuffer("sendCustomEvent", (m) => m.sendCustomEvent(event));
}

function captureException(error: unknown, metadata?: Record<string, unknown>): void {
  delegateOrBuffer("captureException", (m) => m.captureException(error, metadata));
}

function getSessionId(): string {
  if (!manager) {
    warnNotInitialized("getSessionId");
    return "";
  }
  return manager.getSessionId();
}

function setSessionId(id?: string): Promise<void> {
  return delegateOrBufferAsync("setSessionId", (m) => m.setSessionId(id));
}

function startNavigation(metadata?: Record<string, unknown>): void {
  delegateOrBuffer("startNavigation", (m) => m.startNavigation(metadata));
}

function endNavigation(metadata?: Record<string, unknown>): void {
  delegateOrBuffer("endNavigation", (m) => m.endNavigation(metadata));
}

function startNavigationTracking(navigationRef: NavigationContainerRefLike): void {
  delegateOrBuffer("startNavigationTracking", (m) => m.startNavigationTracking(navigationRef));
}

function stopNavigationTracking(): void {
  delegateOrBuffer("stopNavigationTracking", (m) => m.stopNavigationTracking());
}

/**
 * Marks the moment the app became usable, for time-to-interactive. Call once, when the
 * first screen is genuinely ready — after its data has loaded, not merely on mount. Only
 * used under `native.tti: "manual"`; the default `"auto"` anchors on the first screen
 * landing, a floor rather than a real measure.
 *
 * Deliberately NOT routed through the pre-init buffer, which would replay the call later
 * and record the drain time — a fabricated measurement.
 */
function markAppInteractive(): void {
  try {
    markManualInteractive(Date.now());
  } catch (error) {
    reportSafely(error);
  }
}

const groundcover = {
  init,
  identifyUser,
  updateConfig,
  sendCustomEvent,
  captureException,
  logger,
  getSessionId,
  setSessionId,
  startNavigation,
  endNavigation,
  startNavigationTracking,
  stopNavigationTracking,
  markAppInteractive,
};

export default groundcover;
export { GroundcoverProvider };
export type { GroundcoverProviderProps } from "./react/GroundcoverProvider";
export type { NavigationContainerRefLike } from "./events/listeners/navigation-tracker";
export type {
  SDKOptions,
  SDKConfigInput,
  SDKConfigUpdate,
  EventTypes,
  RNEventName,
  PrivacyOptions,
  PrivacyLevel,
  RedactField,
  RedactKind,
  Redactor,
  RNSessionAttributes,
  InteractionEventAttributes,
  ScreenAttributes,
  NativeOptions,
  AppStartMetricName,
  CallbackEvent,
  FlattenedEventAttributes,
  ErrorReportingOptions,
  ErrorDeduplicationOptions,
} from "./config/types";

// Test-only hook to reset module singletons between vitest cases.
export function __resetForTest(): void {
  manager?.destroy();
  manager = null;
  initializedAppId = undefined;
  initPromise = Promise.resolve();
  pendingCalls.length = 0;
  droppedWarned = false;
  // Leave the logger sink in place — it's the stable module-level router that
  // delegates/buffers by module state (which is reset above), so post-reset
  // logger.* correctly warn-noops until the next init().
  setTouchHandlers({ onPresence: null, onInteraction: null });
  clearTouchHistory();
  // Set-once by design, so a suite measuring TTI twice needs it cleared.
  __resetInteractiveMarkForTest();
}

// Await initialization in tests (init is fire-and-forget in production).
export function __whenReady(): Promise<void> {
  return initPromise;
}
