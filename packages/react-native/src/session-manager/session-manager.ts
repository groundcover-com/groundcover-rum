import { AppState, Platform, type NativeEventSubscription } from "react-native";
import {
  bootstrapSession,
  ConfigManager,
  EventEnricher,
  EventsPool,
  Logger,
  msToNs,
  RandomIdGenerator,
  resolveSamplingDecision,
  SessionState,
  Transporter,
  type LogLevel,
  type SafeStorage,
  type UserIdentifiers,
} from "@groundcover/rum-core";

import { isReactFiber } from "../react/opaque-node";
import { RN_CONFIG_EXTENSION } from "../config/config-extension";
import type { RNEventName, SDKConfigInput, SDKConfigUpdate } from "../config/types";
import { RN_EVENTS_TO_SKIP_FLUSH, type RNEventType } from "../events/rn-event-types";
import { RNInstrumentationManager } from "../events/instrumentation-manager";
import { getRNDeviceAttributes, createScreenHolder } from "../platform/rn-platform";
import type { NavigationContainerRefLike } from "../events/listeners/navigation-tracker";
import type { RawGesture } from "../internal/touch-bridge";
import { initNative, loadNativeModule } from "../platform/native-bridge";
import { drainNativeCrashReports } from "../events/native-crash-drain";
import { NativeSnapshotPusher } from "../platform/session-snapshot";
import type { GroundcoverNativeModule } from "../platform/native-types";
import { resolveVitalsMaxSegmentMs, selectHangThresholdMs } from "../config/constants";
// Every error sink in this file goes through this rather than `handleError` directly.
// It is the composition root: its catch sites sit in constructors, teardown paths and the promise
// chain that also owns the crash drain, so a throw FROM THE REPORTER — the host's logger is
// reachable and patchable — turns "we failed to report" into a failed init or a lost drain.
import { reportSafely } from "../internal/report-safely";
import { cleartextDsnWarning } from "../config/cleartext";
import { safeWarn } from "../internal/safe-warn";
import { createRnBatchSender } from "../internal/rn-batch-sender";

// Built together in the constructor and set ATOMICALLY: `core` is either null
// (not initialized / not sampled / destroyed) or every handle is live.
interface CoreHandles {
  config: ConfigManager;
  session: SessionState;
  pool: EventsPool<RNEventType>;
  instrumentation: RNInstrumentationManager;
  snapshots: NativeSnapshotPusher;
}

function isEventEnabled(config: ConfigManager, name: RNEventName): boolean {
  const configured = config.getConfig()?.options?.enabledEvents;
  return !configured || configured.length === 0 || configured.includes(name);
}

// RN COMPOSITION ROOT (mirror of the browser SessionManager): constructs every
// core object and wires the RN implementations — a pre-hydrated synchronous
// storage, device metadata, the current-screen provider, a fetch-based batch
// sender, inline gzip (no Web Worker), and AppState-driven background flush.
export class RNSessionManager {
  private logger: ReturnType<typeof Logger.initialize>;
  private readonly storage: SafeStorage;
  private idGenerator: RandomIdGenerator;
  private core: CoreHandles | null = null;
  private appStateSub: NativeEventSubscription | null = null;
  private native: GroundcoverNativeModule | null = null;
  // App-background wiring, the RN analogue of the browser's visibilitychange
  // hide handler. On any leave-foreground transition persist the exact activity
  // timestamp (steady-state writes are throttled). But FLUSH only on "background"
  // — the true "going away" signal (≈ visibilityState "hidden"). iOS also fires
  // "inactive" on transient interruptions (Control Center, notification shade,
  // app-switcher peek, biometric/permission prompts, incoming calls) that are NOT
  // backgrounding; flushing on those would send redundant, fragmented batches.
  private handleAppStateChange = (state: string): void => {
    try {
      if (state === "background" || state === "inactive") {
        this.core?.session.persistLastActivity();
      }
      if (state === "background") {
        this.core?.pool.flush({ lifecycle: true });
      }
    } catch (error) {
      reportSafely(error);
    }
  };

