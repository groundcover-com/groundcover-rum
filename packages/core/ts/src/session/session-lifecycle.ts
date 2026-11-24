import { Logger } from "../common/logger";
import { handleError } from "../common/error-handler";
import { msToNs } from "../common/global";
import { SESSION_INACTIVITY_TIMEOUT_MS } from "../config/constants";
import { IdGenerator } from "../common/id-generator";
import { BaseEvent } from "../events/types";
import { EventsPool } from "../events/events-pool";
import { earliestTrustedEventTime, isTrustedEventTime } from "../events/event-time";
import { SessionState } from "./session-state";

// Host observation points on the lifecycle, generic over TRotationContext —
// an opaque value the host captures at rotation start and receives back after
// the id flip. All hooks optional; the policy runs the same with or without
// them. (A host may use the context pair to coordinate its own session-scoped
// work across the flip; this class knows nothing about what the context means.)
export interface SessionLifecycleHooks<TRotationContext = void> {
  // Captured FIRST in a rotation, before beforeRotate mutates anything — the
  // place to snapshot host state the afterRotate decision needs (state that
  // beforeRotate's teardown would erase).
  captureRotationContext?: () => TRotationContext;
  // Runs before the buffer is drained — the host stops anything that must
  // land its final events in the pool under the OLD session id.
  beforeRotate?: () => void;
  // Runs last in a rotation, after the id flip, with the captured context —
  // the host reconciles its state under the new session id.
  afterRotate?: (context: TRotationContext) => void;
  // Runs on every reconcile after the expiry checks, before the presence
  // stamp — the host reconciles presence-coupled state here (presence only;
  // never background traffic).
  onReconcile?: (userPresent: boolean) => void;
  // Runs after genuine presence stamped the activity clock — the host feeds
  // its presence/idle tracking here.
  onPresenceStamped?: (nowMs: number) => void;
}

export interface SessionLifecycleDeps<
  TRotationContext = void,
  TType extends string = string,
> {
  session: SessionState;
  pool: EventsPool<TType>;
  idGenerator: IdGenerator;
  // The single presence notion for the whole lifecycle (gap rotation,
  // activity clock, send gate): which event types prove a human is present.
  // Platform-owned — typically the platform's user-interaction kinds.
  // Load, navigation and background traffic prove no human.
  activityEventTypes: ReadonlySet<TType>;
  // Event types the enqueue hook must NOT reconcile on: heartbeat-style
  // events a platform emits regardless of user action (e.g. periodic
  // recording batches). Platform-owned; pass an empty set if none exist.
  ignoredEventTypes: ReadonlySet<TType>;
  // Optional exception to the send gate, for the host's lifecycle flushes
  // (flush({ lifecycle: true })). Given the whole buffer, it decides whether a
  // session no interaction confirmed sends that buffer on the flush instead of
  // holding it, so a visit worth keeping (e.g. one that caught an exception
  // while loading, or one the user could see) isn't lost when the user leaves
  // without touching anything. It may also read platform state of its own
  // (the browser: whether the page was ever visible). Every other send stays
  // gated, the session stays unconfirmed, and nothing it reads counts as
  // presence.
  //
  // Only the session current when install() ran: a session a later rotation
  // starts with no interaction (the cap passing in a tab nobody touches) is
  // background traffic, which is what the gate is for.
  //
  // Each lifecycle flush the platform makes releases, not only suspend. On the
  // browser the page-hide flush is the only one. React Native also forces one
  // after a fatal error and after a recovered hang, so adopting this there as
  // is would release on those too.
  //
  // Platform-owned (the browser: the page was visible, or a real exception).
  // Omitted: the gate has no exception, as on a platform that hasn't adopted
  // it.
  releasesOnSuspend?: (events: ReadonlyArray<BaseEvent<TType>>) => boolean;
  hooks?: SessionLifecycleHooks<TRotationContext>;
}

// The session lifecycle POLICY: reconciliation (gap + cap expiry), rotation
// orchestration, the ghost-session send gate, and the enqueue hook that keys
// them off SDK events. Presence SIGNALS are platform-owned (raw input, app
// foreground/background) and arrive via reconcile(); what they mean is decided
// here. Lazy by design: a dormant app produces no signals, so nothing here
// ever runs (no phantom sessions).
export class SessionLifecycle<
  TRotationContext = void,
  TType extends string = string,
