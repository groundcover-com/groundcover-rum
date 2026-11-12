package com.groundcover.rum.core.pipeline

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.RumEventName
import com.groundcover.rum.RumUser
import com.groundcover.rum.TtiMode
import com.groundcover.rum.UserUpdate
import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.common.PlatformStorage
import com.groundcover.rum.core.common.RandomIdGenerator
import com.groundcover.rum.core.common.RumClock
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.SafeStorage
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.msToNs
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.crash.CrashStore
import com.groundcover.rum.core.crash.drainCrashReports
import com.groundcover.rum.core.events.AppStartCapture
import com.groundcover.rum.core.events.Capture
import com.groundcover.rum.core.events.CustomEventCapture
import com.groundcover.rum.core.events.ErrorCapture
import com.groundcover.rum.core.events.EventEnricher
import com.groundcover.rum.core.events.EventsPool
import com.groundcover.rum.core.events.FrameSegmentCapture
import com.groundcover.rum.core.events.FrameSegmentReason
import com.groundcover.rum.core.events.HangCapture
import com.groundcover.rum.core.events.InteractionCapture
import com.groundcover.rum.core.events.LogCapture
import com.groundcover.rum.core.events.NavigationCapture
import com.groundcover.rum.core.events.NavigationTracker
import com.groundcover.rum.core.events.NetworkCapture
import com.groundcover.rum.core.events.network.NetworkPolicy
import com.groundcover.rum.core.events.network.shapeNetworkEvent
import com.groundcover.rum.core.events.shapeCustomEvent
import com.groundcover.rum.core.events.shapeErrorEvent
import com.groundcover.rum.core.events.shapeInteractionEvent
import com.groundcover.rum.core.events.shapeLogEvent
import com.groundcover.rum.core.nativeengine.AppStartTracker
import com.groundcover.rum.core.nativeengine.InteractiveMarks
import com.groundcover.rum.core.nativeengine.NativeEngine
import com.groundcover.rum.core.nativeengine.NativeEngineStatus
import com.groundcover.rum.core.nativeengine.appStartOfSignal
import com.groundcover.rum.core.nativeengine.captureOfSignal
import com.groundcover.rum.core.nativeengine.engineConfigJson
import com.groundcover.rum.core.nativeengine.frameSegmentOf
import com.groundcover.rum.core.nativeengine.shapeAppStartEvent
import com.groundcover.rum.core.nativeengine.shapeFrameSegmentEvent
import com.groundcover.rum.core.nativeengine.shapeHangEvent
import com.groundcover.rum.core.session.SessionLifecycle
import com.groundcover.rum.core.session.SessionState
import com.groundcover.rum.core.session.bootstrapSession
import com.groundcover.rum.core.session.resolveSamplingDecision
import com.groundcover.rum.core.transport.BatchSender
import com.groundcover.rum.core.transport.Transporter

/** What the host gives the pipeline: everything platform-shaped comes in here. */
internal class PlatformServices(
    val storage: PlatformStorage,
    val clock: RumClock,
    val sender: BatchSender,
    /** The session envelope's device part: `source`, `os`, `device`, `app`. */
    val deviceAttributes: () -> Map<String, Any?>,
    val executor: CoreExecutor,
    /** The native engine's crash store. */
    val crashStore: CrashStore? = null,
    /** The native engine, which the pipeline starts once its own start has decided the session. */
    val engine: NativeEngine? = null
)

/** How [CorePipeline.start] ended. */
internal enum class PipelineStart {
    /** The session is recorded: capture can be armed. */
    RECORDING,

    /** The sampling verdict left this session out: nothing is recorded, every call is a no-op. */
    UNSAMPLED
}

/** The host's foreground state, as the pipeline needs it. */
internal enum class HostLifecycle {
    /** Back in the foreground: a presence signal. */
    FOREGROUND,

    /** Transitioning (a call, the app switcher): activity is persisted. */
    INACTIVE,

    /** In the background: activity is persisted and the buffer is sent. */
    BACKGROUND
}

