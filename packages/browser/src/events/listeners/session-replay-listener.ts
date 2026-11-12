import { record } from "rrweb";
import { pack } from "@rrweb/packer";
import { Logger } from "@groundcover/rum-core/common/logger";
import { handleError } from "@groundcover/rum-core/common/error-handler";
import { safeWarn } from "@groundcover/rum-core/common/safe-warn";
import { _globalThis } from "../../common/global";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { WorkerClient } from "@/worker/worker-client";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";
import { SessionState } from "@groundcover/rum-core/session/session-state";
import { ReplayEventAttributes } from "../types";
import { shouldMaskElement } from "@/privacy/element";
import { resolveWebPrivacy } from "@/privacy/web-privacy";
import { ReplayCanvasOptions, ReplayOptions } from "@/config/types";
import {
  DEFAULT_REPLAY_CANVAS_FPS,
  MIN_REPLAY_CANVAS_FPS,
  MAX_REPLAY_CANVAS_FPS,
  DEFAULT_REPLAY_CANVAS_IMAGE_TYPE,
  DEFAULT_REPLAY_CANVAS_IMAGE_QUALITY,
} from "@/config/constants";
import { resolveReplayMasking } from "@/privacy/replay-masking";

// rrweb's periodic full snapshot ("checkout"). Each one serializes the whole
// DOM synchronously, inside whatever event happens to trigger it, and ships
// the full tree. 5 minutes is a common interval for rrweb-based recorders; a
// player seeks from the nearest earlier full snapshot, so a longer gap stays
// playable.
const FULL_SNAPSHOT_INTERVAL_MS = 5 * 60_000;

type RawReplayEvent = Parameters<typeof pack>[0];

// Resolve the opt-in canvas config into the canvas-specific rrweb record()
// options, or `null` when canvas capture is disabled/omitted (so record() gets
// NO canvas options and default replay behavior is byte-for-byte unchanged).
// fps is clamped into [MIN, MAX] (warn on out-of-range/invalid, mirroring
// normalizeSessionMaxDuration); image serialization defaults to a small lossy
// webp rather than rrweb's default lossless png.
function resolveCanvasRecordOptions(
  canvas: ReplayCanvasOptions | undefined,
): { canvasFps: number; dataURLOptions: { type: string; quality: number } } | null {
  if (!canvas || canvas.enabled !== true) return null;

  let fps = canvas.fps ?? DEFAULT_REPLAY_CANVAS_FPS;
  if (typeof fps !== "number" || !Number.isFinite(fps)) {
    safeWarn(
      `[groundcover] replay.canvas.fps must be a finite number; falling back to ${DEFAULT_REPLAY_CANVAS_FPS}.`,
    );
    fps = DEFAULT_REPLAY_CANVAS_FPS;
  } else if (fps < MIN_REPLAY_CANVAS_FPS || fps > MAX_REPLAY_CANVAS_FPS) {
    const clamped = Math.min(
      MAX_REPLAY_CANVAS_FPS,
      Math.max(MIN_REPLAY_CANVAS_FPS, fps),
    );
    safeWarn(
      `[groundcover] replay.canvas.fps ${fps} is out of range [${MIN_REPLAY_CANVAS_FPS}, ${MAX_REPLAY_CANVAS_FPS}]; clamped to ${clamped}.`,
    );
    fps = clamped;
  }

  return {
    canvasFps: fps,
    dataURLOptions: {
      type: canvas.imageType ?? DEFAULT_REPLAY_CANVAS_IMAGE_TYPE,
      quality: canvas.imageQuality ?? DEFAULT_REPLAY_CANVAS_IMAGE_QUALITY,
    },
  };
}

export interface SessionReplayListenerDeps {
  config: ConfigManager;
  session: SessionState;
  eventsPool: EventsPool;
  enricher: EventEnricher;
}

export class SessionReplayListener {
  private logger = Logger.getInstance();
  private readonly eventsPool: EventsPool;
  private readonly configManager: ConfigManager;
  private readonly session: SessionState;
  private readonly enricher: EventEnricher;

  constructor(deps: SessionReplayListenerDeps) {
    this.configManager = deps.config;
    this.session = deps.session;
    this.eventsPool = deps.eventsPool;
    this.enricher = deps.enricher;
  }

  private stopFn: (() => void) | null = null;
  private isRecording = false;
  private events: RawReplayEvent[] = [];
  private startTime: number = 0;
  private batchSize: number = 3;
  private batchContainsFullSnapshot: boolean = false;
  private fullSnapshotTimestamp: number | undefined = undefined;
  private sendTimerId: ReturnType<typeof setTimeout> | null = null;