  constructor(config: SDKConfigInput, storage: SafeStorage) {
    this.logger = Logger.initialize({
      debug: config.options?.debug || false,
      prefix: "[groundcover]",
    });
    this.storage = storage;
    this.idGenerator = new RandomIdGenerator();

    const configManager = new ConfigManager(RN_CONFIG_EXTENSION);
    configManager.initialize(config);

    // Before anything arms: a DSN nothing can reach makes every later signal moot, and this is
    // the only moment the host is watching the log. `__DEV__` is always defined under Metro and
    // under a release bundle; treating an absent one as production means the warning appears in a
    // stripped or non-RN host rather than being silently dropped there.
    const cleartext = cleartextDsnWarning(
      configManager.getConfig()?.getEndpoint() ?? "",
      typeof __DEV__ === "boolean" ? __DEV__ : false
    );
    // Contained: this runs before the composition root's own try/catch below, so an unguarded
    // throw from a patched console would abort init() outright and leave the host with no SDK.
    if (cleartext) safeWarn(cleartext);

    const sessionState = new SessionState({
      storage: this.storage,
      getMaxDurationMs: () => configManager.getConfig()?.options?.sessionMaxDuration,
    });

    // Resolve session identity + init-time expiry BEFORE reading the sampling
    // verdict (bootstrapSession is the only place a rotation clears a persisted
    // verdict — see the browser's note).
    bootstrapSession({
      session: sessionState,
      idGenerator: this.idGenerator,
      providedSessionId: config.sessionId,
    });

    // The native module is absent in Expo Go and in any binary predating the
    // native package — every native feature simply never arms, and the JS SDK
    // is unaffected.
    this.native = loadNativeModule();

    const shouldSampleSession = resolveSamplingDecision({
      storage: this.storage,
      sessionSampleRate: config.options?.sessionSampleRate,
    });
    if (!shouldSampleSession) {
      this.logger.log("[rn-session-manager] session is not sampled");
      // Capture nothing live, but STILL HARVEST AND DRAIN: a fatal from an earlier, sampled
      // session is already on disk, and this session's dice roll says nothing about whether that
      // one should ship. See `armNative` for why `crashes` is the one feature that arms here.
      const ready = this.armNative(configManager, false);
      this.drainCrashesAfterHarvest(configManager, ready);
      // Then drop the envelope. This is what makes arming crashes above safe: with no snapshot on
      // disk, a crash in THIS session is unattributable, so the drain acks-and-drops it — which is
      // the same outcome as never capturing it, reached at report time instead of capture time.
      //
      // A CLEAR, not merely a skipped push: an unsampled launch inherits whatever envelope the
      // previous run left, and a crash paired with THAT would be attributed to a session it did not
      // happen in. Misattribution is a worse failure than a delayed delivery.
      //
      // The clear itself is native's last act inside `armNative` — see
      // `clearSnapshotAfterHarvest` there — because on iOS the harvest runs INSIDE `nativeInit`
      // and reads this very snapshot, so nothing outside that call can clear it without leaving a
      // window in which the previous run's envelope is on disk while this run is capturing.
      //
      // This second, asynchronous clear is the BACKSTOP for version skew: an installed binary
      // older than that field ignores it, and JS updates ship independently of the app binary
      // (Metro, OTA). It is a no-op when native already cleared. Sequenced after the init
      // settles for the same reason — clearing first would destroy the envelope the harvest
      // exists to pair.
      void ready.then(() => this.clearNativeSnapshot()).catch(reportSafely);
      return;
    }

    const transporter = new Transporter({
      config: configManager,
      // The live pool sends fire-and-forget — no delivery callback; the shared sender
      // owns the RN fetch, its AbortController timeout, and the Uint8Array-body cast.
      sendBatch: createRnBatchSender(),
      // No encodeAsync: RN has no Web Worker, so the transporter uses its inline
      // fflate gzip path.
    });

    const eventsPool = new EventsPool<RNEventType>({
      config: configManager,
      session: sessionState,
      transporter,
      getDeviceAttributes: getRNDeviceAttributes(configManager),
      eventsToSkipFlush: RN_EVENTS_TO_SKIP_FLUSH,
    });

    const screenHolder = createScreenHolder();
    const snapshots = new NativeSnapshotPusher({
      native: this.native,
      getSessionAttributes: () => eventsPool.getSessionAttributes(),
      getScreen: () => screenHolder.get(),
    });

    // Every screen change re-pushes, so a crash report carries the screen the user was actually
    // on. Subscribing (rather than wrapping the tracker) covers the manual startNavigation API
    // too. Navigation is infrequent and native debounces the disk write, so the cost is a bridge
    // call per screen. The instrumentation manager's own screen-change reactions (TTI anchor,
    // frame-segment flush) live in its instrument() — this root only owns the snapshot push.
    screenHolder.subscribe(() => snapshots.push());

    const enricher = new EventEnricher({
      // Core knows nothing about "the current view" — it merges whatever this
      // returns. RN's contribution is the `screen` block.
      enrichAttributes: () => ({ screen: screenHolder.get() }),
      reservedAttributeKeys: ["screen"],
      isOpaqueNode: isReactFiber,
      idGenerator: this.idGenerator,
    });

    const instrumentation = new RNInstrumentationManager({
      config: configManager,
      session: sessionState,
      eventsPool,
      enricher,
      screenHolder,
      // A rotation mints a new session id — native's copy has to follow it.
      onSessionIdentityChanged: () => snapshots.push(),
      nativeModule: this.native,
    });

    // Everything past here arms live resources; `core` is assigned LAST so a
    // mid-startup throw tears them down and leaves the SDK cleanly uninitialized
    // rather than leaking a timer/subscription. Then rethrow (mirrors browser).
    try {
      eventsPool.initialize();
      this.wireAppStateHandler();
      instrumentation.instrument();
      this.core = {
        config: configManager,
        session: sessionState,
        pool: eventsPool,
        instrumentation,
        snapshots,
      };
      // Only now can the envelope be read — and only after `core` is live, so a
      // teardown from a failed startup never leaves native holding a snapshot
      // for a session that does not exist.
      this.drainCrashesAfterHarvest(configManager, this.armNative(configManager, true));
      snapshots.push();
    } catch (error) {
      this.logger.log("[rn-session-manager] init failed — tearing down partial startup:", error);
      try {
        instrumentation.uninstrument();
      } catch (teardownError) {
        reportSafely(teardownError);
      }
      eventsPool.destroy();
      this.unwireAppStateHandler();
      this.core = null;
      throw error;
    }
  }

