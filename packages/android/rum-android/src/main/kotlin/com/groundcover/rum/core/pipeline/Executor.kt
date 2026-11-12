package com.groundcover.rum.core.pipeline

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Work scheduled to run later, which can be called off. */
internal fun interface ScheduledWork {
    fun cancel()
}

/**
 * Where the core runs: every core object is confined to it, so none needs a lock. One thread in
 * the app; inline in tests.
 */
internal interface CoreExecutor {
    fun execute(work: () -> Unit)

    fun schedule(afterMs: Long, work: () -> Unit): ScheduledWork
}

/** The core's one thread, a daemon, so it never keeps a process alive. */
internal class ThreadExecutor(private val name: String = "gc-rum-core") : CoreExecutor {
    @Volatile
    private var thread: Thread? = null

    private val service: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, name).apply { isDaemon = true }.also { thread = it }
        }

    /** Whether the caller is on this executor's thread, where waiting on it would never return. */
    val isCurrent: Boolean get() = Thread.currentThread() === thread

    override fun execute(work: () -> Unit) {
        try {
            service.execute(work)
        } catch (error: Exception) {
            // Rejected after shutdown: the SDK was reset, and the work has nothing to run on.
        }
    }

    override fun schedule(afterMs: Long, work: () -> Unit): ScheduledWork = try {
        val future = service.schedule(work, afterMs, TimeUnit.MILLISECONDS)
        ScheduledWork { future.cancel(false) }
    } catch (error: Exception) {
        ScheduledWork {}
    }

    fun shutdown() {
        service.shutdown()
    }
}
