package com.groundcover.rum.core.session

import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.common.RumClock
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.SafeStorage
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.common.nsToMs

/**
 * Session-level sampling: decided once per session and persisted, so a restart mid-session keeps
 * its verdict. A rate of 1 (or null) samples everything; an explicit 0 samples nothing.
 */
internal fun resolveSamplingDecision(
    storage: SafeStorage,
    sessionSampleRate: Double?,
    random: () -> Double = { Math.random() }
): Boolean {
    val rate = sessionSampleRate
    if (rate == null || !rate.isFinite() || rate == 1.0) return true
    val stored = storage.getItem(SessionKeys.SAMPLING)
    if (!stored.isNullOrEmpty()) {
        val decision = stored == "1"
        RumDiagnostics.shared.log("[session-bootstrap] using stored sampling decision:", decision)
        return decision
    }
    val decision = random() < rate
    storage.setItem(SessionKeys.SAMPLING, if (decision) "1" else "0")
    RumDiagnostics.shared.log("[session-bootstrap] stored new sampling decision:", decision)
    return decision
}

private const val FUTURE_SKEW_TOLERANCE_MS = 60_000L

/**
 * Start-time session identity, resolved before the lifecycle arms, so the first event carries a
 * current id.
 *
 * 1. A new provided id starts its own cap clock; the same id provided again is a continuation that
 *    keeps the stored start. No id at all mints one.
 * 2. A persisted start is trusted only if positive and not implausibly in the future (a minute
 *    absorbs clock skew). Otherwise it is treated as missing.
 * 3. Expiry at start mirrors the per-event check: a restart is activity too.
 */
internal fun bootstrapSession(
    session: SessionState,
    idGenerator: IdGenerator,
    clock: RumClock,
    providedSessionId: String?
) {
    try {
        val existing = session.sessionId
        val provided = providedSessionId
        if (!provided.isNullOrEmpty() && provided != existing) {
            session.sessionId = provided
            session.setSessionStartTime(msToNs(clock()))
            // A different session: its sampling verdict is re-rolled.
            session.clearSamplingDecision()
            RumDiagnostics.shared.log("[session-bootstrap] using provided sessionId:", provided)
        } else if (!provided.isNullOrEmpty()) {
            session.sessionId = provided
            RumDiagnostics.shared.log(
                "[session-bootstrap] continuing provided sessionId:",
                provided
            )
        } else if (existing.isEmpty()) {
            session.sessionId = idGenerator.generateId()
        }

        val nowMs = clock()
        val persistedStartMs = nsToMs(session.sessionStartTimeNs)
        val hasValidStart =
            persistedStartMs > 0 && nowMs - persistedStartMs >= -FUTURE_SKEW_TOLERANCE_MS
        if (!hasValidStart) {
            session.setSessionStartTime(msToNs(nowMs))
        } else if (session.isSessionExpired(nowMs) || session.isSessionInactive(nowMs)) {
            val reason = if (session.isSessionExpired(nowMs)) {
                "persisted session past cap"
            } else {
                "inactivity gap across restart"
            }
            val previousId = session.sessionId
            val newId = idGenerator.generateId()
            session.sessionId = newId
            session.setSessionStartTime(msToNs(nowMs))
            session.clearSamplingDecision()
            RumDiagnostics.shared.log(
                "[session-bootstrap] start-time rotation: $reason",
                mapOf("from" to previousId, "to" to newId)
            )
        }
    } catch (error: Exception) {
        handleError(error)
    }
}
