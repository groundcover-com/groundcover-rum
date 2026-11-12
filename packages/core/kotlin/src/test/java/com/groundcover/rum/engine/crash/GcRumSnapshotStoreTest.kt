package com.groundcover.rum.engine.crash

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The disk side of crash attribution.
 *
 * Every guarantee here is about what a NEXT process finds on disk, so these
 * tests use a real temporary directory — an in-memory fake would pass whether or
 * not anything was ever written.
 */
class GcRumSnapshotStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    /** A clock the test drives, so debounce behaviour is deterministic. */
    private class FakeClock(var now: Long = 1_000L) : () -> Long {
        override fun invoke(): Long = now
    }

    private fun snapshotFileText(filesDir: File): String? =
        File(File(filesDir, GcRumSnapshotStore.DIR_NAME), GcRumSnapshotStore.SNAPSHOT_FILE)
            .takeIf { it.exists() }
            ?.readText()

    @Test
    fun `a fresh store reads the snapshot the previous run wrote`() {
        val dir = temp.newFolder()
        val clock = FakeClock()

        GcRumSnapshotStore(dir, clock).update("""{"session_id":"crashed"}""")

        assertEquals("""{"session_id":"crashed"}""", GcRumSnapshotStore(dir, clock).snapshotJson())
    }

    /**
     * The debounce has to be TRAILING, not merely rate-limiting: a native crash or an OS
     * kill gives no chance to call [GcRumSnapshotStore.flushPendingWrite], and whatever is
     * on disk then is what the crash is attributed to. JS re-pushes on every screen change,
     * so an update inside the previous window is the ordinary case.
     */
    @Test
    fun `a debounced write reaches disk on its own, without a flush call`() {
        val dir = temp.newFolder()
        // The real clock and the real scheduler: the point is that SOMETHING
        // drains the parked write with no further calls from anyone. Advancing a
        // fake clock would only prove the rate limit, since it is a later
        // update() that would do the writing.
        val store = GcRumSnapshotStore(dir)

        store.update("""{"screen":"Home"}""")     // due immediately — written
        store.update("""{"screen":"Checkout"}""") // inside the window — parked

        // Wait out the debounce. Deliberately no flushPendingWrite() and no
        // further update(): a native crash or a low-memory kill affords neither.
        Thread.sleep(GcRumSnapshotStore.WRITE_DEBOUNCE_MS * 2 + 200)

        assertEquals("""{"screen":"Checkout"}""", snapshotFileText(dir))
    }

    /** In-memory is always current, even while the disk write is debounced. */
    @Test
    fun `memory stays current while the disk write is debounced`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())

        store.update("""{"screen":"one"}""")
        store.update("""{"screen":"two"}""")

        assertEquals("""{"screen":"two"}""", store.snapshotJson())
    }

    /** A queued write must not resurrect a snapshot that was deliberately dropped. */
    @Test
    fun `clearing cancels a pending write rather than letting it land later`() {
        val dir = temp.newFolder()
        val clock = FakeClock()
        val store = GcRumSnapshotStore(dir, clock)

        store.update("""{"session_id":"first"}""")  // written
        store.update("""{"session_id":"second"}""") // parked
        store.update(null)
        store.flushPendingWrite()

        assertNull(snapshotFileText(dir))
        assertNull(GcRumSnapshotStore(dir, clock).snapshotJson())
    }

    /**
     * The store owns a thread, so somebody has to give it back. One store per engine, one
     * engine per React instance, and RN rebuilds that instance on every reload —
     * `GcRumEngine.release()` exists for exactly that, and [GcRumSnapshotStore.close] is how
     * it gives back the store's flush executor.
     *
     * The executor creates its thread on first use, hence the parked write below: without
     * it there is no thread to leak and this passes against a store that releases nothing.
     */
    @Test
    fun `closing the store gives back its flush thread`() {
        val before = flushThreadCount()

        repeat(3) {
            val store = GcRumSnapshotStore(temp.newFolder())
            store.update("""{"screen":"Home"}""")     // due immediately
            store.update("""{"screen":"Checkout"}""") // parked — arms the scheduler
            store.close()
        }

        // shutdownNow interrupts, and the thread still has to be scheduled out.
        val deadline = System.currentTimeMillis() + 2_000
        while (flushThreadCount() > before && System.currentTimeMillis() < deadline) {
            Thread.sleep(25)
        }

        assertEquals(
            "a gc-rum-snapshot-flush thread per store outlived close()",
            before,
            flushThreadCount(),
        )
    }

    /** Closing must not lose the write that was already parked. */
    @Test
    fun `closing flushes the parked write rather than dropping it`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir)

        store.update("""{"screen":"Home"}""")
        store.update("""{"screen":"Checkout"}""")
        store.close()

        assertEquals("""{"screen":"Checkout"}""", snapshotFileText(dir))
    }

    /**
     * The background flush must not write on the thread that asked for it.
     *
     * The background transition arrives on the MAIN thread, inside
     * `onActivityStopped`, during the frame where the activity is being torn down.
     * [GcRumSnapshotStore.writeAtomically] fsyncs, so draining there synchronously
     * stalls the main thread on every single trip to the background — the exact
     * stall this SDK's ANR watchdog exists to report, and invisible to it because
     * the same transition pauses the watchdog a line earlier.
     */
    @Test
    fun `the background flush does not write on the calling thread`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir)
        val caller = Thread.currentThread().name

        store.update("""{"screen":"Home"}""")     // due immediately — written here
        assertEquals(caller, store.lastWriteThreadName)

        store.update("""{"screen":"Checkout"}""") // inside the window — parked
        store.flushPendingWriteAsync()

        val deadline = System.currentTimeMillis() + 2_000
        while (snapshotFileText(dir) != """{"screen":"Checkout"}""" &&
            System.currentTimeMillis() < deadline
        ) {
            Thread.sleep(10)
        }

        // It still has to reach disk — an async flush that never writes would be
        // worse than a blocking one.
        assertEquals("""{"screen":"Checkout"}""", snapshotFileText(dir))
        assertEquals(GcRumSnapshotStore.FLUSH_THREAD_NAME, store.lastWriteThreadName)
        store.close()
    }

    /**
     * Two writers must not land out of order. `flushPendingWrite` takes the parked write and
     * clears it before touching disk, so a background flush and a teardown flush can each
     * hold a DIFFERENT envelope — and unless the two are serialized, the older can finish
     * last and become what the next crash is attributed to.
     *
     * The clock lambda is the gate: `flushPendingWrite` calls it after taking the write and
     * before writing, exactly where the two overlap, so blocking there reproduces the
     * interleaving deterministically rather than hoping a race shows up.
     */
    @Test
    fun `a background flush cannot land an older snapshot on top of a newer one`() {
        val dir = temp.newFolder()
        val holdBackgroundWrite = CountDownLatch(1)
        val backgroundWriteStarted = CountDownLatch(1)
        val gateArmed = AtomicBoolean(false)

        // Named rather than a trailing lambda: `onSnapshotAssigned` is the last
        // parameter, so a trailing block would bind to that instead of the clock.
        val store = GcRumSnapshotStore(
            dir,
            nowMs = {
                if (gateArmed.get() &&
                    Thread.currentThread().name == GcRumSnapshotStore.FLUSH_THREAD_NAME
                ) {
                    backgroundWriteStarted.countDown()
                    holdBackgroundWrite.await(5, TimeUnit.SECONDS)
                }
                1_000L
            },
        )

        store.update("""{"screen":"Home"}""")      // due immediately
        store.update("""{"screen":"Checkout"}""")  // parked

        // The app goes to the background: the parked "Checkout" drains off-main.
        gateArmed.set(true)
        store.flushPendingWriteAsync()
        assertTrue(
            "the background flush never started",
            backgroundWriteStarted.await(5, TimeUnit.SECONDS),
        )

        // JS pushes a newer envelope while that write is still in flight.
        store.update("""{"screen":"Receipt"}""")

        // Release the background write shortly, from another thread, so the two
        // flushes genuinely overlap. Doing it inline would deadlock, because the
        // writes are serialized, so the wake-up cannot be ordered after the call
        // below.
        val releaser = Thread {
            Thread.sleep(150)
            holdBackgroundWrite.countDown()
        }
        releaser.start()

        // Teardown drains the newest envelope on this thread — what `stop()` does.
        // This is the write that must end up on disk.
        store.flushPendingWrite()

        releaser.join()
        // Wait for the background write to actually complete, so this is not
        // asserting on a file the other thread has not reached yet.
        val deadline = System.currentTimeMillis() + 5_000
        while (store.lastWriteThreadName != GcRumSnapshotStore.FLUSH_THREAD_NAME &&
            System.currentTimeMillis() < deadline
        ) {
            Thread.sleep(10)
        }

        assertEquals(
            "the older background write landed on top of the newer one",
            """{"screen":"Receipt"}""",
            snapshotFileText(dir),
        )
        store.close()
    }

    private fun flushThreadCount(): Int =
        Thread.getAllStackTraces().keys.count {
            it.isAlive && it.name == GcRumSnapshotStore.FLUSH_THREAD_NAME
        }

    /**
     * The atomic write's fallback (taken when `renameTo` cannot replace an existing file,
     * as on some OEM filesystems) must never destroy the snapshot. Deleting the target and
     * renaming after would lose BOTH the old and the new envelope to a process death in that
     * window — an OOM kill, a native crash, the very ANR being persisted — leaving a harvested
     * crash with no session to attribute it to. The fallback keeps the previous file and lands
     * the new content in a `.bak` beside it, so a next launch must prefer whichever of
     * {snapshot, snapshot.bak} is newer.
     */
    @Test
    fun `recovers the newer snapshot from the bak a fallback write leaves`() {
        val dir = temp.newFolder()
        val root = File(dir, GcRumSnapshotStore.DIR_NAME).apply { mkdirs() }
        val target = File(root, GcRumSnapshotStore.SNAPSHOT_FILE)
        val bak = File(root, "${GcRumSnapshotStore.SNAPSHOT_FILE}.bak")

        // The on-disk aftermath of a fallback write: the previous envelope still in the
        // primary file, the newer one beside it in .bak (written strictly later).
        target.writeText("""{"session_id":"older"}""")
        bak.writeText("""{"session_id":"newer"}""")
        target.setLastModified(1_000_000L)
        bak.setLastModified(2_000_000L)

        assertEquals("""{"session_id":"newer"}""", GcRumSnapshotStore(dir).snapshotJson())
    }

    /**
     * The write side of the same guarantee, on a filesystem whose rename cannot replace an
     * existing file: the previously committed snapshot survives a fallback write, and the newest
     * is still recovered.
     */
    @Test
    fun `a fallback write never destroys the previously committed snapshot`() {
        val dir = temp.newFolder()

        // First write commits normally: rename to a not-yet-existing target succeeds.
        GcRumSnapshotStore(dir, FakeClock()).update("""{"session_id":"first"}""")

        // Now the device's rename can no longer replace an existing file — the OEM condition.
        val cannotReplace: (File, File) -> Boolean = { source, dest ->
            if (dest.exists()) false else source.renameTo(dest)
        }
        GcRumSnapshotStore(dir, FakeClock(), renameFile = cannotReplace)
            .update("""{"session_id":"second"}""")

        // A next launch (real rename) recovers a valid snapshot — and the NEWEST one.
        assertEquals("""{"session_id":"second"}""", GcRumSnapshotStore(dir).snapshotJson())
    }

    /**
     * `File.delete()` reports failure by RETURNING false, not by throwing, so a filesystem that
     * refuses the delete leaves a readable file behind — and [newestSnapshotFile] PREFERS the
     * `.bak` once the primary is gone, so the common failure shape (primary deleted, backup
     * refused) is exactly the one that survives. Unguarded, the next launch would read it straight
     * back and attribute a crash to the session and user JavaScript had just said were gone.
     *
     * Driven through the delete seam rather than by chmod: a directory made read-only would also
     * block the truncate the guard relies on, so the test would pass for the wrong reason.
     */
    @Test
    fun `a cleared snapshot stays cleared even when the filesystem refuses the delete`() {
        val dir = temp.newFolder()

        // Get a `.bak` onto disk the way production does: a rename that cannot replace.
        val cannotReplace: (File, File) -> Boolean = { source, dest ->
            if (dest.exists()) false else source.renameTo(dest)
        }
        GcRumSnapshotStore(dir, FakeClock()).update("""{"session_id":"doomed"}""")
        GcRumSnapshotStore(dir, FakeClock(), renameFile = cannotReplace)
            .update("""{"session_id":"doomed-2"}""")

        // Now nothing can be deleted at all — the OS refusing, reported as `false`.
        val refusesDelete: (File) -> Boolean = { false }
        GcRumSnapshotStore(dir, FakeClock(), deleteFile = refusesDelete).update(null)

        assertNull(
            "a next launch resurrected a session the SDK had cleared",
            GcRumSnapshotStore(dir).snapshotJson()
        )
    }

    /**
     * The read half of the guarantee above: `readText()` on an empty file returns `""`, not null.
     * A truncate that the read path does not know about would make [GcRumSnapshotStore.snapshotJson]
     * return `""` rather than null — and the crash drain treats a non-null envelope as one it can
     * attribute a crash to, so an empty string would be parsed as a session rather than skipped.
     */
    @Test
    fun `a blank snapshot file reads as absent, not as an empty envelope`() {
        val dir = temp.newFolder()
        val root = File(dir, GcRumSnapshotStore.DIR_NAME).apply { mkdirs() }
        File(root, GcRumSnapshotStore.SNAPSHOT_FILE).writeText("")

        val json = GcRumSnapshotStore(dir).snapshotJson()
        assertNull("a blank file was reported as an envelope rather than as no snapshot", json)
    }

    /** Whitespace is the same case: nothing there is an envelope. */
    @Test
    fun `a whitespace-only snapshot file also reads as absent`() {
        val dir = temp.newFolder()
        val root = File(dir, GcRumSnapshotStore.DIR_NAME).apply { mkdirs() }
        File(root, GcRumSnapshotStore.SNAPSHOT_FILE).writeText("  \n ")

        assertNull(GcRumSnapshotStore(dir).snapshotJson())
    }

    /**
     * `lastWriteThreadName` is documented as a COMPLETION signal — "set after the rename, so it
     * doubles as a completion signal rather than a started-signal" — and the engine-teardown
     * assertions read it as one. Set unconditionally — including on the fallback path, without
     * inspecting the `renameFile` result — it would report a write that landed nowhere as a write
     * that succeeded. A test asserting on it could then go green against a snapshot that never
     * reached disk, which is worse than the lost write itself.
     */
    @Test
    fun `a write that committed nothing does not report itself as completed`() {
        val dir = temp.newFolder()
        val neverRenames: (File, File) -> Boolean = { _, _ -> false }
        val store = GcRumSnapshotStore(dir, FakeClock(), renameFile = neverRenames)

        store.update("""{"session_id":"never-landed"}""")

        assertNull(
            "a write that reached no file still claimed a completed write",
            store.lastWriteThreadName
        )
    }

    /**
     * Clearing `pendingWrite` regardless of whether the write committed would let a failed write
     * drop the parked envelope outright: nothing would retry, and the next crash would be
     * attributed to whatever older snapshot happened to still be on disk. Keeping it parked costs
     * nothing — the next update or flush writes it, and `update(null)` still clears it — and is the
     * difference between a transient filesystem refusal and a permanently stale attribution.
     */
    @Test
    fun `a failed write keeps the envelope parked so a later flush can still land it`() {
        val dir = temp.newFolder()
        var allowRename = false
        val store = GcRumSnapshotStore(
            dir,
            FakeClock(),
            renameFile = { source, dest -> if (allowRename) source.renameTo(dest) else false },
        )

        store.update("""{"session_id":"retried"}""")
        assertNull("nothing should have reached disk yet", snapshotFileText(dir))

        // The filesystem recovers; the envelope JS pushed must still be there to write.
        allowRename = true
        store.flushPendingWrite()

        assertEquals(
            "the parked envelope was discarded by the failed write, so nothing was left to retry",
            """{"session_id":"retried"}""",
            snapshotFileText(dir)
        )
    }

    /**
     * Ack ids are interpolated straight into a path, so unguarded, `../` would escape the pending
     * directory and delete whatever it named. Reachability is low — the ids are generated natively
     * and read back from a directory inside the app sandbox, so exploiting it means already being
     * able to write there — but a basename guard costs one comparison. Mirrors
     * `GCRumSessionSnapshotStore.isSafeRecordId` on iOS.
     */
    @Test
    fun `an ack id cannot escape the pending directory`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())
        store.writePendingRecord("keep", """{"id":"keep"}""")

        // A file the ack must not be able to reach: a sibling of `pending/`.
        val outside = File(File(dir, GcRumSnapshotStore.DIR_NAME), "outside.json")
        outside.writeText("""{"not":"ours"}""")

        store.deletePendingRecords(listOf("../outside", "keep/../../outside"))

        assertTrue("an ack id escaped the pending directory", outside.exists())
        // …and the legitimate record is untouched by a rejected ack.
        assertEquals(listOf("""{"id":"keep"}"""), store.readPendingRecords())
    }

    /**
     * ONE bad file must not cost the WHOLE harvest.
     *
     * `GcRumEngine.pendingCrashReportsJson()` splices these strings — `joinToString(prefix = "[",
     * separator = ",", postfix = "]")` — so an empty record produces `[,{…}]`, which is not JSON.
     * JavaScript's `JSON.parse` throws, the drain catches it, and every pending crash is lost
     * rather than the one bad file. Reachable whenever a `.json` exists but holds nothing: a file
     * created but not yet written when the process died, or a write interrupted by the very crash
     * being recorded.
     *
     * The iOS store has the same case. Both platforms splice, so both platforms have to filter.
     */
    @Test
    fun `an empty pending file cannot destroy the rest of the harvest`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())
        store.writePendingRecord("real", """{"id":"real"}""")

        val pending = File(File(dir, GcRumSnapshotStore.DIR_NAME), GcRumSnapshotStore.PENDING_DIR)
        File(pending, "blank.json").writeText("")
        File(pending, "ws.json").writeText("  \n")
        // A TRUNCATED write, and the likelier shape of the two: a record interrupted by the very
        // crash being recorded leaves a partial file, not an empty one. Non-blank, so a
        // whitespace-only filter lets it through and it poisons the splice just the same.
        File(pending, "torn.json").writeText("""{"id":"torn","errorTyp""")
        // Valid JSON, but not an object — `JSON.parse` succeeds and the drain then reads fields
        // off a string.
        File(pending, "scalar.json").writeText(""""just a string"""")

        val records = store.readPendingRecords()
        assertEquals(listOf("""{"id":"real"}"""), records)
        // The claim that actually matters: what the engine splices stays parseable.
        assertFalse(
            "the spliced array would not parse",
            records.joinToString(prefix = "[", separator = ",", postfix = "]").contains("[,")
        )
    }

    /**
     * The guard's happy path, and the reason it is not optional to test: the ids are
     * `UUID.randomUUID()` from GcRumCrashHandler and GcRumExitInfoHarvester, so a guard that
     * rejected them would silently stop crashes being written at all — capture would look armed
     * and report nothing, which is the worst failure this file can have. Asserted with a real
     * UUID's shape rather than a placeholder, because the hyphens are the part a naive
     * path-component check could plausibly mishandle.
     */
    @Test
    fun `a native UUID record id is accepted`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())
        val id = java.util.UUID.randomUUID().toString()

        store.writePendingRecord(id, """{"id":"$id"}""")

        assertEquals(listOf("""{"id":"$id"}"""), store.readPendingRecords())
        store.deletePendingRecords(listOf(id))
        assertEquals(emptyList<String>(), store.readPendingRecords())
    }

    /** The write half of the same guard, so an id that could never be acked can never be
     *  written — otherwise the two halves disagree and strand a record nothing can delete. */
    @Test
    fun `a traversing record id is not written at all`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())

        store.writePendingRecord("../escaped", """{"id":"escaped"}""")

        assertFalse(
            "a record was written outside the pending directory",
            File(File(dir, GcRumSnapshotStore.DIR_NAME), "escaped.json").exists()
        )
        assertEquals(emptyList<String>(), store.readPendingRecords())
    }

    /**
     * The teardown window, and the backstop for it.
     *
     * `updateSessionSnapshot` posts to the engine's HandlerThread, and `quitSafely()` still runs
     * messages that were ALREADY queued. So a queued `update(X)` can execute after `release()`
     * has flushed and closed the store — and because `update` writes on the CALLING thread once
     * the debounce window has elapsed, it would bypass the shut-down scheduler entirely and land
     * on disk after the final flush. The next launch would then attribute a crash to a session
     * JavaScript had already finished with.
     *
     * The engine drains its queue before closing, so legitimate updates still land. This is the
     * other half: once closed, nothing reaches disk no matter who calls. Memory still tracks
     * the value, since the crash handler reads memory and a crash during teardown is still worth
     * reporting.
     */
    @Test
    fun `no write reaches disk after close, however late the caller is`() {
        val dir = temp.newFolder()
        val clock = FakeClock()
        val store = GcRumSnapshotStore(dir, clock)

        store.update("""{"session_id":"live"}""")
        assertEquals("""{"session_id":"live"}""", snapshotFileText(dir))

        store.close()

        // A message that was already queued on the engine's HandlerThread, running late. The
        // clock is advanced past the debounce window so this takes update()'s WRITE-NOW path —
        // the one that does not go through the shut-down scheduler.
        clock.now += GcRumSnapshotStore.WRITE_DEBOUNCE_MS * 2
        store.update("""{"session_id":"after-teardown"}""")

        assertEquals(
            "a write landed after close(), so a crash would be attributed to a dead session",
            """{"session_id":"live"}""",
            snapshotFileText(dir)
        )
        assertEquals(
            "memory should still track the value — the crash handler reads memory",
            """{"session_id":"after-teardown"}""",
            store.snapshotJson()
        )
    }

    /** A clear after close must still take effect: it removes data rather than writing it, and
     *  a dropped session left readable would let the next launch attribute a crash to it. */
    @Test
    fun `a clear after close still erases the snapshot`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())
        store.update("""{"session_id":"gone"}""")
        store.close()

        store.update(null)

        assertNull(snapshotFileText(dir))
        assertNull(GcRumSnapshotStore(dir).snapshotJson())
    }

    @Test
    fun `pending records are capped, dropping the oldest`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())

        val pending = File(File(dir, GcRumSnapshotStore.DIR_NAME), GcRumSnapshotStore.PENDING_DIR)
        val base = System.currentTimeMillis() - 60_000
        repeat(GcRumSnapshotStore.MAX_PENDING_RECORDS + 5) { i ->
            store.writePendingRecord("crash-$i", """{"id":"crash-$i"}""")
            // A distinct mtime per record, because both the eviction sort and the read sort are
            // `sortedBy { it.lastModified() }` and every write here lands in the same millisecond.
            // Without this the SET that survives is still right but its ORDER is undefined. The
            // same holds beyond the test: oldest-first is only as precise as the filesystem's
            // timestamp resolution, so records written inside one millisecond can reach the drain
            // out of order — harmless in production, where crashes are seconds apart.
            File(pending, "crash-$i.json").setLastModified(base + i * 1_000L)
        }

        // The exact survivors, in order, not just the count: `size <= MAX` is satisfied by ANY
        // subset, so it would pin the cap and say nothing about the drop-oldest policy or the
        // oldest-first order the drain depends on.
        //
        // This does not subsume the two tests below it. A cap that counts unreadable files, or
        // caps on a rewrite, still passes here, since plain overflow evicts the same records
        // either way; `a stranded temp file…` and `rewriting an existing record…` cover those.
        assertEquals(
            (5..14).map { """{"id":"crash-$it"}""" },
            store.readPendingRecords()
        )
    }

    /**
     * What `enforceRecordCap`'s `.json` filter cannot clean up: a `writePendingRecord`
     * interrupted by the very crash it is recording leaves `<id>.json.tmp`, which the reader
     * skips and the cap does not count — so without an age sweep, one whose `.json` never
     * landed would be deleted by nothing at all, once per interrupted write, forever.
     *
     * Age is what separates an abandoned temp from a live one. Note the clock and the file
     * timestamps have to sit in the same domain: the store compares [GcRumSnapshotStore] `nowMs`
     * against `File.lastModified()`, so the fake clock is seeded from real epoch time here rather
     * than from a counter.
     */
    @Test
    fun `a temp too old to belong to a live write is reclaimed, a fresh one is not`() {
        val dir = temp.newFolder()
        val nowReal = System.currentTimeMillis()
        val clock = FakeClock(now = nowReal)
        val pending = File(File(dir, GcRumSnapshotStore.DIR_NAME), GcRumSnapshotStore.PENDING_DIR)

        GcRumSnapshotStore(dir, clock).writePendingRecord("crash-1", """{"id":"crash-1"}""")

        val abandoned = File(pending, "crash-old.json${GcRumSnapshotStore.TEMP_SUFFIX}")
            .apply { writeText("""{"id":"half""") }
        abandoned.setLastModified(nowReal - GcRumSnapshotStore.STALE_TEMP_MS - 1_000)
        val inFlight = File(pending, "crash-live.json${GcRumSnapshotStore.TEMP_SUFFIX}")
            .apply { writeText("""{"id":"half""") }
        inFlight.setLastModified(nowReal)

        // The next launch.
        val next = GcRumSnapshotStore(dir, clock)

        assertFalse(
            "a temp no live write could still own survived, so the directory grows unbounded",
            abandoned.exists()
        )
        assertTrue(
            "a temp young enough to belong to an in-flight write was deleted under it",
            inFlight.exists()
        )
        assertEquals(
            "reclaiming touched a real record",
            listOf("""{"id":"crash-1"}"""),
            next.readPendingRecords()
        )
    }

    /** `.bak` is a durable fallback copy, not a scrap: sweeping it by age deletes live data. */
    @Test
    fun `an old fallback copy is not reclaimed as if it were a temp`() {
        val dir = temp.newFolder()
        val nowReal = System.currentTimeMillis()
        val clock = FakeClock(now = nowReal)
        val pending = File(File(dir, GcRumSnapshotStore.DIR_NAME), GcRumSnapshotStore.PENDING_DIR)
        GcRumSnapshotStore(dir, clock).writePendingRecord("crash-1", """{"id":"crash-1"}""")

        val fallback = File(pending, "crash-1.json${GcRumSnapshotStore.BAK_SUFFIX}")
            .apply { writeText("""{"id":"crash-1","take":2}""") }
        fallback.setLastModified(nowReal - GcRumSnapshotStore.STALE_TEMP_MS - 1_000)

        GcRumSnapshotStore(dir, clock)

        assertTrue(
            "an aged .bak was swept as a scrap — the crash-drain layer reads it as the record",
            fallback.exists()
        )
    }

    /**
     * The cap has to count what the READER can read. A `writePendingRecord` interrupted by
     * the very crash it is recording leaves an `<id>.json.tmp`, which [readPendingRecords]
     * skips — so a cap that counted it would, with one stray, see 10 where 9 are deliverable
     * and evict the oldest real crash a cycle early.
     */
    @Test
    fun `a stranded temp file does not cost a real record its place`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())
        val pending = File(File(dir, GcRumSnapshotStore.DIR_NAME), GcRumSnapshotStore.PENDING_DIR)

        // One short of the cap, so nothing should be evicted by the next write.
        repeat(GcRumSnapshotStore.MAX_PENDING_RECORDS - 1) { i ->
            store.writePendingRecord("crash-$i", """{"id":"crash-$i"}""")
        }
        // A crash-time write that died after the temp landed and before the rename.
        File(pending, "crash-interrupted.json.tmp").writeText("""{"id":"half""")

        store.writePendingRecord("crash-last", """{"id":"crash-last"}""")

        val ids = store.readPendingRecords()
        assertEquals(
            "the stray .tmp was counted against the cap and cost a real record its place",
            GcRumSnapshotStore.MAX_PENDING_RECORDS,
            ids.size
        )
        assertTrue(
            "the OLDEST real record was evicted to make room for a file nobody reads",
            ids.any { it.contains("crash-0") }
        )
    }

    /**
     * Rewriting a record already on disk adds nothing, so it needs no room made for it.
     * Capping unconditionally would make re-writing one crash evict a different, unrelated one.
     */
    @Test
    fun `rewriting an existing record evicts nothing`() {
        val dir = temp.newFolder()
        val store = GcRumSnapshotStore(dir, FakeClock())

        repeat(GcRumSnapshotStore.MAX_PENDING_RECORDS) { i ->
            store.writePendingRecord("crash-$i", """{"id":"crash-$i"}""")
        }
        assertEquals(GcRumSnapshotStore.MAX_PENDING_RECORDS, store.readPendingRecords().size)

        // Same id, new content: a replacement, not an addition.
        store.writePendingRecord("crash-5", """{"id":"crash-5","take":2}""")

        val records = store.readPendingRecords()
        assertEquals(
            "rewriting a record evicted an unrelated crash to make room it did not need",
            GcRumSnapshotStore.MAX_PENDING_RECORDS,
            records.size
        )
        assertTrue(
            "the oldest unrelated record was evicted by a mere rewrite",
            records.any { it.contains("crash-0") }
        )
        assertTrue(
            "the rewrite did not land",
            records.any { it.contains(""""take":2""") }
        )
    }

    // region Legacy location

    /**
     * The store lives in `noBackupFilesDir` because the envelope carries whatever
     * `identifyUser` was given and `filesDir` is swept into Auto Backup. A library cannot
     * exclude itself via the manifest (`fullBackupContent` is an `<application>` attribute
     * that would collide with the host's), so the supported route is a DIFFERENT PATH —
     * which on its own would leave data an older SDK version wrote under `filesDir` in the
     * backup set forever. Deleting it is the point, not tidiness.
     */
    @Test
    fun `deletes data left behind in the legacy backed-up location`() {
        val legacyBase = temp.newFolder()
        val base = temp.newFolder()

        GcRumSnapshotStore(legacyBase).apply {
            update("""{"session_id":"s-old","user":{"email":"person@example.com"}}""")
            writePendingRecord("crash-old", """{"id":"crash-old"}""")
            close()
        }
        val legacyDir = File(legacyBase, GcRumSnapshotStore.DIR_NAME)
        assertTrue("fixture did not write to the legacy location", legacyDir.exists())

        val store = GcRumSnapshotStore(base, legacyBaseDir = legacyBase)

        assertFalse("legacy directory survived the migration", legacyDir.exists())
        // The new store starts clean rather than inheriting the old contents:
        // the records are the previous install's and were already reported or
        // already lost, and the envelope names a session that has ended.
        assertNull(store.snapshotJson())
        assertEquals(emptyList<String>(), store.readPendingRecords())
        store.close()
    }

    /** The ordinary case on every launch after the first — and on a fresh
     *  install, where the legacy directory never existed at all. */
    @Test
    fun `tolerates a legacy location that is not there`() {
        val base = temp.newFolder()
        val absent = File(temp.newFolder(), "never-existed")

        val store = GcRumSnapshotStore(base, legacyBaseDir = absent)
        store.update("""{"session_id":"s-new"}""")

        assertEquals("""{"session_id":"s-new"}""", store.snapshotJson())
        store.close()
    }

    /**
     * Clearing has to be indivisible with respect to a flush that is ALREADY RUNNING, not
     * merely one that is still queued.
     *
     * [GcRumSnapshotStore.update] with null cancels the scheduled flush, but
     * `cancel(false)` cannot stop a task that has already started — so a clear that did not
     * take `writeLock` could land in the middle of [GcRumSnapshotStore.flushPendingWrite]'s
     * take-and-write. The flush would then complete with the envelope it had already
     * captured and put the cleared snapshot back on disk, where the NEXT launch reads it: a
     * crash attributed to the session and user that JavaScript had just said were gone.
     * `updateSessionSnapshot(null)` is a real call — NativeSnapshotPusher makes it whenever
     * there is no live session.
     *
     * Deterministic because the injected clock is read INSIDE that lock, one line before
     * the disk write, which is the only place a test can hold a flush open mid-write.
     */
    @Test
    fun `clearing while a flush is already running does not resurrect the snapshot`() {
        val dir = temp.newFolder()
        val testThread = Thread.currentThread()
        val insideWrite = CountDownLatch(1)
        val mayFinishWrite = CountDownLatch(1)

        val store = GcRumSnapshotStore(dir, nowMs = {
            // Only the flush thread is parked; the test thread's own reads must not block.
            if (Thread.currentThread() != testThread) {
                insideWrite.countDown()
                mayFinishWrite.await(5, TimeUnit.SECONDS)
            }
            // Fixed and below the debounce, so `update` parks the write for the trailing
            // flush rather than writing inline on this thread.
            1L
        })

        store.update("""{"session_id":"doomed"}""")

        assertTrue(
            "the trailing flush never reached the disk write",
            insideWrite.await(5, TimeUnit.SECONDS)
        )

        // JavaScript drops the session while that flush is mid-write.
        store.update(null)

        mayFinishWrite.countDown()
        store.close()

        assertNull(
            "a cleared snapshot was rewritten to disk by the in-flight flush",
            snapshotFileText(dir)
        )
        assertNull(
            "a next launch would attribute a crash to the cleared session",
            GcRumSnapshotStore(dir).snapshotJson()
        )
    }

    /**
     * The mirror of the test above, from the other side. That one holds a flush open and
     * clears underneath it; this one clears while an `update` is between its two in-memory
     * assignments — a window the clear path's own lock does not cover on its own.
     *
     * The two threads are real: `start()` calls `update` on the native-modules queue via
     * `nativeInit`, while `updateSessionSnapshot` posts to the `gc-rum-engine`
     * HandlerThread. Deterministic because [GcRumSnapshotStore.onSnapshotAssigned] fires
     * between those assignments, which is the only place a test can stand — they are
     * adjacent, so no injected clock or rename can be reached from inside the window.
     *
     * The assertion that carries this test is the one INSIDE the window, and it is on the
     * clearing thread's STATE rather than on what ended up on disk. Both weaker forms pass
     * against an unsynchronized implementation:
     *
     *  - The two disk assertions do, whenever the clearing thread is slow to reach
     *    `update(null)`: this frame writes its envelope, the clear then deletes it, and the
     *    end state is exactly what a correct implementation leaves.
     *  - "the clear did not finish inside the window" does too, for the same reason — a
     *    clear that never started has not finished either.
     *
     * Both read a scheduler accident as a verdict. `Thread.State.BLOCKED` does not: it means
     * this thread is parked trying to ENTER a synchronized block, which is the invariant
     * itself — the writer holds `writeLock` across both assignments. Unsynchronized, the
     * clearing thread is never blocked on it, whether it finishes inside the window or
     * crawls, so the test is red however the two threads are scheduled.
     */
    @Test
    fun `a clear cannot be straddled by the update it interleaves with`() {
        val dir = temp.newFolder()
        val clearerReady = CountDownLatch(1)
        val clearDone = CountDownLatch(1)
        val armed = AtomicBoolean(false)
        val clearParkedOnLock = AtomicBoolean(false)
        var storeRef: GcRumSnapshotStore? = null

        val clearer = Thread {
            clearerReady.countDown()
            storeRef?.update(null)
            clearDone.countDown()
        }

        val store = GcRumSnapshotStore(
            dir,
            // Above the debounce against a zero `lastWriteMs`, so `update` writes inline
            // rather than parking — the resurrect is then observable without waiting.
            nowMs = { 100_000L },
            onSnapshotAssigned = {
                if (armed.compareAndSet(false, true)) {
                    clearer.start()
                    // Establish the thread is alive and heading for the lock, so a timeout
                    // below cannot be read as "blocked" when it means "not started".
                    clearerReady.await(5, TimeUnit.SECONDS)
                    val finished = clearDone.await(1, TimeUnit.SECONDS)
                    // Recorded, not asserted: an assertion thrown from here would unwind
                    // through the store's own frame while it holds `writeLock`.
                    clearParkedOnLock.set(!finished && clearer.state == Thread.State.BLOCKED)
                }
            },
        )
        storeRef = store

        store.update("""{"session_id":"live"}""")

        assertTrue("the clearing thread never ran", clearDone.await(5, TimeUnit.SECONDS))
        store.close()

        assertTrue(
            "the clearing thread was not parked on `writeLock` inside update()'s assignment " +
                "window, so the two in-memory writes are not held under one lock",
            clearParkedOnLock.get()
        )
        assertNull(
            "an update that straddled the clear wrote its envelope back over the deleted file",
            snapshotFileText(dir)
        )
        assertNull(
            "a next launch would attribute a crash to the cleared session",
            GcRumSnapshotStore(dir).snapshotJson()
        )
    }

    /**
     * The `.bak` fallback belongs to the SNAPSHOT, which is rewritten on every session change.
     * A pending record is write-once — both writers mint a fresh `UUID` — so its target never
     * pre-exists and the fallback cannot fire in production. Where it COULD fire, parking a
     * record in `<id>.json.bak` would be worse than failing: [readPendingRecords] and
     * [enforceRecordCap] both key on `.json`, so the content would land where nothing reads it
     * while `writeAtomically` reported success.
     *
     * Pinning the contract rather than the symptom: a record write leaves no `.bak` behind, which
     * is what lets the reader, the cap and the ack path all key on one extension.
     */
    @Test
    fun `a record write never parks content in a bak nothing reads`() {
        val dir = temp.newFolder()
        val cannotReplace: (File, File) -> Boolean = { source, dest ->
            if (dest.exists()) false else source.renameTo(dest)
        }
        val store = GcRumSnapshotStore(dir, FakeClock(), renameFile = cannotReplace)

        store.writePendingRecord("crash-1", """{"id":"crash-1","take":1}""")
        // A rewrite is the only way to reach the fallback: the target now exists.
        store.writePendingRecord("crash-1", """{"id":"crash-1","take":2}""")

        val pendingDir = File(File(dir, GcRumSnapshotStore.DIR_NAME), GcRumSnapshotStore.PENDING_DIR)
        val pending = pendingDir.listFiles()?.map { it.name }?.sorted() ?: emptyList()
        assertEquals(listOf("crash-1.json"), pending)
        assertEquals(1, store.readPendingRecords().size)
    }

    /**
     * The snapshot read path and the record read path feed the same drain, so both demand a
     * JSON OBJECT rather than merely non-blank text. A non-object envelope is not attributable —
     * `parseSnapshot` in the JS drain rejects anything without a string `session_id` — so this
     * costs nothing observable and buys one predicate feeding one consumer.
     */
    @Test
    fun `a snapshot that is not a JSON object reads as absent`() {
        val dir = temp.newFolder()
        val root = File(dir, GcRumSnapshotStore.DIR_NAME).apply { mkdirs() }
        File(root, GcRumSnapshotStore.SNAPSHOT_FILE).writeText("42")

        assertNull(GcRumSnapshotStore(dir).snapshotJson())
    }

    // endregion
    /**
     * The return value is the point: a `Unit` return would make every caller assume the record
     * was on disk. `GcRumExitInfoHarvester` is one such caller, and it advances its watermark on
     * the answer — see `a record the store refused does not advance the cursor past its exit`.
     */
    @Test
    fun `writePendingRecord reports whether the record reached disk`() {
        val dir = temp.newFolder()
        val neverRenames: (File, File) -> Boolean = { _, _ -> false }

        val refused = GcRumSnapshotStore(dir, FakeClock(), renameFile = neverRenames)
        assertFalse(refused.writePendingRecord("crash-1", """{"id":"crash-1"}"""))
        // ...and it said so because nothing landed, not merely because a rename returned false.
        assertEquals(emptyList<String>(), refused.readPendingRecords())

        val committed = GcRumSnapshotStore(dir, FakeClock())
        assertTrue(committed.writePendingRecord("crash-2", """{"id":"crash-2"}"""))
        assertEquals(1, committed.readPendingRecords().size)
    }
}