  // Starts the native engines and records what actually armed. The JS pipeline
  // never waits on this — a native failure degrades to "no native signals",
  // never to a failed init — but the returned promise is how the crash drain
  // learns that the harvest is done. It resolves either way; it never rejects.
  private armNative(config: ConfigManager, sampled: boolean): Promise<void> {
    const native = this.native;
    if (!native) return Promise.resolve();

    const options = config.getConfig()?.options as
      | {
          native?: {
            hangThresholdMs?: number | { ios?: number; android?: number };
            vitalsMaxSegmentMs?: number;
          };
        }
      | undefined;

    const enabled = (name: RNEventName) => sampled && isEventEnabled(config, name);

    return initNative(native, {
      features: {
        // NOT sampled-gated, unlike every other feature, because this flag controls DELIVERY as
        // well as capture: on iOS the engine's crashes block is where the harvest lives — the step
        // that transcribes KSCrash's store into pending records — so gating it on the current
        // launch's dice roll would mean an unsampled launch never harvests, and a crash from a
        // previous SAMPLED session is not delivered at all. At a 10% sample rate that is nine
        // launches in ten, and KSCrash's 10-report cap can evict the report before a sampled launch
        // arrives.
        //
        // Arming capture on an unsampled launch is made safe by the caller, not here: it clears the
        // session snapshot once this init settles, so a crash in an unsampled session has no
        // envelope and the drain acks-and-drops it. Android does not need this — its handler writes
        // self-contained records at crash time — but the flag is shared, so the rule is too.
        crashes: isEventEnabled(config, "crashes"),
        hangs: enabled("hangs"),
        appStart: enabled("appStart"),
        vitals: enabled("vitals"),
        // Gestures ride the existing interaction gate — they are the same
        // signal as taps, captured on the other side of the bridge.
        gestures: enabled("interaction"),
      },
      thresholds: {
        hangThresholdMs: selectHangThresholdMs(options?.native?.hangThresholdMs, Platform.OS),
        vitalsMaxSegmentMs: resolveVitalsMaxSegmentMs(options?.native?.vitalsMaxSegmentMs),
      },
      // Unsampled only, and the reason it is HERE rather than in a second bridge call is the
      // window: the harvest that reads the previous run's envelope runs inside this
      // very call on iOS, so the clear has to happen inside it too. The caller's
      // `clearNativeSnapshot()` still runs afterwards — an installed binary older than this field
      // ignores the flag, and a JS bundle newer than the app is the ordinary OTA case.
      //
      // Limitation on older binaries: the flag is ignored, so the millisecond window between
      // `nativeInit` resolving and the JS clear landing is still there. This field only ever
      // removes the window, never widens it — and gating crash capture until the clear has
      // landed would be wrong: `crashes` is armed on the unsampled path precisely BECAUSE the
      // iOS harvest lives inside the engine's crashes block, so anything that defers or
      // conditions it means an unsampled launch never harvests and a previous SAMPLED session's
      // crash is never delivered — nine launches in ten at a 10% rate. See
      // `drainCrashesAfterHarvest` and the `crashes:` gate above. A narrow misattribution window
      // on stale binaries is the strictly smaller harm.
      clearSnapshotAfterHarvest: !sampled,
    })
      .then((status) => {
        // `status.gestures` is NOT what stands the JS classifier down: it says the tracker was
        // ARMED, not attached — the attach is posted to the main thread and `nativeInit`
        // resolves before it runs, so suppressing on it would drop JS gestures until it lands,
        // or for the whole session if it never does. The `gestures_attached` signal flips it.
        //
        // `status.gesturesAttached` is a different claim, and the only one a RE-init can make:
        // the tracker is hooked right now. Both engines return their cached status without
        // re-arming, so the attach never happens again and its signal is never re-sent — and
        // Metro re-runs init() on every reload. Without this a reloaded app would double-report
        // every swipe, JS numbers beside native ones, for the rest of the session.
        if (status.gesturesAttached) {
          // Coverage travels WITH the attach, here as on the signal: a tracker that reaches every
          // surface must be restored as such, or JS resumes reporting modal gestures that native
          // is still measuring and every modal drag is reported twice.
          this.core?.instrumentation.setNativeGesturesAttached(true, {
            coversAllSurfaces: status.gesturesCoverAllSurfaces === true,
          });
        }

        // The host asked for crashes and native could not oblige — usually another
        // KSCrash user owning the iOS singleton, which we refuse to take over because
        // harvesting their store would destroy their reports. Refusing is right; being
        // quiet about it would leave apps reporting no native crashes with nothing to explain it.
        //
        // safeWarn, not Logger.log, which only prints under `debug`; the crash-safe
        // wrapper matters because `console` is patched by other monitors. The
        // groundcoverIgnore marker stops our own output being re-captured.
        if (status.crashesUnavailable && enabled("crashes")) {
          safeWarn(
            `[groundcover] native crash capture is unavailable: ${status.crashesUnavailable}. ` +
              `Native crashes will not be reported for this session. (groundcoverIgnore)`
          );
        }
      })
      .catch(reportSafely);
  }

