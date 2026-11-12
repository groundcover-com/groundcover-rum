package com.groundcover.rum.engine.crash

import java.util.UUID

/**
 * Captures JVM crashes by CHAINING onto the default uncaught-exception handler rather
 * than replacing it: RN, Expo and the host app may all have installed one, and the
 * platform's own handler is what shows the dialog and kills the process. The previous
 * handler is always invoked in a `finally`, so our recording can never swallow a crash.
 *
 * Recording is synchronous on the crashing thread — safe here as plain Java, but it must
 * stay bounded: build the record, write it, hand off.
 */
internal class GcRumCrashHandler(
    private val store: GcRumSnapshotStore,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) : Thread.UncaughtExceptionHandler {

    /**
     * The handler we displaced, and the one this class promises to always reach.
     *
     * `@Volatile` for the same reason [recording] is, in both directions. [uninstall] nulls it on
     * RN's native-modules thread during React-instance teardown while a crash on ANY other thread
     * is reading it; and at install time `previous = existing` is followed by a plain
     * `Thread.setDefaultUncaughtExceptionHandler(this)`, which is not a synchronization point, so
     * without the barrier a thread that crashes immediately after install can publish-race to null
     * and reach no handler at all.
     */
    @Volatile
    private var previous: Thread.UncaughtExceptionHandler? = null

    /** Whether we are a link in the chain — i.e. whether anything can still call
     *  us. Independent of [recording]: an uninstall that could not unhook leaves
     *  this true. */
    private var installed = false

    /**
     * Whether to WRITE records, as opposed to merely pass crashes along.
     *
     * Separate from [installed] because the two can disagree. Our store belongs
     * to one engine; once that engine is released the store must take nothing
     * more, but we may still be stuck in the chain and obliged to keep
     * delegating.
     *
     * @Volatile because [uninstall] clears it on the thread releasing the engine while
     * [record] reads it from the crashing thread — which can be any thread. Without the
     * barrier a crash could still observe `true` and write into a released engine's store.
     */
    @Volatile
    private var recording = false

    /**
     * @return whether this handler is armed and will record. False means the
     *   chain is owned by another GcRumCrashHandler we refuse to chain onto, so
     *   nothing here will ever be called — the caller must report crash capture
     *   as unavailable rather than claiming it works.
     *
     * A null existing handler is NOT treated as a failure, and that is a platform fact rather
     * than an oversight: `RuntimeInit` installs `KillApplicationHandler` as the process default
     * before any app code runs, so on Android `getDefaultUncaughtExceptionHandler()` is never
     * null here. Were it null, [previous] would stay null, [uncaughtException]'s `delegate?.`
     * would no-op and the crash would be swallowed — no dialog, no process death.
     *
     * Refusing to install in that case would be worse, not better: it would give up crash
     * recording on a platform where the condition cannot arise, and there is no safe local
     * substitute for the platform handler — rethrowing from `uncaughtException` terminates the
     * thread silently, and calling `System.exit` skips the very platform teardown the delegate
     * exists to run. Where a platform (or a test harness that clears the default) makes this
     * reachable, handling it belongs in the ENGINE, which can report `crashesUnavailable`, not
     * here.
     */
    fun install(): Boolean {
        // A re-arm on an instance that never managed to unhook (see [uninstall])
        // still means "record again" — it is the same engine asking.
        recording = true
        if (installed) return true
        val existing = Thread.getDefaultUncaughtExceptionHandler()
        // Guard against chaining onto ourselves if install() is somehow reached
        // twice through different instances — that would recurse on a crash.
        //
        // Reachable for real: a released engine whose `uninstall` could not
        // unhook (because a third SDK had chained onto us) stays the default
        // handler, and the next React instance meets it here. Refusing is right;
        // refusing SILENTLY would let the engine go on reporting `crashes = true`
        // while every crash goes to a released engine's store.
        if (existing is GcRumCrashHandler) return false
        previous = existing
        Thread.setDefaultUncaughtExceptionHandler(this)
        installed = true
        return true
    }

    /**
     * Hands the host's handler back, and stops recording either way. Not tidiness: [install]
     * refuses to chain onto another GcRumCrashHandler, so a stranded one silently blocks the
     * next install and crashes keep reaching the dead engine's store.
     *
     * Recording stops unconditionally, but unhooking is only possible while we are still the
     * default handler — once another SDK has chained onto us we stay, and must NOT drop
     * [previous], or the chain ends at us and never reaches the platform handler.
     */
    fun uninstall() {
        if (!installed) return
        recording = false
        if (Thread.getDefaultUncaughtExceptionHandler() === this) {
            Thread.setDefaultUncaughtExceptionHandler(previous)
            previous = null
            installed = false
        }
    }

    override fun uncaughtException(thread: Thread, throwable: Throwable) {
        // Captured BEFORE recording, not read after it. `@Volatile` alone fixes visibility, not
        // this: [record] writes a temp file and FSYNCS it, so the gap to the `finally` is bounded
        // by a disk sync, and a teardown landing inside it genuinely nulls the field. Read there,
        // the platform handler would never run — no dialog, no process death, an app left
        // hanging on a crash it should have died from. Delegating to the captured handler stays
        // correct even once we have been unhooked: [uninstall] restores exactly this handler as the
        // process default, so it is the one that should service this crash either way.
        val delegate = previous
        try {
            record(thread, throwable)
        } catch (_: Throwable) {
            // Never let crash RECORDING change how the app crashes.
        } finally {
            delegate?.uncaughtException(thread, throwable)
        }
    }

    private fun record(thread: Thread, throwable: Throwable) {
        // Released engine: keep delegating (the `finally` above), write nothing.
        // Such a record would carry a stale snapshot or none, so the drainer
        // discards it — but it would still occupy one of MAX_PENDING_RECORDS and
        // evict a real report waiting for a working network.
        if (!recording) return

        // A JS fatal already shipped from JavaScript with a source-mapped stack;
        // recording RN's native rethrow would double-report it with a worse one.
        if (GcRumCrashRecordMapper.isReactNativeJsFatal(throwable)) return

        // Read from memory (see the accessor's note): the process is moments
        // from death and a disk read is exactly what fails there.
        val snapshot = store.snapshotJson()
        val id = newId()
        val json = GcRumCrashRecordMapper.buildRecord(
            id = id,
            crashEpochMs = nowMs(),
            throwable = throwable,
            threadName = thread.name,
            sessionSnapshotJson = snapshot,
        )
        store.writePendingRecord(id, json)
    }
}
