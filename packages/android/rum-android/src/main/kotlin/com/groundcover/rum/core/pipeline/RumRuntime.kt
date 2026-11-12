package com.groundcover.rum.core.pipeline

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverInitException
import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.UserHook
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.systemClock
import com.groundcover.rum.core.events.network.NetworkPolicy
import com.groundcover.rum.core.nativeengine.InteractiveMarks
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val START_WAIT_MS = 1_000L

/**
 * The SDK's process-wide state behind the public API: whether it has started, and the pipeline it
 * runs. Every call hops onto the core thread, in the order the app made them; none but [start]
 * waits on it.
 */
internal class RumRuntime(
    makePlatform: (GroundcoverConfig) -> PlatformServices,
    private val diagnostics: RumDiagnostics = RumDiagnostics.shared
) {
    private class Running(val pipeline: CorePipeline, val platform: PlatformServices)

    private val lock = Any()
    private var running: Running? = null
    private var makePlatform = makePlatform

    /**
     * For tests of the public API: the platform the next [start] builds, so `Groundcover` runs
     * against a fake one. Returns the factory it replaces, to put back.
     */
    fun replacePlatform(
        make: (GroundcoverConfig) -> PlatformServices
    ): (GroundcoverConfig) -> PlatformServices = synchronized(lock) {
        makePlatform.also { makePlatform = make }
    }

    /** Refreshed on the core thread after each call, so reading it never waits on that thread. */
    @Volatile
    private var cachedSessionId = ""

    /** The current session id; `""` before start or when this session isn't sampled. */
    val sessionId: String get() = cachedSessionId

    /** Whether [start] has run, and no reset since. */
    val isStarted: Boolean get() = synchronized(lock) { running != null }

    /** The SDK's clock: the platform's once started, the system's before. */
    fun now(): Long = synchronized(lock) { running?.platform?.clock }?.invoke() ?: systemClock()

    /**
     * Starts the SDK: validates [config] (a blank appId throws, whether or not the SDK runs), then
     * builds the pipeline on the core thread, ahead of every call made after this returns. It
     * returns once the session is ready, so [sessionId] reads it at once, waiting at most a second
     * for that. A second start is ignored.
     */
    fun start(config: GroundcoverConfig): Boolean {
        if (config.appId.isBlank()) {
            throw GroundcoverInitException("start requires a nonblank appId")
        }
        val started = synchronized(lock) {
            if (running != null) {
                null
            } else {
                // The process's marks: markAppInteractive records into them before start, too.
                val pipeline =
                    CorePipeline(diagnostics = diagnostics, marks = InteractiveMarks.shared)
                Running(pipeline, makePlatform(config)).also {
                    val started = it
                    it.pipeline.onEngineWork = { publish(started) }
                    running = it
                }
            }
        }
        if (started == null) {
            diagnostics.log("start: the SDK has already started; ignored")
            return false
        }
        val ready = CountDownLatch(1)
        val executor = started.platform.executor
        executor.execute {
            try {
                startOutcome = started.pipeline.start(config, started.platform)
            } catch (error: Exception) {
                handleError(error)
            } finally {
                publish(started)
                ready.countDown()
            }
        }
        // Apps tag their crash reporter with the id right after start. Bounded, so a slow disk
        // can't hold the app's launch for long.
        if (executor !is ThreadExecutor || !executor.isCurrent) {
            ready.await(START_WAIT_MS, TimeUnit.MILLISECONDS)
        }
        return true
    }

    @Volatile
    private var startOutcome: PipelineStart? = null

    @Volatile
    private var cachedNetworkPolicy: NetworkPolicy? = null

    /**
     * What network capture asks before a request goes out, readable from any thread: a value the
     * core thread publishes after every call, never a wait on it. Null before start.
     */
    val networkPolicy: NetworkPolicy? get() = cachedNetworkPolicy

    /** Whether the sampling verdict left this session out, as far as start has heard. */
    val isUnsampled: Boolean get() = startOutcome == PipelineStart.UNSAMPLED

    /**
     * Runs [work] on the pipeline, on the core thread. Dropped before start, and from inside one of
     * the app's hooks: there it would run that hook again, without end.
     */
    fun dispatch(name: String, work: (CorePipeline) -> Unit) {
        val current = admit(name) ?: return
        current.platform.executor.execute {
            try {
                work(current.pipeline)
            } catch (error: Exception) {
                handleError(error)
            }
            publish(current)
        }
    }

    /**
     * Sends what the old session buffered, then starts [id] (or a new id). [completion] runs once
     * that is done, or at once when the call is dropped.
     */
    fun setSessionId(id: String?, completion: () -> Unit) {
        val current = admit("setSessionId")
        if (current == null) {
            completion()
            return
        }
        current.platform.executor.execute {
            try {
                current.pipeline.setSessionId(id)
            } catch (error: Exception) {
                handleError(error)
            }
            publish(current)
            try {
                completion()
            } catch (error: Exception) {
                handleError(error)
            }
        }
    }

    /**
     * Stops the SDK and waits for what it was doing to finish, so a later [start] begins afresh.
     * The persisted session is kept.
     */
    fun reset() {
        val current = synchronized(lock) {
            running.also {
                running = null
                cachedSessionId = ""
                startOutcome = null
                cachedNetworkPolicy = null
            }
        } ?: return
        val executor = current.platform.executor
        val done = CountDownLatch(1)
        executor.execute {
            try {
                current.pipeline.stop()
            } finally {
                done.countDown()
            }
        }
        if (executor !is ThreadExecutor || !executor.isCurrent) done.await(5, TimeUnit.SECONDS)
        (executor as? ThreadExecutor)?.shutdown()
        cachedSessionId = ""
    }

    private fun admit(name: String): Running? {
        val current = synchronized(lock) { running }
        if (current == null) {
            diagnostics.log("$name: dropped, the SDK hasn't started")
            return null
        }
        if (UserHook.isRunning) {
            diagnostics.log("$name: called from a hook; dropped")
            return null
        }
        return current
    }

    // After a reset, a call already queued finds the pipeline stopped and must not bring back the
    // stopped session's id.
    private fun publish(current: Running) {
        val id = current.pipeline.sessionId
        val policy = current.pipeline.networkPolicy
        synchronized(lock) {
            if (running === current) {
                cachedSessionId = id
                cachedNetworkPolicy = policy
            }
        }
    }
}