  initialize(): void {
    this.logger.log("[session-replay-listener] initialize called");

    if (this.isRecording) {
      this.logger.log("[session-replay-listener] already recording");
      return;
    }

    this.startRecording();
  }

  private startRecording(): void {
    try {
      this.startTime = Date.now();
      this.events = [];
      this.isRecording = true;
      this.batchContainsFullSnapshot = false;
      this.fullSnapshotTimestamp = undefined;

      // blockSelector is noise reduction (extension-injected DOM), NOT privacy.
      // `replay` is a browser option slot (see config/config-extension.ts), so
      // core's stored options don't declare it; the browser owns its shape.
      const options = this.configManager.getConfig()?.options as
        | { replay?: ReplayOptions }
        | undefined;
      const replayOptions = options?.replay;
      const blockedSelectors = replayOptions?.blockedSelectors?.filter(Boolean);
      const blockSelector = blockedSelectors?.length
        ? blockedSelectors.join(", ")
        : undefined;

      // Privacy masking — drives rrweb's text/input masking from the unified
      // privacy config (default 'mask-sensitive': mask only sensitive inputs,
      // capture the rest, show static text). The rrweb-specific fields resolve
      // in privacy/replay-masking (browser-only); the element gate below reads
      // the shared EffectivePrivacy.
      const privacy = resolveWebPrivacy(this.configManager);
      const masking = resolveReplayMasking(
        this.configManager.getConfig()?.providedOptions
      );

      // Opt-in canvas capture (off by default). `null` unless explicitly
      // enabled, so record() receives no canvas options in the default case.
      // NOTE: canvas frames are pixel snapshots and bypass the privacy masking
      // above — that tradeoff is documented on ReplayCanvasOptions.
      const canvas = resolveCanvasRecordOptions(replayOptions?.canvas);

      // rrweb masks input VALUES purely by input TYPE (maskAllInputs /
      // maskInputOptions); there is no native "mask by selector". To mask only
      // SENSITIVE inputs we keep maskAllInputs on (so rrweb invokes maskInputFn
      // for every input, on both the snapshot and every keystroke) and let the
      // fn itself be the per-element gate: original text for non-secret inputs,
      // masked for secret ones. A user-supplied maskInputFn always wins.
      const maskInputFn =
        masking.maskInputFn ??
        (privacy.level === "allow"
          ? undefined
          : (text: string, element: HTMLElement): string =>
              shouldMaskElement(element, privacy)
                ? "*".repeat(text.length)
                : text);

      this.stopFn =
        record({
          ...(blockSelector ? { blockSelector } : {}),
          ...(masking.maskTextSelector
            ? { maskTextSelector: masking.maskTextSelector }
            : {}),
          maskAllInputs: masking.maskAllInputs,
          ...(masking.maskTextFn ? { maskTextFn: masking.maskTextFn } : {}),
          ...(maskInputFn ? { maskInputFn } : {}),
          ...(canvas
            ? { recordCanvas: true, dataURLOptions: canvas.dataURLOptions }
            : {}),
          slimDOMOptions: {
            script: false,
            comment: false,
            headWhitespace: false,
          },
          sampling: {
            mousemove: 100,
            input: "last",
            scroll: 150,
            ...(canvas ? { canvas: canvas.canvasFps } : {}),
          },
          checkoutEveryNms: FULL_SNAPSHOT_INTERVAL_MS,
          // rrweb's observers (DOM mutation, and the canvas snapshot loop when
          // recordCanvas is on) run asynchronously AFTER record() returns, so
          // their failures escape the try/catch around startRecording(). Route
          // them through handleError and return true to keep internal recorder
          // errors inside the SDK instead of surfacing on the host page.
          errorHandler: (error: unknown) => {
            handleError(error);
            return true;
          },
          emit: (event, isCheckout?: boolean) => {
            if (!this.isRecording) return;
            try {
              this.events.push(event as RawReplayEvent);

              if (isCheckout) {
                this.batchContainsFullSnapshot = true;
                this.fullSnapshotTimestamp = Date.now();
                this.logger.log(
                  "[session-replay-listener] full snapshot captured at",
                  this.fullSnapshotTimestamp,
                );
              }

              if (this.events.length >= this.batchSize) {
                this.scheduleSendBatch();
              }
            } catch (error) {
              handleError(error);
              this.logger.log(
                "[session-replay-listener] failed to process event in emit callback:",
                error,
              );
            }
          },
        }) || null;

      this.logger.log(
        "[session-replay-listener] started recording with full snapshot interval:",
        FULL_SNAPSHOT_INTERVAL_MS,
        "ms",
      );
    } catch (error) {
      handleError(error);
      this.logger.log(
        "[session-replay-listener] failed to start recording:",
        error,
      );
      this.isRecording = false;
    }
  }

