import { handleError } from "../common/error-handler";

import { ConfigManager } from "../config/config-manager";
import { SessionState } from "../session/session-state";
import { Transporter } from "../transporter/transporter";
import { BaseEvent, DedupeableEvent, SessionAttributes } from "./types";
import { earliestTrustedEventTime } from "./event-time";
import { DEFAULT_SDK_CONFIG_OPTIONS } from "../config/constants";
import { Logger } from "../common/logger";
import { PendingBatch } from "./pending-batch";

// Cap on events held while the flush gate is closed (no presence yet); nothing
// is sent meanwhile, unless the gate lets a lifecycle flush through
// (SessionLifecycle's releasesOnSuspend). Bounds a never-confirmed bot or background session — real
// sessions confirm in seconds. On overflow drop the NEWEST, keeping the earliest.
export const MAX_GATED_BUFFER_EVENTS = 500;
// Fallbacks for an omitted/invalid transport setting — sourced from the shared
// SDK defaults so "invalid" and "omitted" resolve to the same documented value.
const DEFAULT_BATCH_SIZE = DEFAULT_SDK_CONFIG_OPTIONS.transport?.batchSize ?? 10;
const DEFAULT_BATCH_TIMEOUT_MS = DEFAULT_SDK_CONFIG_OPTIONS.transport?.batchTimeout ?? 10_000;

// Resolve the size threshold, honoring an explicit `0` (flush every event,
// since `length >= 0` is always true) but falling back to the default for any
// non-numeric / negative / NaN value an untyped caller might pass — so a bad
// override can't silently disable size-based flushing.
function resolveBatchSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_BATCH_SIZE;
}

// Resolve the timer interval. Unlike batchSize, `0` is NOT honored: a 0 ms
// timer would busy-flush, and an `if (!batchTimeout) return` would skip arming
// the heartbeat entirely, stranding sub-batch events until a lifecycle flush.
// Anything not a positive finite number falls back to the default so the
// heartbeat is always armed with a sane interval.
function resolveBatchTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_BATCH_TIMEOUT_MS;
}

// Whether a value coming back from the public `enrichEvent` hook is usable as an
// event. The SDK's types say BaseEvent, but the callback lives in the host app and
// a JS caller is not bound by them: `undefined` (a hook that forgot to return),
// a scalar, or an object with no usable `type` are all reachable at runtime.
//
// An unusable value must not be adopted, because it reaches two places that care.
// The enqueue observer reads `type` to drive session reconciliation, so garbage
// there silently stops rotation and presence for that event. And the buffer
// serializes straight to the wire, where the value lands in the batch as `null`
// or a bare scalar.
//
// Returning false makes addEvent DROP the event — it does not fall back to the
// pre-enrichment one. That is the privacy-preserving choice, not the harsh one:
// `enrichEvent` is the documented way to scrub `sendCustomEvent` payloads, which
// the SDK deliberately does not auto-redact, so the pre-enrichment event is
// exactly what a failed scrubber was supposed to strip. Dropping also matches the
// throwing-hook path, which discards too. See the call site in addEvent.
//
// The `type` read is itself guarded: the result may be a hostile object.
// Exported so the platform packages can apply the SAME test on paths that bypass
// the pool — e.g. a crash drain that builds and sends its own batch — and a second,
// drifting definition of "usable" is exactly how one path silently starts accepting
// what the other rejects.
export function isUsableEvent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return typeof (value as { type?: unknown }).type === "string";
  } catch (error) {
    handleError(error);
    return false;
  }
}

// Host-provided device metadata stamped on every batch envelope. Each platform
// returns its own shape — the pool spreads it verbatim.
export type DeviceAttributesProvider = () => Record<string, unknown>;

export interface EventsPoolDeps<TType extends string = string> {
  config: ConfigManager;
  session: SessionState;
  transporter: Transporter;
  getDeviceAttributes: DeviceAttributesProvider;
  // Event types that never trigger an immediate size-based flush (they ride
  // along with the next flushing event instead). Platform-owned — typically
  // high-frequency interaction kinds; pass an empty array if none.
  //
  // NoInfer: this list is a SUBSET of the platform's event kinds, so letting it
  // drive inference would pin TType to just those two names and reject every
  // other event the pool accepts.
  eventsToSkipFlush: ReadonlyArray<NoInfer<TType>>;
}

