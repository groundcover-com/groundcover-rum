package com.groundcover.rum.core.events

import com.groundcover.rum.RumEvent
import com.groundcover.rum.RumUser
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.UserHook
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.toJsonMap
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.config.DEFAULT_BATCH_SIZE
import com.groundcover.rum.core.config.DEFAULT_BATCH_TIMEOUT_MS
import com.groundcover.rum.core.pipeline.CoreExecutor
import com.groundcover.rum.core.pipeline.ScheduledWork
import com.groundcover.rum.core.session.LifecyclePool
import com.groundcover.rum.core.session.SessionState
import com.groundcover.rum.core.transport.Batch
import com.groundcover.rum.core.transport.Transporter

/**
 * Events held while the send gate is closed (no presence yet), or while there is no cluster to
 * send under. Bounds a never-confirmed session (real sessions confirm in seconds) and a cluster
 * that never arrives (a missing build setting). On overflow the newest is dropped, keeping the
 * earliest.
 */
internal const val MAX_GATED_BUFFER_EVENTS = 500

/**
 * An explicit 0 is honoured (every event flushes); anything negative falls back to the default,
 * so a bad value can't switch size flushing off.
 */
private fun resolveBatchSize(value: Int?) = if (value != null &&
    value >= 0
) {
    value
} else {
    DEFAULT_BATCH_SIZE
}

/** Zero is not honoured: a 0 ms timer would busy-flush. */
private fun resolveBatchTimeoutMs(value: Long?) =
    if (value != null && value > 0) value else DEFAULT_BATCH_TIMEOUT_MS

/**
 * Buffers events, runs the `beforeSend` and `enrichEvent` hooks, and ships batches on size, on a
 * timer, or on demand. Confined to the core thread. The timer runs only while something is
 * buffered: armed by the first event into an empty buffer, so an idle app is never woken by it.
 */