  /**
   * Ships crashes from previous runs, but only once `nativeInit` has settled — a data dependency,
   * not politeness: on iOS the transcribing harvest runs inside `nativeInit`, so draining first
   * would read an empty directory and the crash would surface one launch late. Android would hide
   * the mistake.
   *
   * Runs regardless of the sampling verdict, since a fatal from an earlier sampled session must
   * ship. Each report goes under the envelope native persisted at crash time.
   *
   * Regardless of `enabledEvents` too, for the same reason one gate up: config gates CAPTURE, not
   * delivery. A pending record can only exist because a launch with `crashes` enabled wrote it, so
   * every one was captured under consent; turning the feature off means stop capturing, and
   * refusing to ship what is already on disk would make a config change silently lose a fatal —
   * it would sit there until the record cap evicted it. Capture stays off: `armNative` still sends
   * `crashes: false`, so no handler is installed for a host that opted out.
   *
   * That split is not free on iOS, and cannot be closed from here: the harvest that transcribes
   * KSCrash's store into pending records lives inside the same native arming block, so a crash
   * whose next launch has crashes disabled stays in KSCrash's store, un-transcribed. Harvesting it
   * would mean installing KSCrash for a host that asked us not to. Android is unaffected — its
   * handler writes self-contained records at crash time.
   */
  private drainCrashesAfterHarvest(config: ConfigManager, nativeReady: Promise<void>): void {
    const native = this.native;
    if (!native) return;

    // A native init that failed still gets a drain: records left behind by an
    // earlier, working run are on disk regardless, and dropping them would turn
    // one bad startup into permanent data loss.
    void nativeReady
      .catch(() => undefined)
      .then(() => drainNativeCrashReports({ config, idGenerator: this.idGenerator, native }))
      .catch(reportSafely);
  }