// What the send gate is told about the send it is asked to allow.
export interface FlushGateContext<TType extends string = string> {
  // The host forced this send (flush({ lifecycle: true })): it is being
  // hidden, backgrounded or closed, so this may be the last send the buffer
  // gets. Some platforms force one for other reasons too (React Native: after
  // a fatal error or a recovered hang).
  lifecycle: boolean;
  // The events waiting to be sent, as buffered. Read them; never change them.
  events: ReadonlyArray<BaseEvent<TType>>;
}

export type FlushGate<TType extends string = string> = (context: FlushGateContext<TType>) => boolean;

export class EventsPool<TType extends string = string> {
  // Replaced whole whenever it is sent or dropped (clearBuffer).
  private pending: PendingBatch<BaseEvent<TType>>;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly transporter: Transporter;
  private readonly config: ConfigManager;
  private readonly session: SessionState;
  private readonly getDeviceAttributes: DeviceAttributesProvider;
  private readonly eventsToSkipFlush: ReadonlyArray<TType>;
  private logger = Logger.getInstance();
  private initialized = false;
  private noClusterWarned = false;
  private unusableEnrichWarned = false;
  private onBeforeEnqueue: ((event: BaseEvent<TType>) => void) | null = null;
  // Policy-free send gate (mirrors onBeforeEnqueue). While it returns false,
  // flush/flushSync/batch/lifecycle sends hold instead of shipping; null = no
  // gate, so every send goes out. SessionLifecycle owns the presence policy.
  private flushGate: FlushGate<TType> | null = null;

  constructor(deps: EventsPoolDeps<TType>) {
    this.config = deps.config;
    this.session = deps.session;
    this.transporter = deps.transporter;
    this.getDeviceAttributes = deps.getDeviceAttributes;
    this.eventsToSkipFlush = deps.eventsToSkipFlush;
    this.pending = this.newBatch();
  }

  public initialize(): void {
    try {
      if (this.initialized) return;

      this.scheduleFlush();

      this.initialized = true;
    } catch (error) {
      handleError(error);
    }
  }

  // SDK teardown: stop the flush heartbeat so a destroyed SDK doesn't keep
  // waking the app; initialized resets so a later init() cycle can re-arm
  // cleanly. (The suspend-time lifecycle flush is host-wired — the platform
  // listens for its own suspend signal and calls flush({ lifecycle: true }).)
  public destroy(): void {
    try {
      if (this.timeoutId !== null) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      this.clearBuffer();
      this.initialized = false;
    } catch (error) {
      handleError(error);
    }
  }

  // Fires just before an accepted event is enqueued, with the event so the
  // observer can gate on its type. Policy-free: the session-rotation hook
  // lives in InstrumentationManager.
  setBeforeEnqueueHook(hook: ((event: BaseEvent<TType>) => void) | null): void {
    this.onBeforeEnqueue = hook;
  }

  // Install/clear the send gate. Policy-free — EventsPool only asks "am I
  // allowed to send right now?"; SessionLifecycle owns what that means.
  setFlushGate(gate: FlushGate<TType> | null): void {
    this.flushGate = gate;
  }

  // Drop everything currently buffered WITHOUT sending. Used on session
  // rotation for a session that never earned presence, so its ghost events
  // neither ship nor leak into the next session id.
  discardBuffer(): void {
    this.clearBuffer();
  }

  // Every place the buffer is emptied goes through here.
  private clearBuffer(): void {
    this.pending = this.newBatch();
  }

  private newBatch(): PendingBatch<BaseEvent<TType>> {
    return new PendingBatch(() => this.config.getConfig()?.options?.errors?.deduplication);
  }

  // The earliest trusted occurrence time still in the buffer, or null.
  //
  // SessionLifecycle asks during a rotation. The drain that precedes the id flip
  // normally empties the buffer, but flush() returns WITHOUT draining when no
  // cluster is configured — and those retained events then ship under the new
  // session id, so the new session's start must cover them or the batch claims
  // a session that began after its own events.
  getEarliestEventTimestamp(nowNs: number, maxAgeNs: number): number | null {
    return earliestTrustedEventTime(this.pending.events, nowNs, maxAgeNs);
  }

  // Gate is open when unset, or when the predicate says so. A throwing predicate
  // fails OPEN (send): silently dropping a legit session forever is worse than a
  // rare ghost, and it keeps the "gate unset ⇒ every send goes out" guarantee.
  private isFlushAllowed(lifecycle = false): boolean {
    if (this.flushGate === null) return true;
    try {
      return this.flushGate({ lifecycle, events: this.pending.events });
    } catch (error) {
      handleError(error);
      return true;
    }
  }

