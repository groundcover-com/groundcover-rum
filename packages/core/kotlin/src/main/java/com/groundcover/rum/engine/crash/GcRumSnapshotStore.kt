package com.groundcover.rum.engine.crash

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * On-disk home for the session snapshot and pending crash records. Nothing can be
 * composed at crash time, so the snapshot must already be on disk; writes are atomic
 * (temp + rename) so a crash mid-write leaves the previous one intact, and debounced
 * so a tab-switching user does not fsync on every navigation.
 *
 * Takes a files dir rather than a Context, which keeps the store inside the bare-JVM
 * unit suite. Mirrors the iOS store, which takes a URL.
 */
internal class GcRumSnapshotStore(
    filesDir: File,
    private val nowMs: () -> Long = System::currentTimeMillis,
    /**
     * How a temp file is committed to its final name. Injectable ONLY so a test can
     * simulate a filesystem whose `renameTo` cannot replace an existing file — the
     * OEM condition the fallback in [writeAtomically] exists for. Production uses the
     * real [File.renameTo].
     */
    private val renameFile: (File, File) -> Boolean = { source, dest -> source.renameTo(dest) },
    /**
     * How a file is removed. Injectable for the same reason as [renameFile]: `File.delete()`
     * reports failure by RETURNING false, and a filesystem that refuses a delete is the
     * condition [update]`(null)`'s truncate fallback exists for. Production uses the real
     * [File.delete].
     */
    private val deleteFile: (File) -> Boolean = { file -> file.delete() },
    /**
     * A base directory older SDK versions stored under, to be deleted. The store lives
     * in `noBackupFilesDir` because the envelope carries whatever `identifyUser` was
     * given and `filesDir` is swept into Auto Backup, which a library cannot opt out of
     * via the manifest. Deleting the old copy keeps what it holds out of backups too.
     */
    legacyBaseDir: File? = null,
    /**
     * Fired between [update]'s two in-memory assignments, ONLY so a test can drive
     * another thread into that window. There is no other seam there — the two
     * assignments are adjacent, so nothing else a test can hook orders a concurrent
     * clear against them, and the resurrect this guards is invisible without it.
     * Production passes nothing and pays a null check per update.
     */
    private val onSnapshotAssigned: (() -> Unit)? = null,
) : GcRumPendingRecordWriter {

    private val root = File(filesDir, DIR_NAME)
    private val snapshotFile = File(root, SNAPSHOT_FILE)
    private val pendingDir = File(root, PENDING_DIR)

    /** Latest snapshot, in memory. The crash handler reads THIS, never the disk — at
     *  crash time a disk read is exactly what fails. */
    @Volatile
    private var snapshot: String? = null

    @Volatile
    private var pendingWrite: String? = null

    @Volatile
    private var lastWriteMs: Long = 0

    /**
     * Drains a parked write once the debounce window closes. TRAILING rather than
     * rate-limiting, because a native crash or an OS kill affords no flush call and
     * whatever is on disk then is what the crash is attributed to. A single daemon
     * thread, so it can never keep the process alive.
     */
    private val flushScheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, FLUSH_THREAD_NAME).apply { isDaemon = true }
        }

    private var scheduledFlush: ScheduledFuture<*>? = null

    init {
        // First and unconditionally, since the old location is the exposure. Nothing
        // is migrated: those records were already delivered or lost,
        // and the envelope names a session that has long ended.
        //
        // Synchronous because the tree is capped at ~11 small files, and a background
        // delete would race the first `update`. No retry either — this runs on every
        // construction, so a failed delete is reattempted next launch.
        legacyBaseDir?.let { base ->
            runCatching { File(base, DIR_NAME).deleteRecursively() }
        }

        runCatching {
            root.mkdirs()
            pendingDir.mkdirs()
            snapshot = newestSnapshotFile()?.let { readSnapshotFile(it) }
            // After the snapshot read, so a reclaim that throws cannot cost this launch the
            // envelope a harvested crash belongs to. Once per construction is enough: the
            // sweep is launch-time housekeeping, and putting it on `writePendingRecord` would
            // add a directory scan at crash time, which is the worst moment to spend one.
            reclaimStaleTemps()
        }
    }

    /**
     * Deletes `.tmp` files no live write can still own.
     *
     * [enforceRecordCap] counts only `.json`, which is what the reader reads, so it never
     * removes a temp: a `writePendingRecord` interrupted by the very crash it is recording leaves
     * `<id>.json.tmp` behind, and one whose `.json` never landed would otherwise stay forever,
     * one per interrupted crash-time write.
     *
     * An abandoned temp and one belonging to an in-flight write are told apart by AGE:
     * a write completes in milliseconds, so anything past [STALE_TEMP_MS] is abandoned.
     *
     * `.tmp` ONLY, never `.bak`. A `.bak` is the snapshot's durable fallback copy rather than a
     * scrap — [newestSnapshotFile] reads it when a rename could not replace the snapshot — so
     * sweeping it by age would delete live data. Pending records never get one: [writeAtomically]
     * refuses the fallback for them.
     *
     * Both directories: the snapshot writes through the same [writeAtomically], so a stray can
     * land beside `snapshot.json` as well as in `pending/`.
     *
     * Note this compares [nowMs] against `File.lastModified()`, so an injected clock has to
     * stay in the epoch-millisecond domain — it is not a free-running counter here.
     */
    private fun reclaimStaleTemps() {
        val cutoff = nowMs() - STALE_TEMP_MS
        listOf(root, pendingDir).forEach { dir ->
            dir.listFiles()
                ?.filter { it.isFile && it.name.endsWith(TEMP_SUFFIX) && it.lastModified() < cutoff }
                ?.forEach { runCatching { it.delete() } }
        }
    }

    /**
     * A snapshot file's contents, or null when there is no envelope in it.
     *
     * BLANK IS ABSENT, and that is the whole point of this function existing. `readText()` on
     * an empty file returns `""` — non-null — so without this [snapshotJson] would hand the
     * crash drain an empty string, and the drain treats any non-null envelope as one it can
     * attribute a crash to. A cleared session would come back as a parse failure at best.
     * [eraseSnapshotFile] truncates whatever it cannot delete, so this is the read half of
     * that guarantee rather than mere defensiveness.
     */
    private fun readSnapshotFile(file: File): String? =
        // A JSON OBJECT, not merely non-blank: the record path already demands that of what it
        // feeds the drain ([isJsonObject]), and the snapshot feeds the same consumer. A blank
        // file fails this too, so it subsumes the emptiness check rather than adding to it.
        runCatching { file.readText().takeIf { isJsonObject(it) } }.getOrNull()

    /**
     * The snapshot file to trust on this launch: whichever of [snapshotFile] and its `.bak`
     * exists and is newer. In the common case only [snapshotFile] exists (a successful write
     * clears the `.bak`); the `.bak` exists only after a rename-can't-replace fallback, where
     * it holds content at least as new as [snapshotFile]. Prefer it on a tie for that reason.
     */
    private fun newestSnapshotFile(): File? {
        val bak = File(snapshotFile.parentFile, "${snapshotFile.name}$BAK_SUFFIX")
        val primary = snapshotFile.takeIf { it.isFile }
        val backup = bak.takeIf { it.isFile }
        return when {
            primary == null -> backup
            backup == null -> primary
            backup.lastModified() >= primary.lastModified() -> backup
            else -> primary
        }
    }

    /**
     * The snapshot in memory. Before the engine's first [update] it is what the
     * PREVIOUS run left on disk (the session a harvested crash belongs to); after it,
     * the live session. Always served from memory — see [snapshot].
     */
    fun snapshotJson(): String? = snapshot

    /** Epoch ms of the previous run's last snapshot write, or 0. Bounds
     *  ApplicationExitInfo harvesting to that run. */
    fun previousRunWrittenAtMs(): Long =
        runCatching { newestSnapshotFile()?.lastModified() ?: 0L }.getOrDefault(0L)

    fun update(json: String?) {
        if (json == null) {
            // A queued write must not resurrect a snapshot that was deliberately
            // dropped. FIRST, and outside `writeLock`: this takes the [flushScheduler]
            // lock, and the two are only ever nested in this order — see [writeLock].
            cancelScheduledFlush()
            // Under `writeLock`, because cancelling is not enough on its own:
            // `cancel(false)` cannot stop a flush that has ALREADY started, and an
            // unsynchronized clear could land inside [flushPendingWrite]'s
            // take-and-write. The flush would then finish with the envelope it had already
            // captured and put the cleared snapshot back on disk for the next launch to
            // read — a crash attributed to the session and user that JavaScript had just
            // said were gone.
            synchronized(writeLock) {
                // Under the lock with `pendingWrite`, not before the branch: the two have
                // to move as ONE step against a concurrent non-null update — see the
                // matching block below.
                snapshot = null
                pendingWrite = null
                // Both copies have to go: [newestSnapshotFile] PREFERS the `.bak` once the
                // primary is gone, so deleting only the primary leaves the one file the
                // next launch would read.
                //
                // `delete()` reports failure by RETURNING false rather than throwing, and a
                // filesystem that refuses leaves a READABLE file — which the next launch's
                // init reads straight back into [snapshot], resurrecting a session the SDK
                // had deliberately cleared and attributing a later crash to it. So a refused
                // delete is followed by a truncate, and [readSnapshotFile] treats blank
                // content as absent. Truncating is not merely a tidier failure: it is what
                // makes the clear hold on the read path.
                eraseSnapshotFile(snapshotFile)
                eraseSnapshotFile(File(snapshotFile.parentFile, "${snapshotFile.name}$BAK_SUFFIX"))
            }
            return
        }

        // Both assignments under `writeLock`, as one step. Unsynchronized, they straddle a
        // concurrent `update(null)`: this thread sets `snapshot`, the clear runs whole —
        // nulling both fields and deleting the files — and then this thread parks its
        // envelope, which the flush writes back. Memory says cleared, disk says otherwise,
        // and the next launch reads the disk: the same resurrect the clear path is locked
        // against. Only the WRITERS lock;
        // [snapshotJson] still reads `snapshot` unlocked off its @Volatile, because the
        // crash handler cannot afford to block on a lock another thread holds.
        val delayMs: Long
        synchronized(writeLock) {
            snapshot = json
            onSnapshotAssigned?.invoke()
            pendingWrite = json
            val now = nowMs()
            if (now - lastWriteMs >= WRITE_DEBOUNCE_MS) {
                // Reentrant monitor, so take-and-write stays indivisible rather than
                // deadlocking on the lock this frame already holds.
                flushPendingWrite()
                return
            }
            delayMs = (WRITE_DEBOUNCE_MS - (now - lastWriteMs)).coerceAtLeast(0)
        }
        // Outside, deliberately: this takes the [flushScheduler] lock, and nesting that
        // under `writeLock` inverts the one order the two are ever taken in.
        scheduleTrailingFlush(delayMs = delayMs)
    }

    /**
     * Removes a snapshot file so that no later read can recover it — delete if the
     * filesystem allows it, otherwise blank it.
     *
     * Truncation is the fallback rather than the primary because a deleted file also stops
     * [newestSnapshotFile] considering it at all, while a blanked one still has to be
     * recognised as empty on every subsequent launch.
     */
    private fun eraseSnapshotFile(file: File) {
        runCatching {
            if (!file.exists()) return
            if (deleteFile(file)) return
            // Refused. Blank it so the content cannot come back, and leave the empty file:
            // [readSnapshotFile] reads it as no snapshot.
            file.writeText("")
        }
    }

    /**
     * Arms the trailing-edge drain. One pending task suffices — it writes whatever
     * [pendingWrite] holds when it fires, so updates in the same window coalesce.
     */
    private fun scheduleTrailingFlush(delayMs: Long) {
        synchronized(flushScheduler) {
            if (scheduledFlush?.isDone == false) return
            scheduledFlush = runCatching {
                flushScheduler.schedule({ flushPendingWrite() }, delayMs, TimeUnit.MILLISECONDS)
            }.getOrNull()
        }
    }

    private fun cancelScheduledFlush() {
        synchronized(flushScheduler) {
            scheduledFlush?.cancel(false)
            scheduledFlush = null
        }
    }

    /**
     * Releases the store, draining anything parked on the way out. RN rebuilds the React
     * instance on every reload, and without this each one would strand a [FLUSH_THREAD_NAME]
     * thread.
     * Flush BEFORE shutdown, on this thread, so the scheduler cannot lose it; then wait for the
     * scheduler to finish, so "close() returned" means "nothing is still writing". Idempotent.
     *
     * NOT bounded overall, deliberately. [CLOSE_WAIT_MS] bounds only the wait for the scheduler
     * THREAD; the inline [flushPendingWrite] above runs first and can block for as long as
     * `writeLock`, the fsync and the rename take, before the deadline is even armed. `release()`
     * pays this twice — it flushes once itself, then again in here.
     *
     * Teardown can be bounded or the envelope can be guaranteed to land, not both: a final flush
     * behind a bounded future would return from `close()` while a write may still be in flight.
     * For crash attribution the envelope wins — a lost one means the next crash is reported
     * against the session that came before it. A stalled fsync during teardown is a slow close; a
     * dropped envelope is wrong data. RN does not promise which thread `invalidate()` arrives on,
     * so a pathological disk can stall teardown wherever the host is running it.
     */
    fun close() {
        cancelScheduledFlush()
        flushPendingWrite()
        // Set AFTER the final flush, so close() still drains what was parked, and before the
        // scheduler goes down, so nothing can slip between the two.
        closed = true
        runCatching {
            flushScheduler.shutdown()
            if (!flushScheduler.awaitTermination(CLOSE_WAIT_MS, TimeUnit.MILLISECONDS)) {
                flushScheduler.shutdownNow()
            }
        }
    }

    /**
     * Whether [close] has run. Shutting the scheduler down is not enough on its own: [update]
     * writes on the CALLING thread once the debounce window has elapsed, so it bypasses the
     * scheduler entirely. `updateSessionSnapshot` is posted to the engine's HandlerThread and
     * `quitSafely()` still runs already-queued messages, so a late `update` could land on disk
     * after the final flush — attributing the next crash to a session that was already over.
     *
     * The engine drains its queue before closing so legitimate updates still land; this is the
     * backstop that makes "closed" mean it.
     */
    @Volatile
    private var closed = false

    /**
     * Forces the debounced write out ON THE CALLING THREAD, blocking on an fsync. Main
     * thread callers want [flushPendingWriteAsync] instead.
     *
     * Serialized because the flush thread and a teardown caller can both be here: take
     * and write must be indivisible, or each holds a different envelope and nothing
     * orders the writes, so the OLDER one can land last and silently attribute the next
     * crash to a stale screen and user.
     */
    fun flushPendingWrite() {
        synchronized(writeLock) {
            // Nothing reaches disk after close() — see [closed]. Inside the lock so it cannot
            // race a close() that is itself mid-flush.
            if (closed) return
            val json = pendingWrite ?: return
            // Taken and cleared BEFORE the write, not after, so clearing can never discard
            // an envelope newer than this one. Every writer of `pendingWrite` takes this
            // lock, `update()` included, so none can park one mid-write anyway.
            pendingWrite = null
            lastWriteMs = nowMs()
            if (!writeAtomically(snapshotFile, json)) {
                // Nothing committed. Re-park so a later flush retries: clearing
                // unconditionally would discard the envelope outright, so nothing would retry
                // and the next crash would be attributed to whatever older snapshot was on disk.
                //
                // Only if nothing NEWER arrived meanwhile — a fresher envelope must win — and
                // never over a clear, since `update(null)` takes this same lock and so cannot
                // interleave with the write above.
                if (pendingWrite == null) pendingWrite = json
            }
        }
    }

    /** Guards take-and-write as one step, distinct from the [flushScheduler] lock over
     *  scheduling state. [cancelScheduledFlush] is never called from inside this one,
     *  since taking the two in opposite orders would deadlock. */
    private val writeLock = Any()

    /**
     * Forces the debounced write out WITHOUT blocking the caller — for the background
     * transition, which arrives on the main thread inside `onActivityStopped`. Draining
     * there synchronously would fsync on the main thread on every trip to the background,
     * the exact stall our own ANR watchdog exists to report (and it is paused a line
     * earlier, so it would not even see it).
     *
     * The trade: a daemon thread may lose the newest envelope if the kill lands within
     * milliseconds of backgrounding. A guaranteed main-thread fsync is worse.
     */
    fun flushPendingWriteAsync() {
        if (pendingWrite == null) return
        // A shut-down scheduler rejects; nothing left to write for by then.
        runCatching { flushScheduler.execute { flushPendingWrite() } }
    }

    /**
     * Writes one crash record. Deliberately NOT gated on [closed], unlike every snapshot write.
     *
     * The two paths fail in opposite directions, which is why one flag cannot serve both. A late
     * SNAPSHOT write corrupts a crash that has not happened yet — it puts a finished session's
     * envelope back on disk for the next launch to read. A late RECORD write is a fatal that
     * already happened, captured while the session was still live: refusing it loses a crash
     * outright, which is the one failure this whole subsystem exists to prevent.
     *
     * Reaching here after [close] needs a crash that entered `GcRumCrashHandler.record` BEFORE
     * teardown began — `release()` calls `crashHandler.uninstall()` (recording = false) before
     * `snapshots.close()`, so anything arriving later is already refused at the handler. [close]
     * does not clear the in-memory snapshot either, so such a record still carries its real
     * envelope and the drain delivers it correctly. Where JavaScript had already cleared the
     * snapshot, the envelope is null, the drain acks-and-drops, and the cost is one slot of
     * MAX_PENDING_RECORDS for as long as it takes the next launch to read it.
     */
    override fun writePendingRecord(id: String, json: String): Boolean {
        // Refused here as well as on the ack path, so an id that could never be acked can
        // never be written — otherwise the two halves disagree and strand a record nothing
        // is able to delete.
        if (!isSafeRecordId(id)) return false
        return runCatching {
            pendingDir.mkdirs()
            val target = File(pendingDir, "$id.json")
            enforceRecordCap(incoming = target)
            writeAtomically(target, json, allowBackupFallback = false)
        }.getOrDefault(false)
    }

    fun readPendingRecords(): List<String> =
        runCatching {
            pendingDir.listFiles()
                ?.filter { it.isFile && it.name.endsWith(".json") }
                ?.sortedBy { it.lastModified() }
                ?.mapNotNull { file -> runCatching { file.readText() }.getOrNull() }
                // Only records that are actually a JSON OBJECT survive, and this is a correctness
                // filter rather than tidiness: [GcRumEngine.pendingCrashReportsJson] SPLICES these
                // strings into one array, so a single unparseable file makes JavaScript's
                // `JSON.parse` throw and the drain loses EVERY pending crash rather than the one bad
                // file — leaving all of them un-acked and redelivered forever.
                //
                // Blankness is not a sufficient test. The likelier shape is a TRUNCATED write — a
                // record interrupted by the very crash being recorded leaves `{"id":"ab`, which is
                // non-blank and still poisons the splice. A valid non-object (`"a string"`) parses
                // but then has no fields for the drain to read. Parsing here is the only check that
                // covers all three, and it costs one parse per pending record (capped at
                // [MAX_PENDING_RECORDS]) on a path that runs once per launch.
                //
                // Mirrors GCRumSessionSnapshotStore.readPendingRecords, deliberately: both platforms
                // splice, so both need the same predicate or they disagree about what a record is.
                ?.filter { isJsonObject(it) }
                ?: emptyList()
        }.getOrDefault(emptyList())

    fun deletePendingRecords(ids: List<String>) {
        ids.forEach { id ->
            // The id is interpolated into a path, so `../` would escape the pending
            // directory and delete whatever it named. An ack has no business naming
            // anything but a basename.
            if (!isSafeRecordId(id)) return@forEach
            runCatching { File(pendingDir, "$id.json").delete() }
        }
    }

    /**
     * Whether a persisted record is a JSON object the drain can actually read.
     *
     * `JSONObject(String)` throws on anything that is not one — blank, truncated, a bare scalar —
     * which is exactly the set that must not reach the splice.
     */
    private fun isJsonObject(text: String): Boolean =
        runCatching { JSONObject(text) }.isSuccess

    /**
     * Whether a record id names a file directly inside [pendingDir] and nothing else.
     *
     * Checked by comparing against the platform's own idea of the last path component rather
     * than by hunting for `..`, so a separator or encoding this does not anticipate fails
     * CLOSED. Mirrors `GCRumSessionSnapshotStore.isSafeRecordId` on iOS.
     */
    private fun isSafeRecordId(id: String): Boolean =
        id.isNotEmpty() && !id.startsWith(".") && id == File(id).name

    /**
     * Drop-oldest once the cap is reached. An app that crashes repeatedly without ever
     * reaching a working network must not grow unbounded.
     *
     * Counts what [readPendingRecords] can actually READ, not every file in the directory.
     * A `writePendingRecord` interrupted by the very crash it is recording leaves an
     * `<id>.json.tmp` behind; the reader skips it, so counting it would make the cap see 10
     * where 9 are deliverable and evict the oldest real record a cycle early. The iOS store
     * filters `pathExtension == "json"` in both places too.
     *
     * The `incoming` record is excluded from BOTH the arithmetic and the eviction
     * candidates. A rewrite of an id already on disk adds no record, so it needs no room
     * made for it — capping unconditionally would make re-writing one crash evict a different,
     * unrelated one. And the file about to be written must never be its own victim.
     *
     * A `.tmp` or `.bak` whose `.json` is gone is left alone here: the cap counts records,
     * and deleting a live temp would corrupt the write it belongs to. Abandoned temps are
     * reclaimed by age in [reclaimStaleTemps].
     */
    private fun enforceRecordCap(incoming: File) {
        val records = pendingDir.listFiles()?.filter { it.isFile && it.name.endsWith(".json") }
            ?: return
        val rewriting = records.any { it.name == incoming.name }
        val over = records.size + (if (rewriting) 0 else 1) - MAX_PENDING_RECORDS
        if (over <= 0) return
        records.filter { it.name != incoming.name }
            .sortedBy { it.lastModified() }
            .take(over)
            .forEach { record ->
                runCatching { record.delete() }
                // Records never get a `.bak` of their own ([writeAtomically] refuses the
                // fallback for them), so this only drops a stray one beside an evicted
                // record, which nothing else would ever look at.
                runCatching { File(record.parentFile, "${record.name}$BAK_SUFFIX").delete() }
            }
    }

    /**
     * Which thread last COMPLETED a disk write. This class fsyncs, so where it runs is
     * part of its contract, and recording it makes that assertable. Set after the
     * rename, so it doubles as a completion signal rather than a started-signal.
     */
    @Volatile
    internal var lastWriteThreadName: String? = null
        private set

    /**
     * @param allowBackupFallback whether a rename that cannot replace an existing target may park
     *   the new content in `<target>.bak`. TRUE for the snapshot, which is rewritten on every
     *   session change and whose reader takes the newer of the pair ([newestSnapshotFile]). FALSE
     *   for pending records, which are write-once — both writers mint a fresh `UUID`, so the
     *   target never pre-exists and the fallback cannot fire. Where it could, it would be actively
     *   harmful: [readPendingRecords], [enforceRecordCap] and [deletePendingRecords] all key on
     *   `.json`, so the content would land where nothing reads, counts or acks it while this
     *   function reported success. Failing the write is the honest answer, and it keeps Android's
     *   record contract identical to iOS, which has no `.bak` concept at all.
     * @return whether the contents actually reached a file a reader will find.
     */
    private fun writeAtomically(
        target: File,
        contents: String,
        allowBackupFallback: Boolean = true,
    ): Boolean =
        runCatching {
            val temp = File(target.parentFile, "${target.name}$TEMP_SUFFIX")
            temp.outputStream().use { out ->
                out.write(contents.toByteArray())
                out.flush()
                // A rename is only atomic w.r.t. data that reached the disk; without
                // this a power loss leaves a correctly-named, empty file.
                out.fd.sync()
            }
            val bak = File(target.parentFile, "${target.name}$BAK_SUFFIX")
            if (renameFile(temp, target)) {
                // Primary path: the rename replaced the target atomically. Any `.bak` from a
                // prior fallback is now the older copy, so drop it — it must never win recency.
                runCatching { bak.delete() }
                lastWriteThreadName = Thread.currentThread().name
                return@runCatching true
            }
            if (!allowBackupFallback) {
                // No reader for a record's `.bak`, so parking one would lose the write silently.
                // Nothing reads a `.tmp` either — drop it so it cannot collide with the next
                // attempt — and report the failure.
                runCatching { temp.delete() }
                return@runCatching false
            }
            // Fallback: this filesystem cannot rename OVER an existing file (some OEM
            // FAT/exFAT volumes). Deleting the target and renaming after would lose BOTH
            // copies to a process death between the two (an OOM kill, a native crash, or the
            // very ANR being persisted). So NEVER delete the target: land the
            // new content in a `.bak` renamed to a non-existent name (which works even where
            // replace-over-existing does not), and let readers take whichever of {target,
            // .bak} is newer (see newestSnapshotFile). At every instant at least one complete
            // snapshot is on disk.
            runCatching { bak.delete() }
            // The RESULT matters. Both renames failing leaves the new content in a `.tmp`
            // nothing reads, so the write landed nowhere, and [lastWriteThreadName] is
            // stamped only for a committed write: a lost one must not read as completed.
            if (!renameFile(temp, bak)) {
                // Nothing reads a `.tmp`; leaving it would also collide with the next attempt.
                runCatching { temp.delete() }
                return@runCatching false
            }
            lastWriteThreadName = Thread.currentThread().name
            true
        }.getOrDefault(false)

    internal companion object {
        const val DIR_NAME = "groundcover-rum"
        const val SNAPSHOT_FILE = "snapshot.json"

        /** Recency-preferred backup written by [writeAtomically]'s fallback when the
         *  filesystem cannot rename over an existing file. */
        const val BAK_SUFFIX = ".bak"

        /** Suffix [writeAtomically] gives its in-flight copy, and the only artifact
         *  [reclaimStaleTemps] will delete. */
        const val TEMP_SUFFIX = ".tmp"

        /**
         * How old a `.tmp` has to be before no live write could still own it.
         *
         * A write is a `write` + `fsync` + `rename` and completes in milliseconds; a minute is
         * three orders of magnitude of headroom, so this never races a real one while still
         * reclaiming on the very next launch.
         */
        const val STALE_TEMP_MS = 60_000L
        const val PENDING_DIR = "pending"
        const val MAX_PENDING_RECORDS = 10
        const val WRITE_DEBOUNCE_MS = 500L
        const val FLUSH_THREAD_NAME = "gc-rum-snapshot-flush"

        /** How long [close] waits for an in-flight write. One fsync, not a queue —
         *  short enough that a wedged disk cannot stall a React reload. */
        const val CLOSE_WAIT_MS = 1_000L
    }
}
