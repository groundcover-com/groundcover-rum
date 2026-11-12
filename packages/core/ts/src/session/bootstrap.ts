import { Logger } from "../common/logger";
import { msToNs, nsToMs } from "../common/global";
import { IdGenerator } from "../common/id-generator";
import { SafeStorage } from "../common/storage";
import { SAMPLING_STORAGE_KEY } from "../config/constants";
import { SessionState } from "./session-state";

export { SAMPLING_STORAGE_KEY };

// Session-level sampling: decided once per session and persisted, so a restart
// mid-session keeps the same verdict instead of re-rolling the dice.
export function resolveSamplingDecision({
  storage,
  sessionSampleRate,
}: {
  storage: SafeStorage;
  sessionSampleRate?: number;
}): boolean {
  const logger = Logger.getInstance();

  // `undefined` (and non-finite garbage) means "no sampling configured" — sample
  // everything. An explicit 0 must NOT be folded in here: it means "sample
  // nothing", and a falsy check would invert it into sampling everything.
  if (
    sessionSampleRate === undefined ||
    !Number.isFinite(sessionSampleRate) ||
    sessionSampleRate === 1
  ) {
    return true;
  }
  const rate = sessionSampleRate;

  try {
    const storedSamplingDecision = storage.getItem(SAMPLING_STORAGE_KEY);

    if (storedSamplingDecision) {
      const decision = storedSamplingDecision === "1";
      logger.log("[session-bootstrap] using stored sampling decision:", decision);
      return decision;
    }

    const decision = Math.random() < rate;
    storage.setItem(SAMPLING_STORAGE_KEY, decision ? "1" : "0");

    logger.log("[session-bootstrap] stored new sampling decision:", decision);

    return decision;
  } catch (error) {
    logger.log("[session-bootstrap] storage access failed:", error);
    const decision = Math.random() < rate;
    logger.log("[session-bootstrap] using fallback sampling decision:", decision);
    return decision;
  }
}

// Init-time session identity resolution, running BEFORE the lifecycle's lazy enqueue hook arms
// so the first event carries a fresh id. Three rules:
//
// 1. A NEW provided id starts its own cap clock; the SAME id re-provided is a continuation that
//    keeps the stored start time, so session_start_time does not drift. No id → mint one.
// 2. A persisted start is trusted only if positive and not implausibly future — the tolerance
//    absorbs ns<->ms rounding and clock skew. Untrustworthy is treated as missing.
// 3. Init-time expiry mirrors the per-event lazy check, since a restart is itself user activity.
export function bootstrapSession({
  session,
  idGenerator,
  providedSessionId,
}: {
  session: SessionState;
  idGenerator: IdGenerator;
  providedSessionId?: string;
}): void {
  const logger = Logger.getInstance();

  // Contained like resolveSamplingDecision above: this runs at SDK init, and an
  // unexpected throw from the id generator or a hostile storage getter must not
  // propagate into the host application's init flow.
  try {
    const existingSessionId = session.getSessionId();

    if (providedSessionId && providedSessionId !== existingSessionId) {
      session.setSessionId(providedSessionId);
      session.setSessionStartTime(msToNs(Date.now()));
      // A DIFFERENT provided id is a different session, so its sampling
      // verdict is re-rolled. Re-providing the SAME id (the branch below) is a
      // continuation and deliberately keeps the stored verdict.
      session.clearSamplingDecision();
      logger.log("[session-bootstrap] using provided sessionId:", providedSessionId);
    } else if (providedSessionId) {
      session.setSessionId(providedSessionId);
      logger.log("[session-bootstrap] continuing provided sessionId:", providedSessionId);
    } else if (!existingSessionId) {
      session.setSessionId(idGenerator.generateId());
    }

    const FUTURE_SKEW_TOLERANCE_MS = 60_000;
    const nowMs = Date.now();
    const persistedStartMs = nsToMs(session.getSessionStartTime());
    const hasValidStart =
      persistedStartMs > 0 && nowMs - persistedStartMs >= -FUTURE_SKEW_TOLERANCE_MS;
    if (!hasValidStart) {
      session.setSessionStartTime(msToNs(nowMs));
    } else if (session.isSessionExpired(nowMs) || session.isSessionInactive(nowMs)) {
      const reason = session.isSessionExpired(nowMs)
        ? "persisted session past cap"
        : "inactivity gap across restart";
      const previousId = session.getSessionId();
      const newId = idGenerator.generateId();
      session.setSessionId(newId);
      session.setSessionStartTime(msToNs(nowMs));
      // Same rule as the lifecycle's runtime rotation: new session, new roll.
      session.clearSamplingDecision();
      logger.log(`[session-bootstrap] init-time rotation: ${reason}`, { from: previousId, to: newId });
    }
  } catch (error) {
    logger.log("[session-bootstrap] session bootstrap failed:", error);
  }
}