  addEvent(event: DedupeableEvent<TType> | null): void {
    if (!event || !this.initialized) return;

    try {
      // What makes this event a repeat (error deduplication), saved before the
      // hooks: they can't see it (hidden), change it (frozen) or lose it by
      // returning a new event, so they can't change how the event groups.
      const dedup = event.dedup;
      const beforeSend = this.config.getConfig()?.options?.beforeSend;
      const enrichEvent = this.config.getConfig()?.options?.enrichEvent;

      // The hooks are typed over the open envelope here; the platform narrows
      // them to its own event map on its side of the config seam.
      let outgoing = event;

      if (beforeSend && !beforeSend(outgoing)) {
        return;
      }

      if (enrichEvent) {
        const enriched = enrichEvent(outgoing) as BaseEvent<TType>;
        // An unusable result DROPS the event (see isUsableEvent). Falling back to
        // the pre-enrichment event would be a privacy leak, not a kindness:
        // `enrichEvent` is the documented way to scrub `sendCustomEvent`
        // payloads, which are deliberately NOT auto-redacted, so the original is
        // exactly what a failed scrubber was supposed to remove. Dropping also
        // matches the throwing-hook path, which already discards.
        //
        // Warn once — not on every event of a hook that always returns garbage.
        if (!isUsableEvent(enriched)) {
          if (!this.unusableEnrichWarned) {
            this.unusableEnrichWarned = true;
            this.logger.log(
              "[events-pool.addEvent] dropping event: enrichEvent returned an unusable value"
            );
          }
          return;
        }
        outgoing = enriched;
      }

      // After beforeSend acceptance and AFTER enrichEvent, still before enqueue.
      //
      // The order matters: the observer drives session reconciliation, and a
      // rotation derives the new session's start time from this event (see
      // SessionLifecycle.resolveNewSessionStartTime). enrichEvent is a supported
      // hook that may replace the event wholesale, timestamps included, and its
      // RESULT is what enters the buffer — so a hook that moved a timestamp
      // earlier than the value the observer saw would ship an event predating
      // the very session it opened. Reconciling on the final event closes that.
      //
      // A throwing enrichEvent drops the event: the throw reaches addEvent's
      // outer catch, so nothing is enqueued and no reconciliation runs for an
      // event that was never accepted.
      //
      // Accepted limitation of observing the enriched event: presence is
      // classified from its `type`, so a hook that relabels a background event as
      // an interaction type confirms the session and opens the send gate without
      // real input. Deliberately not guarded — it requires an integrator to
      // sabotage their own telemetry, and separating "observed type" from
      // "shipped event" costs more than the case is worth.
      if (this.onBeforeEnqueue) {
        try {
          this.onBeforeEnqueue(outgoing);
        } catch (error) {
          handleError(error);
        }
      }

      // Buffered, or, for a repeat of an exception or error-level log already in
      // this batch, counted on that event (error deduplication). After the
      // hooks, so beforeSend and enrichEvent still see every occurrence and one
      // they drop isn't counted. An event a hook turned into another type no
      // longer groups as the old one.
      //
      // Bounded buffer while gated: drop the newest once the cap is hit so a
      // never-confirmed session can't grow without bound. After onBeforeEnqueue,
      // so an event that just opened the gate is not capped; ungated = unbounded.
      const capacity = this.isFlushAllowed() ? Infinity : MAX_GATED_BUFFER_EVENTS;
      const size = this.pending.add(outgoing, outgoing.type === event.type ? dedup : undefined, capacity);
      if (size === null) return;

      // batchSize counts the events to be sent, and a merged error is one
      // however many times it repeats: a loop alone never fills a batch, and
      // goes out with the batch (heartbeat, other events filling it, or a
      // lifecycle flush).
      const batchSize = resolveBatchSize(this.config.getConfig()?.options?.transport?.batchSize);
      if (size >= batchSize && !this.eventsToSkipFlush.includes(outgoing.type)) {
        this.flush();
      }
    } catch (error) {
      handleError(error);
    }
  }

