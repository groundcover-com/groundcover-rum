package com.groundcover.rum.core.session

import com.groundcover.rum.RumEvent
import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.common.RumClock
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.config.SESSION_INACTIVITY_TIMEOUT_MS
import com.groundcover.rum.core.events.earliestTrustedEventTime
import com.groundcover.rum.core.events.isTrustedEventTime

/** What the lifecycle drives in the events pool. */
internal interface LifecyclePool {
    /** Runs before each event joins the buffer. */
    fun setBeforeEnqueueHook(hook: ((RumEvent) -> Unit)?)

    /** Holds every send while it returns false. */
    fun setFlushGate(gate: (() -> Boolean)?)

    fun flush()

    fun discardBuffer()

    /** The earliest trusted time among the buffered events. */
    fun earliestEventTimestamp(nowNs: Long, maxAgeNs: Long): Long?
}

/**
 * The session lifecycle policy: reconciliation (gap and cap expiry), rotation, the ghost-session
 * send gate, and the enqueue hook that drives them from events. Presence signals belong to the
 * platform and arrive through [reconcile]; what they mean is decided here. Lazy by design: a
 * dormant app produces no signals, so nothing here runs.
 */
internal class SessionLifecycle(
    private val session: SessionState,
    private val pool: LifecyclePool,
    private val idGenerator: IdGenerator,
    private val clock: RumClock,
    /** Which event types prove a human is present. */
    private val activityEventTypes: Set<String>,
    /** Heartbeat-style types that never drive reconciliation. */
    private val ignoredEventTypes: Set<String>
) {
    var isRotating = false
        private set

    /**
     * Arms the enqueue hook and the send gate, before any capture arms, so the gate is in place
     * before the first event.
     */
    fun install() {
        pool.setBeforeEnqueueHook(::reconcileOnEnqueue)
        pool.setFlushGate { session.hasUserActivity }
    }

    /**
     * The hook clears first (a teardown enqueue must not rotate), then the host's teardown runs,
     * and the gate clears last, so an unconfirmed session's final batch stays held.
     */
    fun uninstall(hostTeardown: (() -> Unit)? = null) {
        pool.setBeforeEnqueueHook(null)
        try {
            hostTeardown?.invoke()
        } catch (error: Exception) {
            handleError(error)
        }
        pool.setFlushGate(null)
    }

    /**
     * The reconciliation core, shared by every presence source, in order: expiry checks (an
     * inactivity gap only for presence, then the cap for any signal), then presence stamps the
     * activity clock and confirms the session, after the checks so it can't erase a gap it just
     * found.
     *
     * [triggeringEvent] is the event that drove this, when there is one; a rotation starts the new
     * session from it rather than from a second clock read.
     */
    fun reconcile(nowMs: Long, userPresent: Boolean, triggeringEvent: RumEvent? = null) {
        if (isRotating) return
        if (userPresent && session.isSessionInactive(nowMs)) {
            rotate("inactivity gap", triggeringEvent)
        }
        // After a gap rotation the start is fresh, so this can't rotate twice.
        val elapsedMs = session.sessionElapsedMs(nowMs)
        val maxMs = session.sessionMaxDurationMs
        RumDiagnostics.shared.log(
            "[session-lifecycle] session reconcile",
            mapOf("userPresent" to userPresent, "elapsedMs" to elapsedMs, "maxDurationMs" to maxMs)
        )
        if (elapsedMs >= maxMs) rotate("max session duration", triggeringEvent)
        if (userPresent) session.recordActivity(nowMs)
    }

    private fun reconcileOnEnqueue(event: RumEvent) {
        if (isRotating || event.type in ignoredEventTypes) return
        reconcile(clock(), event.type in activityEventTypes, event)
    }

    /**
     * Rotates only when the session is stale, before an operation that must run under a current
     * one.
     */
    fun rotateIfStale(nowMs: Long, reason: String) {
        if (session.isSessionInactive(nowMs) || session.isSessionExpired(nowMs)) rotate(reason)
    }

    /**
     * The single rotation primitive. A confirmed session flushes its stragglers under the old id;
     * an unconfirmed (ghost) session's buffer is discarded, so it can't leak into the new id. Each
     * step is isolated, so one failure doesn't abort the rest.
     */
    fun rotate(reason: String, triggeringEvent: RumEvent? = null) {
        if (isRotating) return
        isRotating = true
        try {
            val previousId = session.sessionId
            // Before the id flip, which resets it.
            val wasConfirmed = session.hasUserActivity
            RumDiagnostics.shared.log(
                "[session-lifecycle] session rotation start",
                mapOf(
                    "reason" to reason,
                    "previousId" to previousId,
                    "wasConfirmed" to wasConfirmed
                )
            )
            if (wasConfirmed) {
                step("flush events") { pool.flush() }
            } else {
                step("discard unconfirmed events") { pool.discardBuffer() }
            }
            step("rotate session ids") {
                val newId = idGenerator.generateId()
                // Resolved before either write, so the new id is never paired with the old start.
                val startNs = resolveNewSessionStartTime(triggeringEvent)
                session.sessionId = newId
                session.setSessionStartTime(startNs)
                session.clearSamplingDecision()
                RumDiagnostics.shared.log(
                    "[session-lifecycle] session id rotated",
                    mapOf("from" to previousId, "to" to newId)
                )
            }
        } finally {
            isRotating = false
        }
    }

    private fun step(label: String, run: () -> Unit) {
        try {
            run()
        } catch (error: Exception) {
            handleError(error)
            RumDiagnostics.shared.log(
                "[session-lifecycle] failed to $label during rotation:",
                error
            )
        }
    }

    // A session must never start after an event that belongs to it: consumers derive session
    // duration from last event - session_start_time. So the start is the earliest trusted time
    // among the clock, the triggering event (not in the pool yet), and whatever the flush left in
    // the pool. Candidates are trusted only within the tighter of the cap and the idle window, so a
    // bogus-old time can't open a session that is born already stale.
    private fun resolveNewSessionStartTime(triggeringEvent: RumEvent?): Long {
        val nowNs = msToNs(clock())
        var earliest = nowNs
        try {
            val maxAgeNs =
                msToNs(minOf(session.sessionMaxDurationMs, SESSION_INACTIVITY_TIMEOUT_MS))
            val candidates = listOf(
                earliestTrustedEventTime(listOf(triggeringEvent), nowNs, maxAgeNs),
                pool.earliestEventTimestamp(nowNs, maxAgeNs)
            )
            for (candidate in candidates) {
                if (isTrustedEventTime(candidate, nowNs, maxAgeNs) && candidate!! < earliest) {
                    earliest = candidate
                }
            }
        } catch (error: Exception) {
            handleError(error)
        }
        return earliest
    }
}
