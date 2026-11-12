import {
  DEFAULT_SESSION_MAX_DURATION_MS,
  SESSION_INACTIVITY_TIMEOUT_MS,
  ACTIVITY_PERSIST_THROTTLE_MS,
  SAMPLING_STORAGE_KEY,
} from "../config/constants";
import { nsToMs } from "../common/global";
import { SafeStorage } from "../common/storage";

export interface SessionStateDeps {
  storage: SafeStorage;
  // Session cap from live config; undefined → the documented default. Injected
  // as a provider so runtime config updates apply without re-wiring.
  getMaxDurationMs?: () => number | undefined;
}

// All per-session identity and activity state: the session id, its start
// time, the activity clock, their persistence, and the gap/cap rules over
// them. Separate from ConfigManager so "session management" is its own
// platform-agnostic unit — config stays configuration.
export class SessionState {
  private readonly storage: SafeStorage;
  private readonly getMaxDurationMs: (() => number | undefined) | null;
  private sessionId: string | null = null;
  private sessionStartTime: number | null = null;
  private lastActivityMs: number | null = null;
  private lastPersistedActivityMs = 0;

  constructor(deps: SessionStateDeps) {
    this.storage = deps.storage;
    this.getMaxDurationMs = deps.getMaxDurationMs ?? null;
  }

  getSessionId() {
    if (this.sessionId) {
      return this.sessionId;
    }

    const storedSessionId = this.storage.getItem("gcId");

    return storedSessionId || "";
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
    this.storage.setItem("gcId", sessionId);
  }

  getSessionStartTime() {
    if (this.sessionStartTime) {
      return this.sessionStartTime;
    }

    return this.storage.getNumericItem("gcStartTime", 0);
  }

  setSessionStartTime(startTime: number) {
    this.sessionStartTime = startTime;
    this.storage.setItem("gcStartTime", String(startTime));
    // Born UNCONFIRMED: lastActivity stays null — the single "has the user been
    // active?" signal (the gap clock falls back to sessionStartTime). Also drop
    // gcLastActivity, else a restart reads a stale value and falsely confirms.
    this.lastActivityMs = null;
    this.lastPersistedActivityMs = 0;
    this.storage.removeItem("gcLastActivity");
  }

  // Last genuine-activity time, ms epoch. 0 = none yet this session (unconfirmed).
  // In-memory first; falls back to storage (a restart, or before the first stamp).
  getLastActivityMs(): number {
    if (this.lastActivityMs !== null) {
      return this.lastActivityMs;
    }

    return this.storage.getNumericItem("gcLastActivity", 0);
  }

  // Hot path — fires on every user-interaction event. Memory is always exact;
  // storage writes are throttled (see ACTIVITY_PERSIST_THROTTLE_MS).
  setLastActivityMs(nowMs: number) {
    this.lastActivityMs = nowMs;

    if (nowMs - this.lastPersistedActivityMs >= ACTIVITY_PERSIST_THROTTLE_MS) {
      this.persistLastActivity();
    }
  }

  // The single gcLastActivity write — shared by the throttled hot path and the
  // exact suspend-time flush (the host calls this from its suspend wiring, so a
  // restart can't read a value up to a throttle-window stale and gap-rotate
  // early). The null guard keeps a stray post-clearSessionState call from
  // resurrecting the removed storage key.
  persistLastActivity(): void {
    if (this.lastActivityMs === null) return;
    this.lastPersistedActivityMs = this.lastActivityMs;
    this.storage.setItem("gcLastActivity", String(this.lastActivityMs));
  }

  // The inactivity-gap rule (per-event + init-time). Before the first genuine
  // activity the clock is unstamped, so fall back to sessionStartTime (the birth
  // instant) — an unconfirmed newborn measures the gap from birth.
  isSessionInactive(nowMs: number = Date.now()): boolean {
    const lastActivityMs = this.getLastActivityMs();
    const baselineMs = lastActivityMs > 0 ? lastActivityMs : nsToMs(this.getSessionStartTime());
    return baselineMs > 0 && nowMs - baselineMs >= SESSION_INACTIVITY_TIMEOUT_MS;
  }

  // Whether this session has seen genuine interaction — the anti-"ghost-session"
  // send gate. A stamped activity clock IS the confirmation: any genuine presence
  // calls setLastActivityMs, and only birth leaves it unstamped (null/0).
  hasUserActivity(): boolean {
    return this.getLastActivityMs() > 0;
  }

  // Drop the persisted sampling verdict so the NEXT session re-rolls instead of
  // inheriting this one's. The verdict is documented as "decided once per
  // session"; without this it would really be "once per storage lifetime",
  // because nothing else ever removes the key.
  clearSamplingDecision() {
    this.storage.removeItem(SAMPLING_STORAGE_KEY);
  }

  // Tear down all session-scoped state — the storage keys AND their in-memory
  // mirrors — so a destroy() → init() cycle in the same host starts clean
  // instead of resurrecting a stale session id or activity clock.
  clearSessionState() {
    this.sessionId = null;
    this.sessionStartTime = null;
    this.lastActivityMs = null;
    this.lastPersistedActivityMs = 0;
    this.storage.removeItem("gcId");
    this.storage.removeItem("gcStartTime");
    this.storage.removeItem("gcLastActivity");
    this.clearSamplingDecision();
  }

  getSessionMaxDuration(): number {
    return this.getMaxDurationMs?.() ?? DEFAULT_SESSION_MAX_DURATION_MS;
  }

  // Wall-clock time elapsed since the session started, in ms (0 if no start is
  // recorded).
  getSessionElapsedMs(nowMs: number = Date.now()): number {
    const sessionStartNs = this.getSessionStartTime();
    return sessionStartNs ? nowMs - nsToMs(sessionStartNs) : 0;
  }

  // The cap rule, shared by both enforcement sites (the per-event lazy check and
  // the init-time check). False when there's no recorded start time (elapsed 0).
  isSessionExpired(nowMs: number = Date.now()): boolean {
    return this.getSessionElapsedMs(nowMs) >= this.getSessionMaxDuration();
  }
}