> {
  private logger = Logger.getInstance();
  private readonly session: SessionState;
  private readonly pool: EventsPool<TType>;
  private readonly idGenerator: IdGenerator;
  private readonly activityEventTypes: ReadonlySet<TType>;
  private readonly ignoredEventTypes: ReadonlySet<TType>;
  private readonly releasesOnSuspend: ((events: ReadonlyArray<BaseEvent<TType>>) => boolean) | null;
  private readonly hooks: SessionLifecycleHooks<TRotationContext>;
  private rotating = false;
  // Whether releasesOnSuspend still applies: true for the session current at
  // install, false from the first rotation on.
  private releaseEligible = true;

  constructor(deps: SessionLifecycleDeps<TRotationContext, TType>) {
    this.session = deps.session;
    this.pool = deps.pool;
    this.idGenerator = deps.idGenerator;
    this.activityEventTypes = deps.activityEventTypes;
    this.ignoredEventTypes = deps.ignoredEventTypes;
    this.releasesOnSuspend = deps.releasesOnSuspend ?? null;
    this.hooks = deps.hooks ?? {};
  }

  get isRotating(): boolean {
    return this.rotating;
  }

  // Arm the pool-side observation points. The enqueue hook drives per-event
  // reconciliation; the flush gate holds transmission until the session has
  // observed genuine presence (the anti-ghost-session rule), except for a
  // lifecycle flush of the install-time session whose buffer releasesOnSuspend
  // releases. Install BEFORE the host's listeners arm, so the gate is in place
  // before the first event is captured.
  install(): void {
    this.pool.setBeforeEnqueueHook((event) => this.reconcileOnEnqueue(event));
    this.pool.setFlushGate(({ lifecycle, events }) =>
      this.session.hasUserActivity()
      || (lifecycle && this.releaseEligible && this.releasesBuffer(events))
    );
  }

  // Contained HERE rather than left to the pool: the pool fails a throwing gate
  // OPEN, which for this optional exception would send every unconfirmed
  // session. A releasesOnSuspend that throws releases nothing, as if omitted.
  private releasesBuffer(events: ReadonlyArray<BaseEvent<TType>>): boolean {
    const releases = this.releasesOnSuspend;
    if (!releases) return false;
    try {
      return releases(events) === true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }

  // Teardown ordering is a contract this method OWNS (not a comment callers
  // must remember): the enqueue hook clears FIRST (a teardown-time enqueue
  // must not re-trigger rotation), then the host's own teardown runs (hosts
  // stop their listeners here; anything stopped enqueues its final events),
  // and the gate clears LAST so an unconfirmed session's final batch stays
  // gated instead of leaking once the gate opens.
  uninstall(hostTeardown?: () => void): void {
    this.pool.setBeforeEnqueueHook(null);
    try {
      hostTeardown?.();
    } catch (error) {
      handleError(error);
    }
    this.pool.setFlushGate(null);
  }

  // The session reconciliation core, shared by every presence source. Three ordered steps:
  // expiry checks and rotate (an inactivity gap, which only presence qualifies for, then the
  // wall-clock cap, which is checked for every signal that REACHES here — `reconcileOnEnqueue`
  // returns early for `ignoredEventTypes`, so those never arrive); `hooks.onReconcile`, where the
  // host reconciles presence-coupled state; then presence stamps the activity clock and confirms
  // the session — AFTER the checks, so it cannot erase the gap just detected.
  //
  // `triggeringEvent` is the SDK event that drove this reconcile, when there is
  // one. It is passed through to a rotation so the new session can start from
  // its own first event rather than from a second clock read — the raw-input
  // presence sources have no event and simply omit it.
  reconcile(
    nowMs: number,
    userPresent: boolean,
    triggeringEvent?: BaseEvent<TType> | null,
  ): void {
    if (this.rotating) return;

    if (userPresent && this.session.isSessionInactive(nowMs)) {
      this.rotate({ reason: "inactivity gap", triggeringEvent });
    }

    // After a gap rotation the start time is fresh, so the cap check below
    // can't double-rotate.
    const elapsedMs = this.session.getSessionElapsedMs(nowMs);
    const maxDurationMs = this.session.getSessionMaxDuration();
    const expired = elapsedMs >= maxDurationMs;
    this.logger.log("[session-lifecycle] session reconcile", {
      userPresent,
      elapsedMs,
      maxDurationMs,
      expired,
    });
    if (expired) {
      this.rotate({ reason: "max session duration", triggeringEvent });
    }

    this.hooks.onReconcile?.(userPresent);

    if (userPresent) {
      // Genuine presence: stamp the activity clock AFTER the checks. The stamp
      // itself confirms the session — a stamped clock opens the flush gate.
      this.session.setLastActivityMs(nowMs);
      this.hooks.onPresenceStamped?.(nowMs);
    }
  }

  // Presence source 1: the beforeEnqueue hook. ignoredEventTypes are skipped —
  // heartbeat-style events fire regardless of user action, so they must not
  // drive reconciliation on their own. (Presence source 2 is the host's
  // raw-input monitor, feeding reconcile() directly.)
  private reconcileOnEnqueue(event: BaseEvent<TType>): void {
    if (this.rotating) return;
    if (this.ignoredEventTypes.has(event.type)) {
      this.logger.log(
        "[session-lifecycle] enqueue rotation check: ignoring heartbeat-style event",
        event.type,
      );
      return;
    }

    this.reconcile(Date.now(), this.activityEventTypes.has(event.type), event);
  }

  // Close a STALE session (inactivity gap open OR cap exceeded) before an
  // operation that must run under a current session — a host calls this
  // before starting anything long-lived that must not begin under a session
  // that has conceptually ended. Only rotates when actually stale.
  rotateIfStale(nowMs: number, reason: string): void {
    if (this.session.isSessionInactive(nowMs) || this.session.isSessionExpired(nowMs)) {
      this.rotate({ reason });
    }
  }

  // Single rotation primitive for every trigger (inactivity gap, max-duration,
  // stale-start). Order matters: capture the host's rotation context, then
  // beforeRotate (so anything the host stops lands its final events in the
  // pool), then one (sync, fire-and-forget) flush drains everything under the
  // OLD id, then rotate ids, then afterRotate with the captured context.
  rotate(options: { reason: string; triggeringEvent?: BaseEvent<TType> | null }): void {
    if (this.rotating) return;
    this.rotating = true;

    // Isolate each step so one failure doesn't abort the rest of the rotation.
    const step = (label: string, fn: () => void) => {
      try {
        this.logger.log(`[session-lifecycle] session rotation: ${label}`);
        fn();
      } catch (error) {
        handleError(error);
        this.logger.log(`[session-lifecycle] failed to ${label} during session rotation:`, error);
      }
    };

    // EVERYTHING below runs inside the try: `rotating` is already true, so any
    // escape before the `finally` would strand it and turn every later
    // reconcile()/rotate() into a silent permanent no-op.
    try {
      const previousId = this.session.getSessionId();
      // Host context is captured BEFORE beforeRotate mutates anything — the
      // afterRotate decision may depend on state beforeRotate tears down.
      // Isolated like every other host hook: a platform's capture throwing
      // must not abort the rotation.
      let rotationContext: TRotationContext | undefined;
      step("capture host rotation context", () => {
        rotationContext = this.hooks.captureRotationContext?.();
      });
      // Capture confirmation BEFORE the id flip (setSessionStartTime resets it). A
      // confirmed session flushes its stragglers under the old id; an unconfirmed
      // (ghost) session's buffer is discarded so it can't leak into the new id.
      const wasConfirmed = this.session.hasUserActivity();
      this.logger.log("[session-lifecycle] session rotation start", {
        reason: options.reason,
        previousId,
        wasConfirmed,
      });

      step("host beforeRotate", () => this.hooks.beforeRotate?.());
      step(
        wasConfirmed ? "flush events" : "discard unconfirmed events",
        () => (wasConfirmed ? this.pool.flush() : this.pool.discardBuffer()),
      );
      step("rotate session ids", () => {
        const newId = this.idGenerator.generateId();
        // Resolved before either write so a failure can't leave the new id
        // paired with the previous session's start time.
        const startNs = this.resolveNewSessionStartTime(options.triggeringEvent);
        this.session.setSessionId(newId);
        // The new session isn't the one the SDK started with: no release.
        this.releaseEligible = false;
        // Also resets the activity clock (see SessionState.setSessionStartTime),
        // so a pre-gap lastActivity can't instantly gap-rotate the new session.
        this.session.setSessionStartTime(startNs);
        // The sampling verdict is per-session, so the new id re-rolls it.
        this.session.clearSamplingDecision();
        this.logger.log("[session-lifecycle] session id rotated", { from: previousId, to: newId });
      });
      step("host afterRotate", () => this.hooks.afterRotate?.(rotationContext as TRotationContext));
    } finally {
      this.rotating = false;
      this.logger.log("[session-lifecycle] session rotation complete", { reason: options.reason });
    }
  }

  // When does the rotated session start?
  //
  // Not simply "now". A session must never start AFTER an event that belongs to
  // it: consumers derive session duration from last event - session_start_time,
  // so an inverted pair yields a negative duration. A second Date.now() read here
  // lands several milliseconds after the enricher stamped the very event that
  // triggered the rotation, so the event that OPENED the session would predate it.
  //
  // So take the earliest trusted time that belongs to the new session, from the
  // clock and two event sources:
  //
  // 1. The triggering event. It is not in the pool yet — EventsPool.addEvent
  //    fires onBeforeEnqueue (which lands here) BEFORE it pushes — so it arrives
  //    as a parameter. It is the new session's first event.
  // 2. Whatever the drain left in the pool. flush() returns without emptying the
  //    buffer when no cluster is configured, and those events ship under the new
  //    id (see EventsPool.getEarliestEventTimestamp).
  //
  // Untrusted candidates are IGNORED, never used as the value — this writes the
  // POLICY clock (cap + inactivity), not just a wire attribute. A bogus-old
  // timestamp adopted here would put the session instantly past its cap, so the
  // next event would rotate again, and the next, minting a session id per event;
  // `rotating` guards re-entrancy within one rotation, not across successive
  // ones. earliestTrustedEventTime owns that window.
  //
  // Contained: this must always yield a number. An escape would leave the new id
  // paired with the old session's start time, which is worse than a few
  // milliseconds of skew.
  private resolveNewSessionStartTime(triggeringEvent?: BaseEvent<TType> | null): number {
    const nowNs = msToNs(Date.now());
    let earliest = nowNs;

    try {
      // How far back a candidate may reach. Bounded by BOTH session clocks, not
      // just the cap, because a derived start must never make the session it
      // opens retroactively stale:
      //
      // - past the cap  -> born already expired, so the next event rotates again;
      // - past the idle window -> born already gap-stale, so the next genuine
      //   interaction rotates again — and that rotation sees wasConfirmed=false
      //   (birth reset the activity clock) and DISCARDS the buffer, losing the
      //   events the first rotation had just queued.
      //
      // The idle window is the tighter of the two at every supported cap, so this
      // is effectively "at most one idle window back". It still covers the real
      // cases by orders of magnitude — a rotation interleave is milliseconds, an
      // in-flight network span seconds. A retained backlog older than the window
      // keeps its inversion, which is the correct trade: adopting it would cost
      // the whole buffer.
      const maxAgeNs = msToNs(
        Math.min(this.session.getSessionMaxDuration(), SESSION_INACTIVITY_TIMEOUT_MS)
      );
      const candidates = [
        earliestTrustedEventTime([triggeringEvent], nowNs, maxAgeNs),
        this.pool.getEarliestEventTimestamp(nowNs, maxAgeNs),
      ];

      // Re-checked here, not taken on trust. The pool applies the same window
      // internally, but this is the code that ADOPTS the value as the session's
      // start — the guarantee has to hold at the write, not upstream of it.
      for (const candidate of candidates) {
        if (isTrustedEventTime(candidate, nowNs, maxAgeNs) && candidate < earliest) {
          earliest = candidate;
        }
      }
    } catch (error) {
      handleError(error);
    }

    return earliest;
  }
}