  private wireAppStateHandler(): void {
    if (this.appStateSub) return;
    try {
      this.appStateSub = AppState.addEventListener("change", this.handleAppStateChange);
    } catch (error) {
      reportSafely(error);
    }
  }

  private unwireAppStateHandler(): void {
    try {
      this.appStateSub?.remove();
    } catch (error) {
      reportSafely(error);
    }
    this.appStateSub = null;
  }

  identifyUser(user: Partial<UserIdentifiers>): void {
    this.core?.config.updateConfig({ user });
    // The envelope carries `user` — a crash after identify must report the
    // identified user, not the anonymous one.
    this.core?.snapshots.push();
  }

  updateConfig(updates: SDKConfigUpdate): void {
    try {
      if (updates === null || typeof updates !== "object") {
        safeWarn(
          "[groundcover] updateConfig requires a configuration object; the update was ignored. (groundcoverIgnore)"
        );
        return;
      }
      if ("appId" in updates) {
        safeWarn(
          "[groundcover] updateConfig does not accept appId; the entire update was ignored. Remove appId from the update. (groundcoverIgnore)"
        );
        return;
      }

      this.core?.config.updateConfig(updates);
      // Update the native envelope without re-arming init-only instrumentation.
      this.core?.snapshots.push();
    } catch (error) {
      reportSafely(error);
    }
  }

  sendCustomEvent(event: { event: string; attributes: Record<string, unknown> }): void {
    this.core?.instrumentation.sendCustomEvent(event);
  }

  captureException(error: unknown, metadata?: Record<string, unknown>): void {
    this.core?.instrumentation.captureException(error, metadata);
  }

  emitLog(message: string, level: LogLevel, attributes?: Record<string, unknown>): void {
    this.core?.instrumentation.emitLog(message, level, attributes);
  }

  getSessionId(): string {
    return this.core?.session.getSessionId() ?? "";
  }

  async setSessionId(newSessionId?: string): Promise<void> {
    const core = this.core;
    if (!core) return;
    try {
      await core.pool.flushSync();
      const sessionId = newSessionId || this.idGenerator.generateId();
      core.session.setSessionId(sessionId);
      core.session.setSessionStartTime(msToNs(Date.now()));
      core.snapshots.push();
    } catch (error) {
      reportSafely(error);
    }
  }

  startNavigation(metadata?: Record<string, unknown>): void {
    this.core?.instrumentation.startNavigation(metadata);
  }

  endNavigation(metadata?: Record<string, unknown>): void {
    this.core?.instrumentation.endNavigation(metadata);
  }

  startNavigationTracking(ref: NavigationContainerRefLike): void {
    this.core?.instrumentation.startNavigationTracking(ref);
  }

  stopNavigationTracking(): void {
    this.core?.instrumentation.stopNavigationTracking();
  }

  reportPresence(nowMs: number): void {
    this.core?.instrumentation.reportPresence(nowMs);
  }

  reportInteraction(interaction: RawGesture): void {
    this.core?.instrumentation.reportInteraction(interaction);
  }

  // Full teardown for a clean shutdown: stop instrumentation, drop the buffer,
  // unwire AppState, forget the session.
  destroy(): void {
    const core = this.core;
    if (!core) return;
    core.instrumentation.uninstrument();
    core.pool.destroy();
    this.unwireAppStateHandler();
    core.session.clearSessionState();
    // Drop native's copy so a later crash isn't attributed to this session, and stop the watchdogs.
    // The crash handler stays armed on purpose — see the engine's stop().
    core.snapshots.clear();
    this.stopNative();
    this.core = null;
  }

  private stopNative(): void {
    try {
      this.native?.stop();
    } catch (error) {
      reportSafely(error);
    }
  }

  /**
   * Drops native's session envelope directly, for the unsampled path — where the constructor
   * returns before `core` exists, so there is no {@link NativeSnapshotPusher} to ask.
   *
   * Contained: a host without the native module has nothing to clear, and a throw here must not
   * escape into the promise chain that also owns the crash drain.
   */
  private clearNativeSnapshot(): void {
    try {
      this.native?.updateSessionSnapshot(null);
    } catch (error) {
      reportSafely(error);
    }
  }
}
