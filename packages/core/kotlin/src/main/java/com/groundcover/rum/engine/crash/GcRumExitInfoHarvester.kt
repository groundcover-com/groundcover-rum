package com.groundcover.rum.engine.crash

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Recovers deaths the in-process handler cannot see. A JVM crash runs our handler before
 * the process dies; an ANR or NDK crash does not — the app is killed from outside and
 * the only trace is ApplicationExitInfo, which this reads on the next launch and turns
 * into the same exception event. The Android APIs sit behind [GcRumExitInfoReader], so
 * the selection and bookkeeping policy is testable on a bare JVM.
 */
internal class GcRumExitInfoHarvester(
    private val reader: GcRumExitInfoReader,
    private val store: GcRumPendingRecordWriter,
    private val bookkeeping: Bookkeeping,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    /**
     * The process this engine runs in, whose deaths end the sessions it recorded. Another process
     * of the app dying (a `:push` or `:media` service) ended none of them. Null reports every
     * process.
     */
    private val processName: String? = null,
) {
    /** Persisted watermark, so an exit is never reported twice. */
    interface Bookkeeping {
        fun lastProcessedExitMs(): Long
        fun setLastProcessedExitMs(value: Long)
    }

    /**
     * THE INVARIANT EVERYTHING HERE FOLLOWS FROM: an exit is reportable on exactly ONE launch —
     * the one immediately after the death it describes. That is the only launch where the snapshot
     * still on disk belongs to the session that died. One launch later the envelope has been
     * overwritten by the run in between, so pairing the crash with it would stamp a death onto a
     * session that never saw it; dropping the exit is the lesser harm, and the
     * `>= previousRunStartedAtMs` filter below is what drops it.
     *
     * Read that before reasoning about the watermark, because it settles three questions that look
     * like bugs when the filter is read in isolation:
     *
     *  - A record whose write FAILED cannot be retried on a later launch. The exit is unreportable
     *    by then whatever the cursor says, so holding the cursor back buys honest bookkeeping, not
     *    recovered data (see the cursor block at the end of this function).
     *  - The cursor's durability is not load-bearing. `setLastProcessedExitMs` uses
     *    SharedPreferences' asynchronous `apply()`, so a process death can lose it — and a lost
     *    cursor cannot resurrect an exit, because this filter excludes it anyway on every launch
     *    after the first. A replay needs the cursor to be stale AND the previous launch to have
     *    written no snapshot at all.
     *  - The watermark is still not redundant. It carries the case this filter cannot: a previous
     *    run that wrote NO snapshot leaves `previousRunStartedAtMs` old, so a whole batch of exits
     *    becomes eligible at once and the cursor is what stops the ones already handled coming back.
     *
     * @param previousRunSnapshot the envelope the previous run left behind.
     * @param previousRunStartedAtMs when that run began — in practice the snapshot file's mtime,
     *   via `GcRumSnapshotStore.previousRunWrittenAtMs()`. Exits older than this belong to runs
     *   before it, whose snapshots are gone.
     */
    fun harvest(previousRunSnapshot: String?, previousRunStartedAtMs: Long) {
        val exits = runCatching { reader.recentExits() }.getOrDefault(emptyList())
        if (exits.isEmpty()) return

        val watermark = bookkeeping.lastProcessedExitMs()
        val newest = exits.maxOf { it.timestampMs }

        // The SDK has never run, so no snapshot exists and there is no session to
        // attribute to — this history describes runs that predate us entirely.
        //
        // NOT conditioned on the watermark alone: on a fresh install `recentExits()` is
        // empty, so seeding whenever the watermark is 0 would make the first non-empty
        // harvest the one after the user's first ANR, seed to the crash it was meant to
        // report, and report nothing. The `>= previousRunStartedAtMs` bound below is what
        // makes this safe.
        if (watermark == 0L && previousRunStartedAtMs <= 0L) {
            bookkeeping.setLastProcessedExitMs(newest)
            return
        }

        val reportable = exits.filter { exit ->
            exit.timestampMs > watermark &&
                // Only the previous run's death has a snapshot that describes
                // it. An older exit that slipped past the watermark would be
                // stamped with a session it did not happen in.
                exit.timestampMs >= previousRunStartedAtMs &&
                exit.reason in REPORTABLE_REASONS &&
                // The snapshot describes this engine's process, the one the user was in: a
                // `:media` or `:push` process dying never ended that session.
                isOwnProcess(exit)
        }

        // The oldest exit whose record the store REFUSED. The write can fail on a full volume or
        // a filesystem that will not perform the rename, and a cursor that advanced regardless
        // would record work that never happened.
        var oldestUnpersistedMs: Long? = null
        for (exit in reportable) {
            val id = newId()
            if (!store.writePendingRecord(id, buildRecord(id, exit, previousRunSnapshot))) {
                oldestUnpersistedMs = minOf(oldestUnpersistedMs ?: exit.timestampMs, exit.timestampMs)
            }
        }

        // Advance past everything seen, not just what was reported — an exit we
        // deliberately skipped must not be reconsidered next launch.
        //
        // ...but never past an exit whose record did not reach disk. Held one millisecond BELOW it,
        // so the `> watermark` filter still admits it while everything older stays excluded — that
        // matters because a re-reported exit gets a fresh `crash_report_id` from [newId], so
        // nothing downstream could recognise it as a duplicate of the first one.
        //
        // HONEST ABOUT WHAT THIS DOES NOT DO: it will not recover the exit. Being admitted by the
        // watermark is not enough, and `>= previousRunStartedAtMs` will exclude it on every later
        // launch, because by then the snapshot it would have to be paired with belongs to a
        // different run. Reporting it anyway would stamp a death with a session that did not see
        // it, which is the worse failure — see the bound above. What this buys is a cursor that
        // means what it claims, so the next launch's arithmetic is not built on a write that
        // never landed.
        val ceiling = oldestUnpersistedMs?.minus(1) ?: newest
        bookkeeping.setLastProcessedExitMs(maxOf(watermark, minOf(newest, ceiling)))
    }

    private fun isOwnProcess(exit: ExitInfo): Boolean {
        val own = processName ?: return true
        val process = exit.processName ?: return true
        return process == own
    }

    private fun buildRecord(id: String, exit: ExitInfo, snapshotJson: String?): String {
        val isAnr = exit.reason == REASON_ANR
        val errorType = if (isAnr) "ANR" else "NativeCrash"
        val message = exit.description?.takeIf { it.isNotBlank() }
            ?: if (isAnr) "Application not responding" else "Native crash"

        val metadata = JSONObject()
            .put("native", true)
            .put("fatal", true)
            // Distinguishes a post-mortem reconstruction from a live capture:
            // these carry no in-process context and a coarser stack.
            .put("crash_source", "exit_info")
            .put("recovered", false)
            .put("exit_reason", exit.reason)
            .put("exit_importance", exit.importance)

        return JSONObject()
            .put("id", id)
            .put("crashEpochMs", exit.timestampMs)
            .put("errorType", errorType)
            .put("errorMessage", message)
            .put("stacktrace", parseMainThreadStack(exit.traceText))
            .put("metadata", metadata)
            .put("sessionSnapshotJson", snapshotJson ?: JSONObject.NULL)
            .put("screen", GcRumScreenSnapshot.screenFrom(snapshotJson))
            .toString()
    }

    /**
     * Best-effort parse of the "main" thread block out of an ANR trace.
     *
     * The format is a plain-text dump whose exact shape varies by OEM and
     * version, so this recognizes the common `at pkg.Class.method(File.java:42)`
     * frame and gives up quietly otherwise. An ANR with no stack still ships —
     * the timing and the fact of the ANR are most of the value.
     */
    private fun parseMainThreadStack(traceText: String?): JSONArray {
        val frames = JSONArray()
        if (traceText.isNullOrBlank()) return frames

        var inMainThread = false
        for (rawLine in traceText.lineSequence()) {
            val line = rawLine.trim()

            if (line.startsWith("\"")) {
                // A new thread block. Once past "main" there is nothing more we
                // want, so stop rather than collecting every thread in the dump.
                if (inMainThread) break
                inMainThread = line.startsWith("\"main\"")
                continue
            }
            if (!inMainThread || !line.startsWith("at ")) continue

            val frame = parseFrame(line) ?: continue
            frames.put(frame)
            if (frames.length() >= GcRumCrashRecordMapper.MAX_FRAMES) break
        }
        return frames
    }

    /** `at com.acme.Checkout.computeTotals(Checkout.kt:142)` */
    private fun parseFrame(line: String): JSONObject? {
        val body = line.removePrefix("at ").trim()
        val openParen = body.indexOf('(')
        val qualified = if (openParen >= 0) body.substring(0, openParen) else body
        val lastDot = qualified.lastIndexOf('.')
        if (lastDot <= 0) return null

        val lineNumber = if (openParen >= 0) {
            body.substringAfter(':', "").substringBefore(')').toIntOrNull() ?: 0
        } else {
            0
        }

        return JSONObject()
            .put("filename", qualified.substring(0, lastDot))
            .put("function", qualified.substring(lastDot + 1))
            .put("lineno", lineNumber)
            .put("colno", 0)
    }


    /** One system exit record, decoupled from android.app.ApplicationExitInfo. */
    class ExitInfo(
        val timestampMs: Long,
        val reason: Int,
        val importance: Int,
        val description: String?,
        /** The process that died; null when the system didn't say. */
        val processName: String? = null,
        readTrace: () -> String? = { null },
    ) {
        /**
         * The ANR trace dump, when the system attached one. Read on first use, which is only for
         * an exit that is reported: a trace is often megabytes, and the history keeps exits that
         * earlier launches already handled.
         */
        val traceText: String? by lazy(readTrace)
    }

    fun interface GcRumExitInfoReader {
        fun recentExits(): List<ExitInfo>
    }

    internal companion object {
        /** android.app.ApplicationExitInfo.REASON_ANR */
        const val REASON_ANR = 6

        /** android.app.ApplicationExitInfo.REASON_CRASH_NATIVE */
        const val REASON_CRASH_NATIVE = 5

        /**
         * REASON_CRASH (JVM) is deliberately absent: our own handler already
         * recorded that death with a real stack and cause chain, and reporting
         * both would double-count every JVM crash.
         */
        val REPORTABLE_REASONS = setOf(REASON_ANR, REASON_CRASH_NATIVE)
    }
}
