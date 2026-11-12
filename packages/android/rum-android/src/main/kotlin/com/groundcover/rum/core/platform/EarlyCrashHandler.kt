package com.groundcover.rum.core.platform

import com.groundcover.rum.engine.crash.GcRumCrashHandler
import com.groundcover.rum.engine.crash.GcRumCrashRecordMapper
import com.groundcover.rum.engine.crash.GcRumPendingRecordWriter
import java.util.UUID

/**
 * Records JVM crashes from the moment the pipeline starts the engine until the engine's own
 * [GcRumCrashHandler] is installed. That install runs on the engine's thread after the engine is
 * built, which reads its store from disk, so it lands after `Groundcover.start` has returned, and
 * a crash in between (another initializer in `Application.onCreate`, the launch Activity's
 * `onCreate`) would otherwise reach no one: exit records don't cover JVM crashes, which the
 * engine's handler owns. A launch that crashes every time is exactly the one that must be seen.
 *
 * Chains like the engine's handler: the handler it displaced always runs, in a `finally`. The
 * record is the engine's own format, filed under [snapshotJson], this run's envelope, and written
 * through a store built at crash time, so nothing here touches disk before a crash.
 *
 * Hands over once the engine has decided about crash capture ([handOver]): from then on it records
 * nothing and only passes crashes on, stepping out of the chain if it is still the default. Before
 * that, a [GcRumCrashHandler] on top of it means the engine installed and recorded the crash first.
 */
internal class EarlyCrashHandler(
    private val snapshotJson: String?,
    private val makeWriter: () -> GcRumPendingRecordWriter,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() }
) : Thread.UncaughtExceptionHandler {
    /** The handler this one displaced, and always reaches. */
    @Volatile
    private var previous: Thread.UncaughtExceptionHandler? = null

    @Volatile
    private var handedOver = false

    fun install() {
        previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler(this)
    }

    /** The engine owns crash capture now, whatever it decided: stop recording, keep passing on. */
    fun handOver() {
        handedOver = true
        if (Thread.getDefaultUncaughtExceptionHandler() === this) {
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
    }

    override fun uncaughtException(thread: Thread, throwable: Throwable) {
        // Read before recording: the platform handler must run even if a hand-over lands meanwhile.
        val delegate = previous
        try {
            if (!handedOver && Thread.getDefaultUncaughtExceptionHandler() !is GcRumCrashHandler) {
                record(thread, throwable)
            }
        } catch (_: Throwable) {
            // Never let crash recording change how the app crashes.
        } finally {
            delegate?.uncaughtException(thread, throwable)
        }
    }

    private fun record(thread: Thread, throwable: Throwable) {
        // An unsampled session clears its envelope, and the drain drops a record without one.
        val snapshot = snapshotJson ?: return
        val id = newId()
        val json = GcRumCrashRecordMapper.buildRecord(
            id = id,
            crashEpochMs = nowMs(),
            throwable = throwable,
            threadName = thread.name,
            sessionSnapshotJson = snapshot
        )
        makeWriter().writePendingRecord(id, json)
    }
}