  private scheduleSendBatch(): void {
    if (this.sendTimerId !== null) return;
    this.sendTimerId = _globalThis.setTimeout(() => {
      this.sendTimerId = null;
      if (!this.isRecording) return;
      this.sendBatchAsync().catch((error) => {
        handleError(error);
        this.logger.log(
          "[session-replay-listener] failed to send deferred batch:",
          error,
        );
      });
    }, 0);
  }

  private clearScheduledSend(): void {
    if (this.sendTimerId !== null) {
      _globalThis.clearTimeout(this.sendTimerId);
      this.sendTimerId = null;
    }
  }

  // Sync drain used by stopRecording / setSessionId. Main-thread pack only —
  // an async hop here would enqueue under the NEW id after rotation.
  flushPendingSync(): void {
    this.clearScheduledSend();
    if (this.events.length === 0) return;
    this.sendBatchSync();
  }

  private async sendBatchAsync(): Promise<void> {
    if (this.events.length === 0) {
      return;
    }

    const drained = this.drainBatch();
    // Pin the session id at drain time so a mid-pack rotation drops the batch
    // instead of stamping these frames with the new id.
    const capturedSessionId = this.session.getSessionId();

    // Inlined (not withFallback) so the no-worker branch stays synchronous —
    // callers and tests rely on the timer drain completing in one tick.
    const worker = WorkerClient.getInstance();
    let packedEvents: string[];
    if (!worker.isAvailable) {
      packedEvents = drained.events.map((e) => pack(e));
    } else {
      try {
        packedEvents = await worker.packReplay(drained.events);
      } catch (error) {
        handleError(error);
        this.logger.log("[session-replay-listener] worker pack failed, using inline fallback:", error);
        packedEvents = drained.events.map((e) => pack(e));
      }
    }

    if (this.session.getSessionId() !== capturedSessionId) {
      this.logger.log(
        "[session-replay-listener] dropping packed batch: session rotated during pack",
        { drained: packedEvents.length },
      );
      return;
    }

    this.enqueueReplayEvent(packedEvents, drained.containsFullSnapshot, drained.snapshotTimestamp);
  }

  private sendBatchSync(): void {
    if (this.events.length === 0) {
      return;
    }

    const drained = this.drainBatch();
    const packedEvents = drained.events.map((e) => pack(e));
    this.enqueueReplayEvent(packedEvents, drained.containsFullSnapshot, drained.snapshotTimestamp);
  }

  // Snapshot + reset state atomically so the returned array can be packed
  // without racing future emit callbacks that mutate this.events.
  private drainBatch(): {
    events: RawReplayEvent[];
    containsFullSnapshot: boolean;
    snapshotTimestamp: number | undefined;
  } {
    const events = this.events;
    const containsFullSnapshot = this.batchContainsFullSnapshot;
    const snapshotTimestamp = this.fullSnapshotTimestamp;
    this.events = [];
    this.batchContainsFullSnapshot = false;
    this.fullSnapshotTimestamp = undefined;
    return { events, containsFullSnapshot, snapshotTimestamp };
  }

  private enqueueReplayEvent(
    packedEvents: string[],
    containsFullSnapshot: boolean,
    snapshotTimestamp: number | undefined,
  ): void {
    try {
      const attributes: ReplayEventAttributes = {
        _gc_replay_data: {
          events: packedEvents,
        },
      };

      if (containsFullSnapshot) {
        attributes.replay_is_full_snapshot = true;
        attributes.replay_full_snapshot_timestamp = snapshotTimestamp;
      }

      const replayEvent = this.enricher.enrich({
        type: "replay",
        attributes,
      });

      this.eventsPool.addEvent(replayEvent);

      this.logger.log(
        "[session-replay-listener] sent batch with",
        packedEvents.length,
        "events",
        containsFullSnapshot ? "(includes full snapshot)" : "",
      );
    } catch (error) {
      handleError(error);
      this.logger.log("[session-replay-listener] failed to send batch:", error);
    }
  }

  stopRecording(): void {
    if (!this.isRecording) {
      return;
    }

    try {
      this.clearScheduledSend();
      this.stopFn?.();
      this.isRecording = false;

      if (this.events.length > 0) {
        this.sendBatchSync();
      }

      this.stopFn = null;
      this.batchContainsFullSnapshot = false;
      this.fullSnapshotTimestamp = undefined;
    } catch (error) {
      handleError(error);
      this.logger.log(
        "[session-replay-listener] failed to stop recording:",
        error,
      );
    }
  }

  destroy(): void {
    this.stopRecording();
  }
}