  flush({ lifecycle = false }: { lifecycle?: boolean } = {}) {
    try {
      if (!this.initialized) return;

      // Gated (no presence yet): hold the buffer but keep the heartbeat armed
      // (like the empty / no-cluster branches) so the next flush after
      // confirmation drains it. Covers batch-size, lifecycle and heartbeat too.
      // The gate is told which kind of send this is: it may let a lifecycle
      // send through that it would hold otherwise (SessionLifecycle's
      // releasesOnSuspend).
      if (!this.isFlushAllowed(lifecycle)) {
        this.scheduleFlush();
        return;
      }

      // Keep the periodic flush armed even when there is nothing to send —
      // otherwise one empty window (e.g. an idle gap) kills the heartbeat
      // and later events sit in the pool until batchSize or a lifecycle flush.
      if (!this.pending.events.length) {
        this.scheduleFlush();
        return;
      }

      if (!this.config.getConfig()?.cluster) {
        // Still re-arm: cluster is settable later via updateConfig, and a dead
        // heartbeat would strand the accumulated backlog when it arrives. But
        // warn only once — not every tick of a misconfigured SDK.
        if (!this.noClusterWarned) {
          this.noClusterWarned = true;
          this.logger.log("[events-pool.flush] skipping flush: no cluster");
        }
        this.scheduleFlush();
        return;
      }
      this.noClusterWarned = false;

      const batch = {
        sessionAttributes: this.getSessionAttributes(),
        events: this.pending.toSend(),
      };
      // Emptied BEFORE the send. The lifecycle send reaches the network
      // synchronously, and an event added from inside it (a host fetch wrapper
      // that logs) must land in a fresh buffer: in this one it would be cleared
      // unsent, or a nested flush would send the whole batch twice. Nothing is
      // lost by clearing first: send() contains its own failures.
      this.clearBuffer();
      // Only pass the options arg on the lifecycle path — the periodic /
      // batch-threshold path uses the async encoder by default.
      if (lifecycle) {
        this.transporter.send(batch, { lifecycle: true });
      } else {
        this.transporter.send(batch);
      }
      this.scheduleFlush();
    } catch (error) {
      handleError(error);
    }
  }

  async flushSync() {
    try {
      if (!this.pending.events.length || !this.initialized) return;

      // flushSync runs only from setSessionId, right before an id flip. A
      // never-confirmed session's events must not survive it (sending mints a
      // ghost, re-stamping is wrong) — so discard rather than buffer across it.
      if (!this.isFlushAllowed()) {
        this.discardBuffer();
        return;
      }

      if (!this.config.getConfig()?.cluster) {
        this.logger.log("[events-pool.flush] skipping flush: no cluster");
        return;
      }

      const batch = {
        sessionAttributes: this.getSessionAttributes(),
        events: this.pending.toSend(),
      };
      // Emptied before the send, as in flush(): an event added while it is in
      // flight belongs to the next batch, not to this cleared one.
      this.clearBuffer();
      await this.transporter.send(batch);
    } catch (error) {
      handleError(error);
    }
  }

  private scheduleFlush(): void {
    try {
      if (this.timeoutId !== null) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }

      const batchTimeout = resolveBatchTimeout(
        this.config.getConfig()?.options?.transport?.batchTimeout
      );

      this.timeoutId = setTimeout(() => {
        this.timeoutId = null;
        this.flush();
      }, batchTimeout);
    } catch (error) {
      handleError(error);
    }
  }

  // Public so a host can read the envelope this pool would stamp on a batch
  // right now — to persist it, or to send a batch the pool itself cannot build.
  // Reusing this rather than reassembling the fields keeps such a batch
  // byte-identical to a live one.
  getSessionAttributes(): SessionAttributes {
    return this.buildSessionAttributes();
  }

  private buildSessionAttributes(): SessionAttributes {
    const config = this.config.getConfig();

    // Guarded HERE, around the injected call only. `flush()` builds this
    // envelope inside its own try/catch, so there a throwing device-attributes
    // provider costs only a batch; this accessor is public, so without the guard
    // the same failure would escape into the host app.
    //
    // Narrow on purpose: a coarser guard around the whole envelope would drop
    // cluster/env/namespace/releaseId/user too, and `flush()` has already
    // verified a cluster exists by the time it gets here — so a device-provider
    // failure would silently send a batch with incomplete session metadata and
    // then clear the buffer. The platform's metadata is the only part that can
    // fail, and the only part worth losing.
    let deviceAttributes: Partial<SessionAttributes> = {};
    try {
      deviceAttributes = this.getDeviceAttributes();
    } catch (error) {
      handleError(error);
    }

    return {
      // Host device metadata first — each platform contributes its own
      // fields. Spread BEFORE the session identity fields so a provider can
      // never shadow them (the compiler verifies the result against
      // SessionAttributes — no cast).
      ...deviceAttributes,
      cluster: config?.cluster || "",
      env: config?.environment || "",
      namespace: config?.namespace || "",
      releaseId: config?.releaseId || "",
      session_id: this.session.getSessionId(),
      session_start_time: this.session.getSessionStartTime(),
      user: config?.user || {},
      ["service.name"]: config?.appId,
    };
  }
}