internal class EventsPool(
    private val config: ConfigManager,
    private val session: SessionState,
    private val transporter: Transporter,
    /** The envelope's device part: `source`, `os`, `device`, `app`. */
    private val deviceAttributes: () -> Map<String, Any?>,
    /** Types that never trigger a size flush; they ride along with the next one. */
    private val eventsToSkipFlush: Set<String>,
    private val executor: CoreExecutor
) : LifecyclePool {
    private var events = mutableListOf<RumEvent>()
    private var timer: ScheduledWork? = null
    private var initialized = false
    private var noClusterWarned = false
    private var onBeforeEnqueue: ((RumEvent) -> Unit)? = null
    private var flushGate: (() -> Boolean)? = null

    fun initialize() {
        initialized = true
    }

    fun destroy() {
        timer?.cancel()
        timer = null
        events = mutableListOf()
        initialized = false
    }

    /** Called with each accepted event just before it is buffered. */
    override fun setBeforeEnqueueHook(hook: ((RumEvent) -> Unit)?) {
        onBeforeEnqueue = hook
    }

    /** While this returns false, sends hold instead of shipping. */
    override fun setFlushGate(gate: (() -> Boolean)?) {
        flushGate = gate
    }

    /**
     * Drops the buffer without sending: a rotating session that never saw a user must neither ship
     * its events nor leak them into the next session.
     */
    override fun discardBuffer() {
        events = mutableListOf()
        cancelTimer()
    }

    /**
     * The earliest trusted time still buffered, for a rotation to start the new session no later
     * than events that will ship under it.
     */
    override fun earliestEventTimestamp(nowNs: Long, maxAgeNs: Long): Long? =
        earliestTrustedEventTime(events, nowNs, maxAgeNs)

    // A throwing gate fails open: silently dropping a real session forever is worse than a rare
    // ghost.
    private fun isFlushAllowed(): Boolean {
        val gate = flushGate ?: return true
        return try {
            gate()
        } catch (error: Exception) {
            handleError(error)
            true
        }
    }

    fun addEvent(event: RumEvent?) {
        if (event == null || !initialized) return
        try {
            val options = config.config.options
            var outgoing: RumEvent = event

            val beforeSend = options.beforeSend
            val candidate = outgoing
            if (beforeSend != null && !UserHook.run { beforeSend.shouldSend(candidate) }) return

            // A throwing hook drops the event (the outer catch): nothing is enqueued and nothing
            // reconciles for an event that was never accepted.
            val enrichEvent = options.enrichEvent
            if (enrichEvent != null) {
                val enriched = outgoing
                // A hook written in Java can hand back null: nothing then to send.
                val result: RumEvent? = UserHook.run { enrichEvent.enrich(enriched) }
                outgoing = result ?: return
            }

            // What a hook put in is the app's own: made JSON data now, so a batch never fails on
            // a cycle or an object JSON has no form for. Without a hook, the SDK shaped it.
            if (beforeSend != null || enrichEvent != null) {
                outgoing.attributes = LinkedHashMap(toJsonMap(outgoing.attributes))
            }

            // After both hooks, still before enqueue: the observer drives session reconciliation,
            // and a rotation takes the new session's start from this event, so it must see the
            // event as it will ship (an enrichEvent may have moved its timestamp).
            onBeforeEnqueue?.let { hook ->
                try {
                    hook(outgoing)
                } catch (error: Exception) {
                    handleError(error)
                }
            }

            // After the observer, so an event that just opened the gate is not capped.
            if ((!isFlushAllowed() || config.config.cluster.isEmpty()) &&
                events.size >= MAX_GATED_BUFFER_EVENTS
            ) {
                return
            }

            events.add(outgoing)
            if (timer == null) scheduleFlush()

            val batchSize = resolveBatchSize(options.transport.batchSize)
            if (events.size >= batchSize && outgoing.type !in eventsToSkipFlush) flush()
        } catch (error: Exception) {
            handleError(error)
        }
    }

    override fun flush() {
        try {
            if (!initialized) return
            // Nothing to send: the timer stops, and the next event arms it.
            if (events.isEmpty()) {
                cancelTimer()
                return
            }
            // Held (no presence yet): keep the buffer and the timer.
            if (!isFlushAllowed()) {
                scheduleFlush()
                return
            }
            if (config.config.cluster.isEmpty()) {
                // The cluster can arrive by updateConfig, so keep the timer; warn once.
                if (!noClusterWarned) {
                    noClusterWarned = true
                    RumDiagnostics.shared.log("[events-pool.flush] skipping flush: no cluster")
                }
                scheduleFlush()
                return
            }
            noClusterWarned = false
            val batch = currentBatch()
            events = mutableListOf()
            cancelTimer()
            transporter.send(batch)
        } catch (error: Exception) {
            handleError(error)
        }
    }

    /**
     * Sends the buffer now, before a session id is replaced. An unconfirmed session's events are
     * discarded instead: they must not survive the id change. The buffer is cleared before the
     * send, so an event added while it is handed over waits for the next batch.
     */
    fun flushSync() {
        try {
            if (events.isEmpty() || !initialized) return
            if (!isFlushAllowed()) {
                discardBuffer()
                return
            }
            if (config.config.cluster.isEmpty()) {
                RumDiagnostics.shared.log("[events-pool.flush] skipping flush: no cluster")
                return
            }
            val batch = currentBatch()
            events = mutableListOf()
            cancelTimer()
            transporter.send(batch)
        } catch (error: Exception) {
            handleError(error)
        }
    }

    private fun currentBatch() = Batch(sessionAttributes(), events.map { it.wireJson() })

    private fun cancelTimer() {
        timer?.cancel()
        timer = null
    }

    private fun scheduleFlush() {
        timer?.cancel()
        val timeoutMs = resolveBatchTimeoutMs(config.config.options.transport.batchTimeoutMs)
        timer = executor.schedule(timeoutMs) {
            timer = null
            flush()
        }
    }

    /** The envelope a batch sent now would carry. */
    fun sessionAttributes(): Map<String, Any?> {
        val config = config.config
        // Only the platform's part can fail, and only it is worth losing.
        val device = try {
            deviceAttributes()
        } catch (error: Exception) {
            handleError(error)
            emptyMap()
        }
        // Device metadata first, so a provider can never shadow session identity.
        return LinkedHashMap(device).apply {
            put("cluster", config.cluster)
            put("env", config.environment)
            put("namespace", config.namespace)
            put("releaseId", config.releaseId ?: "")
            put("session_id", session.sessionId)
            put("session_start_time", session.sessionStartTimeNs)
            put("user", config.user?.let(::userJson) ?: emptyMap<String, Any?>())
            put("service.name", config.appId)
        }
    }
}

/** The identity as the envelope carries it: only the fields set. */
private fun userJson(user: RumUser): Map<String, Any?> = LinkedHashMap<String, Any?>().apply {
    user.id?.let { put("id", it) }
    user.email?.let { put("email", it) }
    user.name?.let { put("name", it) }
    user.role?.let { put("role", it) }
    user.organization?.let { put("organization", it) }
    user.properties?.let { put("properties", it) }
}
