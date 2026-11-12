package com.groundcover.rum.core.session

import com.groundcover.rum.SessionStorage
import com.groundcover.rum.core.common.SafeStorage
import com.groundcover.rum.core.common.nsToMs
import com.groundcover.rum.core.config.ACTIVITY_PERSIST_THROTTLE_MS
import com.groundcover.rum.core.config.DEFAULT_SESSION_MAX_DURATION_MS
import com.groundcover.rum.core.config.SESSION_INACTIVITY_TIMEOUT_MS

/**
 * The persisted keys, shared with the Flutter, React Native and browser SDKs' storage, and with
 * the testing hooks.
 */
internal object SessionKeys {
    const val ID = SessionStorage.ID

    /** Nanoseconds since the epoch. */
    const val START_TIME = SessionStorage.START_TIME

    /** Milliseconds since the epoch. */
    const val LAST_ACTIVITY = SessionStorage.LAST_ACTIVITY

    const val SAMPLING = SessionStorage.SAMPLING
}

/**
 * Per-session identity and activity: the id, its start time, the activity clock, their
 * persistence, and the gap and cap rules over them.
 */
internal class SessionState(
    private val storage: SafeStorage,
    private val maxDurationMs: (() -> Long?)? = null
) {
    private var cachedSessionId: String? = null
    private var cachedStartTimeNs: Long? = null
    private var cachedLastActivityMs: Long? = null
    private var lastPersistedActivityMs = 0L

    var sessionId: String
        get() = cachedSessionId ?: storage.getItem(SessionKeys.ID) ?: ""
        set(value) {
            cachedSessionId = value
            storage.setItem(SessionKeys.ID, value)
        }

    /** Nanoseconds, or 0 when none is recorded. */
    val sessionStartTimeNs: Long
        get() = cachedStartTimeNs?.takeIf { it != 0L }
            ?: storage.getIntegerItem(SessionKeys.START_TIME)

    /**
     * Starts the session at [startTimeNs]. A session is born unconfirmed: the activity clock is
     * cleared, in memory and in storage, so a restart cannot read a stale value and confirm it
     * falsely.
     */
    fun setSessionStartTime(startTimeNs: Long) {
        cachedStartTimeNs = startTimeNs
        storage.setItem(SessionKeys.START_TIME, startTimeNs.toString())
        cachedLastActivityMs = null
        lastPersistedActivityMs = 0
        storage.removeItem(SessionKeys.LAST_ACTIVITY)
    }

    /** The last genuine activity, epoch milliseconds; 0 when none this session. */
    val lastActivityMs: Long
        get() = cachedLastActivityMs ?: storage.getIntegerItem(SessionKeys.LAST_ACTIVITY)

    /** On every user interaction: exact in memory, throttled to storage. */
    fun recordActivity(atMs: Long) {
        cachedLastActivityMs = atMs
        if (atMs - lastPersistedActivityMs >= ACTIVITY_PERSIST_THROTTLE_MS) persistLastActivity()
    }

    /**
     * Writes the exact activity clock, for the background path, so a restart does not read a value
     * a throttle window stale.
     */
    fun persistLastActivity() {
        val last = cachedLastActivityMs ?: return
        lastPersistedActivityMs = last
        storage.setItem(SessionKeys.LAST_ACTIVITY, last.toString())
    }

    /** The inactivity rule. Before any activity the gap is measured from birth. */
    fun isSessionInactive(nowMs: Long): Boolean {
        val last = lastActivityMs
        val baseline = if (last > 0) last else nsToMs(sessionStartTimeNs)
        return baseline > 0 && nowMs - baseline >= SESSION_INACTIVITY_TIMEOUT_MS
    }

    /**
     * Whether the session has seen genuine interaction: the ghost-session send gate. A stamped
     * activity clock is the confirmation.
     */
    val hasUserActivity: Boolean get() = lastActivityMs > 0

    /** Drops the persisted sampling verdict, so the next session re-rolls it. */
    fun clearSamplingDecision() {
        storage.removeItem(SessionKeys.SAMPLING)
    }

    /** Clears every session key and its in-memory mirror. */
    fun clearSessionState() {
        cachedSessionId = null
        cachedStartTimeNs = null
        cachedLastActivityMs = null
        lastPersistedActivityMs = 0
        storage.removeItem(SessionKeys.ID)
        storage.removeItem(SessionKeys.START_TIME)
        storage.removeItem(SessionKeys.LAST_ACTIVITY)
        clearSamplingDecision()
    }

    val sessionMaxDurationMs: Long
        get() = maxDurationMs?.invoke() ?: DEFAULT_SESSION_MAX_DURATION_MS

    /** Milliseconds since the session started; 0 without a recorded start. */
    fun sessionElapsedMs(nowMs: Long): Long {
        val startNs = sessionStartTimeNs
        return if (startNs != 0L) nowMs - nsToMs(startNs) else 0
    }

    /** The cap rule. False without a recorded start. */
    fun isSessionExpired(nowMs: Long) = sessionElapsedMs(nowMs) >= sessionMaxDurationMs
}