/** Which event types prove a user is present. */
private val ACTIVITY_EVENT_TYPES = setOf("interaction")

/** Heartbeat-style types that never drive session reconciliation. */
private val IGNORED_EVENT_TYPES = setOf("performance")

/** Types that never trigger a size flush; they ride with the next one. */
private val EVENTS_TO_SKIP_FLUSH = setOf("navigation", "interaction", "performance")

/** Attributes stamped on every event, which user-supplied log attributes may not shadow. */
private val RESERVED_ATTRIBUTE_KEYS = listOf("screen")

/**
 * The pipeline behind the public API: capture hands it typed records, and shaping, redaction, the
 * hooks, enrichment and batching happen here. Confined to the core thread; before [start], and
 * after [stop] or an unsampled start, every call is a no-op.
 */
internal class CorePipeline(
    private val ids: IdGenerator = RandomIdGenerator(),
    private val diagnostics: RumDiagnostics = RumDiagnostics.shared,
    private val marks: InteractiveMarks = InteractiveMarks()
) {
    private class Running(
        val config: ConfigManager,
        val clock: RumClock,
        val session: SessionState,
        val pool: EventsPool,
        val enricher: EventEnricher,
        val lifecycle: SessionLifecycle,
        val navigation: NavigationTracker,
        val crashStore: CrashStore?
    ) {
        /** Bumped by every config update, which can change the envelope. */
        var configVersion = 0

        /** Holds the launch metrics for the first screen, when appStart is on. */
        var appStart: AppStartTracker? = null

        /** When the app last left the foreground, on the core clock; 0 before it first has. */
        var leftAtMs = 0L

        /** The start of the session the last return to the foreground rotated to, if it did. */
        var returnSessionStartNs: Long? = null

        /** The session to file a crash in this run under, kept current whether or not it can go out yet. */
        var snapshot: String? = null
            private set
        private var snapshotKey: String? = null

        /**
         * Whether the native engine has started. Until it has, nothing of this run may reach it:
         * its start pairs the previous run's crashes with the snapshot it holds.
         */
        private var engineStarted = false

        /**
         * Rebuilds the snapshot when the session, the config or the screen changed, compared by a
         * cheap key first, since this runs after every capture; pushes it once the engine has
         * started.
         */
        fun syncSnapshot() {
            val store = crashStore ?: return
            try {
                val key = listOf(
                    session.sessionId,
                    session.sessionStartTimeNs,
                    configVersion,
                    navigation.screenName,
                    navigation.screenKey
                ).joinToString("\u0000")
                if (key == snapshotKey) return
                val envelope = LinkedHashMap(pool.sessionAttributes())
                envelope["screen"] = mapOf(
                    "name" to navigation.screenName,
                    "key" to navigation.screenKey
                )
                val json = encodeJson(envelope)
                snapshotKey = key
                snapshot = json
                if (engineStarted) store.updateSessionSnapshot(json)
            } catch (error: Exception) {
                handleError(error)
            }
        }

        /** The engine has started: the latest snapshot goes out, and every change after it. */
        fun markEngineStarted() {
            if (engineStarted) return
            engineStarted = true
            val json = snapshot ?: return
            try {
                crashStore?.updateSessionSnapshot(json)
            } catch (error: Exception) {
                handleError(error)
            }
        }

        /**
         * Not before the engine started: what it holds then is the previous run's envelope, which
         * its harvest still has to read.
         */
        fun clearSnapshot() {
            if (!engineStarted) return
            try {
                crashStore?.updateSessionSnapshot(null)
            } catch (error: Exception) {
                handleError(error)
            }
        }
    }

    private var running: Running? = null
    private var config: ConfigManager? = null
    private var platform: PlatformServices? = null
    private var outcome: PipelineStart? = null
    private var stopped = false

    /**
     * What waits on the crash drain in flight: one pass at a time, since a second would read the
     * same un-acked records and send them twice.
     */
    private var drainWaiters: MutableList<() -> Unit>? = null

    /**
     * Runs on the core thread after the pipeline acted on the engine, which no call of the app's
     * went through: an event can rotate the session, and the runtime publishes the id again.
     */
    var onEngineWork: (() -> Unit)? = null

    /** Builds the session and starts batching, once: a second call answers as the first did. */
    fun start(input: GroundcoverConfig, platform: PlatformServices): PipelineStart {
        outcome?.let { return it }
        return try {
            diagnostics.configure(debug = input.options.debug ?: false)
            val config = ConfigManager(input).also { config = it }
            this.platform = platform
            val storage = SafeStorage(platform.storage)
            val session = SessionState(storage) { config.config.options.sessionMaxDurationMs }
            bootstrapSession(session, ids, platform.clock, input.sessionId)
            if (!resolveSamplingDecision(storage, config.config.options.sessionSampleRate)) {
                diagnostics.log("[pipeline] session is not sampled")
                outcome = PipelineStart.UNSAMPLED
                startEngine(recording = false)
                return PipelineStart.UNSAMPLED
            }
            val pool = EventsPool(
                config = config,
                session = session,
                transporter = Transporter(config, platform.sender, platform.executor, diagnostics),
                deviceAttributes = platform.deviceAttributes,
                eventsToSkipFlush = EVENTS_TO_SKIP_FLUSH,
                executor = platform.executor
            )
            // Every event carries the screen it happened on, empty before the first navigation.
            val navigation = NavigationTracker()
            val enricher = EventEnricher(
                idGenerator = ids,
                clock = platform.clock,
                platformAttributes = {
                    mapOf(
                        "screen" to mapOf(
                            "name" to navigation.screenName,
                            "key" to navigation.screenKey
                        )
                    )
                },
                reservedAttributeKeys = RESERVED_ATTRIBUTE_KEYS
            )
            val lifecycle = SessionLifecycle(
                session = session,
                pool = pool,
                idGenerator = ids,
                clock = platform.clock,
                activityEventTypes = ACTIVITY_EVENT_TYPES,
                ignoredEventTypes = IGNORED_EVENT_TYPES
            ).apply { install() }
            pool.initialize()
            val running = Running(
                config,
                platform.clock,
                session,
                pool,
                enricher,
                lifecycle,
                navigation,
                platform.crashStore
            )
            this.running = running
            if (config.config.options.isEnabled(RumEventName.APP_START)) {
                running.appStart = AppStartTracker(
                    submit = ::submit,
                    manualTti = config.config.options.native?.tti == TtiMode.MANUAL,
                    marks = marks,
                    executor = platform.executor,
                    diagnostics = diagnostics
                )
            }
            running.syncSnapshot()
            outcome = PipelineStart.RECORDING
            startEngine(recording = true)
            PipelineStart.RECORDING
        } catch (error: Exception) {
            // Nothing runs: an app is better unmonitored than crashing over its monitoring.
            handleError(error)
            running = null
            PipelineStart.UNSAMPLED.also { outcome = it }
        }
    }

    /**
     * Starts the native engine, unsampled sessions included: crash capture governs the delivery of
     * an earlier session's crash too (see [engineConfigJson]). Not waited on: start doesn't wait
     * for native work.
     */
    private fun startEngine(recording: Boolean) {
        val engine = platform?.engine ?: return
        val executor = platform?.executor ?: return
        val config = config ?: return
        val json = engineConfigJson(config.config.options, recording, running?.snapshot)
        // Before the start: the engine emits from inside it.
        engine.onSignal = { kind, payload -> executor.execute { engineSignal(kind, payload) } }
        engine.start(json) { status -> executor.execute { engineStarted(status, recording) } }
    }

    /** A signal from the engine, on the core thread. */
    fun engineSignal(kind: String, payload: Map<String, Any?>) {
        val running = running ?: return
        if (kind == "app_start") {
            val start = appStartOfSignal(payload) ?: return
            running.appStart?.onAppStart(start)
        } else if (kind == "frame_segment") {
            // Closed by the engine itself (a trip to the background, the cap): drawn on the screen
            // current now.
            val segment = frameSegmentOf(
                payload,
                running.navigation.screenName,
                running.navigation.screenKey
            ) ?: return
            submit(segment)
            // Closed as the app leaves, a moment after the background flush went: sent on its
            // own, or the process is often frozen or killed before the batch timer fires.
            if (segment.reason == FrameSegmentReason.BACKGROUND) running.pool.flush()
        } else {
            submit(captureOfSignal(kind, payload) ?: return)
        }
        onEngineWork?.invoke()
    }

    /** The app marked itself interactive ([InteractiveMarks.markManual]). */
    fun interactiveMarked() {
        running?.appStart?.reportTtiIfReady()
    }

    private fun engineStarted(status: NativeEngineStatus, recording: Boolean) {
        // Stopped while the engine started: nothing to act for any more.
        if (stopped) return
        // Started, so the previous runs' crashes are harvested: the snapshot may follow the session
        // now, and those crashes are delivered, sampled or not, each under its own session.
        nativeStarted()
        // The app asked for crashes and the engine couldn't oblige: usually another reporter owns
        // the process's crash handling, which the engine refuses to take over. Said out loud, or
        // the app reports no native crashes with nothing to explain it. A session not sampled
        // reports nothing anyway, so it says nothing.
        val unavailable = status.crashesUnavailable ?: return
        if (recording && config?.config?.options?.isEnabled(RumEventName.CRASHES) == true) {
            diagnostics.warn(
                "[groundcover] native crash capture is unavailable: $unavailable. " +
                    "Native crashes will not be reported for this session."
            )
        }
    }

    fun submit(capture: Capture) {
        val running = running ?: return
        try {
            val gate = when (capture) {
                // The app's own call, never gated.
                is CustomEventCapture -> null

                is LogCapture -> RumEventName.LOGS

                is ErrorCapture -> RumEventName.EXCEPTIONS

                is NetworkCapture -> RumEventName.NETWORK

                is InteractionCapture -> RumEventName.INTERACTION

                is NavigationCapture -> RumEventName.NAVIGATION

                is HangCapture -> RumEventName.HANGS

                is AppStartCapture -> RumEventName.APP_START

                is FrameSegmentCapture -> RumEventName.VITALS
            }
            val enabled = gate == null || running.config.config.options.isEnabled(gate)
            // A navigation moves the current screen even with navigation events off: every other
            // event is stamped with the screen it happened on, and only the navigation events are
            // left out.
            if (capture is NavigationCapture) {
                val leftName = running.navigation.screenName
                val leftKey = running.navigation.screenKey
                val input = running.navigation.handle(
                    capture,
                    running.clock(),
                    running.config.privacy
                )
                if (input != null && enabled) running.pool.addEvent(running.enricher.enrich(input))
                if (running.navigation.screenName != leftName ||
                    running.navigation.screenKey != leftKey
                ) {
                    screenChanged(running, leftName, leftKey)
                }
                running.syncSnapshot()
                return
            }
            if (!enabled) return
            if (capture is FrameSegmentCapture) return addFrameSegment(running, capture)
            val privacy = running.config.privacy
            val input = when (capture) {
                is CustomEventCapture -> shapeCustomEvent(capture)

                is LogCapture -> shapeLogEvent(capture, privacy, RESERVED_ATTRIBUTE_KEYS)

                is ErrorCapture -> shapeErrorEvent(capture, privacy)

                is NetworkCapture -> shapeNetworkEvent(
                    capture,
                    privacy,
                    running.config.config.options.tracing
                )

                is InteractionCapture -> shapeInteractionEvent(capture, privacy)

                is HangCapture -> shapeHangEvent(capture)

                is AppStartCapture -> shapeAppStartEvent(capture, ids.generateId())

                is NavigationCapture, is FrameSegmentCapture -> return
            }
            running.pool.addEvent(running.enricher.enrich(input))
            // A recovered hang often comes just before a force-quit or an OS kill, which the batch
            // timer would lose it to.
            if (capture is HangCapture) running.pool.flush()
        } catch (error: Exception) {
            handleError(error)
        }
        // An event can rotate the session.
        running.syncSnapshot()
    }

    /** RN's vitals listener: a closed segment, as one `frames_delay_total`. */
    private fun addFrameSegment(running: Running, segment: FrameSegmentCapture) {
        // "Nothing rendered" is no vitals signal: an empty segment would report no lost time, as
        // though the screen had been smooth.
        if (segment.total <= 0) return
        // The idle gate, as RN's: frames drawn while nobody was there don't describe a session
        // anyone used.
        if (running.session.isSessionInactive(running.clock())) return
        // Started before this session did: part of it measured the session that rotated away, and
        // the pool stamps the session at send time, so it would ship under the new one. A segment
        // drawn wholly since the rotation is this session's own, and so is one that started after
        // the app last left when the return rotated the session: the engine restarts its segment
        // on the return, a moment before the rotation lands here.
        if (msToNs(segment.startMs) < running.session.sessionStartTimeNs &&
            !startedSinceRotatingReturn(running, segment)
        ) {
            return
        }
        // An enricher of its own: on a screen change the segment belongs to the screen being left,
        // and the ambient stamp already names the new one.
        val enricher = EventEnricher(
            idGenerator = ids,
            clock = running.clock,
            platformAttributes = {
                mapOf("screen" to mapOf("name" to segment.screenName, "key" to segment.screenKey))
            }
        )
        running.pool.addEvent(
            enricher.enrich(shapeFrameSegmentEvent(segment, ids.generateId()))
        )
    }

    /**
     * Whether [segment] started after the app last left, and the current session is the one the
     * return that followed rotated to.
     */
    private fun startedSinceRotatingReturn(running: Running, segment: FrameSegmentCapture) =
        running.leftAtMs > 0 &&
            segment.startMs >= running.leftAtMs &&
            running.returnSessionStartNs == running.session.sessionStartTimeNs

    /**
     * The stamped screen changed, to a named one, and is current: the first is the automatic TTI
     * mark, and releases the launch metrics held for it under itself; every later one closes the
     * frame segment drawn on the screen left, [leftName] and [leftKey].
     */
    private fun screenChanged(running: Running, leftName: String, leftKey: String) {
        if (running.navigation.screenName.isEmpty()) return
        if (marks.markAuto(running.clock())) running.appStart?.reportTtiIfReady()
        running.appStart?.screenKnown()
        // The first screen closes nothing: the launch is its own, and the engine has had no time
        // to count a frame.
        if (leftName.isEmpty() || !running.config.config.options.isEnabled(RumEventName.VITALS)) {
            return
        }
        val engine = platform?.engine ?: return
        val executor = platform?.executor ?: return
        // Not waited on: a screen change never waits for the engine. Filed under the screen left,
        // passed along rather than read back, since the stamp has moved on by the time it lands.
        engine.flushFrameSegment { payload ->
            if (payload != null) {
                executor.execute { frameSegmentClosed(payload, leftName, leftKey) }
            }
        }
    }

    private fun frameSegmentClosed(payload: Map<String, Any?>, name: String, key: String) {
        if (running == null) return
        submit(frameSegmentOf(payload, name, key) ?: return)
        onEngineWork?.invoke()
    }

    /**
     * What network capture asks before a request goes out, as the configuration is now; null
     * before start or when this session isn't recorded.
     */
    val networkPolicy: NetworkPolicy?
        get() = try {
            running?.let { NetworkPolicy(it.config.config) }
        } catch (error: Exception) {
            handleError(error)
            null
        }

    /** Whether a request to [url] is captured ([NetworkPolicy.captures]). */
    fun capturesUrl(url: String): Boolean = networkPolicy?.captures(url) ?: false

    /** The trace headers a request to [url] carries, fresh ids each call. */
    fun traceHeadersFor(url: String): Map<String, String> =
        networkPolicy?.traceHeadersFor(url, ids) ?: emptyMap()

    /** A genuine user signal (a tap): opens the send gate. */
    fun presence() {
        val running = running ?: return
        try {
            running.lifecycle.reconcile(running.clock(), userPresent = true)
        } catch (error: Exception) {
            handleError(error)
        }
        running.syncSnapshot()
    }

    fun lifecycle(state: HostLifecycle) {
        val running = running ?: return
        try {
            when (state) {
                HostLifecycle.FOREGROUND -> {
                    val sessionStartNs = running.session.sessionStartTimeNs
                    running.lifecycle.reconcile(running.clock(), true)
                    if (running.session.sessionStartTimeNs != sessionStartNs) {
                        running.returnSessionStartNs = running.session.sessionStartTimeNs
                    }
                }

                HostLifecycle.INACTIVE -> running.session.persistLastActivity()

                HostLifecycle.BACKGROUND -> {
                    running.leftAtMs = running.clock()
                    running.session.persistLastActivity()
                    running.pool.flush()
                }
            }
        } catch (error: Exception) {
            handleError(error)
        }
        running.syncSnapshot()
    }

    /** The current session id; `""` before start or when unsampled. */
    val sessionId: String get() = running?.session?.sessionId ?: ""

    /** Sends what the old session buffered, then starts [id] (or a new id). */
    fun setSessionId(id: String?) {
        val running = running ?: return
        try {
            running.pool.flushSync()
            running.session.sessionId = if (id.isNullOrEmpty()) ids.generateId() else id
            running.session.setSessionStartTime(msToNs(running.clock()))
        } catch (error: Exception) {
            handleError(error)
        }
        running.syncSnapshot()
    }

    /** Merges [user] into the identity, as an update that sets it does. */
    fun identifyUser(user: RumUser) {
        updateConfig(GroundcoverConfigUpdate(user = UserUpdate.Set(user)))
    }

    fun updateConfig(update: GroundcoverConfigUpdate) {
        try {
            config?.update(update)
            // The debug flag reaches the log, not only the stored config.
            update.options?.debug?.let { diagnostics.configure(debug = it) }
        } catch (error: Exception) {
            handleError(error)
        }
        // The envelope may have changed (the user, the cluster, the env).
        running?.let {
            it.configVersion++
            it.syncSnapshot()
        }
    }

    /** Sends the buffer now. */
    fun flush() {
        running?.pool?.flush()
    }

    /**
     * Stops batching and the native engine. Buffered events are dropped; the persisted session is
     * kept.
     */
    fun stop() {
        stopped = true
        running?.let {
            it.appStart?.dispose()
            it.lifecycle.uninstall()
            it.pool.destroy()
            // A session that stopped is no longer one to file a crash under.
            it.clearSnapshot()
            running = null
        }
        if (outcome != null) {
            platform?.engine?.onSignal = null
            platform?.engine?.stop()
        }
    }

    /**
     * The session envelope plus the current screen, as JSON: what the native engine files a crash
     * in this run under. The engine starts with it in its config; null when this session is not
     * recorded.
     */
    val sessionSnapshot: String? get() = running?.snapshot

    /**
     * The native engine has started, so it has harvested the crashes earlier runs left. Until now
     * nothing of this run reached it: the harvest pairs those crashes with the snapshot it holds.
     * From now on the snapshot follows the session, and the harvested crashes are delivered, each
     * under the session it crashed in, whether or not this session is sampled. [completion] runs
     * once that pass is over; nothing happens once stopped.
     */
    fun nativeStarted(completion: () -> Unit = {}) {
        // Stopped first: the drain would send under a config the app gave up on.
        if (stopped) return completion()
        running?.markEngineStarted()
        val config = config
        val platform = platform
        val store = platform?.crashStore
        if (config == null || store == null) return completion()
        drainWaiters?.let {
            it.add(completion)
            return
        }
        drainWaiters = mutableListOf(completion)
        drainCrashReports(
            store = store,
            config = config,
            ids = ids,
            clock = platform.clock,
            transporter = Transporter(config, platform.sender, platform.executor, diagnostics)
        ) {
            val waiters = drainWaiters.orEmpty()
            drainWaiters = null
            for (waiter in waiters) waiter()
        }
    }
}
