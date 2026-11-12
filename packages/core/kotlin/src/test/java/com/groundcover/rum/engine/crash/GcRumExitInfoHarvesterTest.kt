package com.groundcover.rum.engine.crash

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The harvester's selection policy is where the subtle bugs live: the system's
 * exit history spans many runs, but only ONE of them has a snapshot describing
 * it. Picking wrong attributes a death to a session it did not happen in, and
 * nothing downstream can detect that. These run on a bare JVM.
 */
class GcRumExitInfoHarvesterTest {

    private val previousRunStart = 1_000_000L
    private val snapshot = """{"session_id":"s-1","screen":{"name":"Checkout","key":"Checkout-1"}}"""

    private class RecordingStore : GcRumPendingRecordWriter {
        val written = mutableListOf<String>()
        override fun writePendingRecord(id: String, json: String): Boolean {
            written += json
            return true
        }
    }

    /** A store whose writes never commit — a full disk, a revoked permission, a broken volume. */
    private class RefusingStore : GcRumPendingRecordWriter {
        var attempts = 0
        override fun writePendingRecord(id: String, json: String): Boolean {
            attempts++
            return false
        }
    }

    private class FakeBookkeeping(private var value: Long) : GcRumExitInfoHarvester.Bookkeeping {
        override fun lastProcessedExitMs(): Long = value
        override fun setLastProcessedExitMs(value: Long) {
            this.value = value
        }
    }

    /** Every trace read, by the timestamp of the exit it belongs to. */
    private val traceReads = mutableListOf<Long>()

    private fun exit(
        timestampMs: Long,
        reason: Int = GcRumExitInfoHarvester.REASON_ANR,
        description: String? = "Input dispatching timed out",
        traceText: String? = null,
        processName: String? = null,
    ) = GcRumExitInfoHarvester.ExitInfo(
        timestampMs = timestampMs,
        reason = reason,
        importance = 100,
        description = description,
        processName = processName,
        readTrace = {
            traceReads += timestampMs
            traceText
        },
    )

    private fun harvest(
        exits: List<GcRumExitInfoHarvester.ExitInfo>,
        watermark: Long,
        snapshotJson: String? = null,
        // Defaults to "the previous run left a snapshot", which is every launch
        // but the very first. A test passing 0 is asking for the case where the
        // SDK has never run before and there is no session to attribute to.
        previousRunStartedAtMs: Long = previousRunStart,
    ): Pair<List<JSONObject>, FakeBookkeeping> {
        val store = RecordingStore()
        val bookkeeping = FakeBookkeeping(watermark)
        var counter = 0

        GcRumExitInfoHarvester(
            reader = { exits },
            store = store,
            bookkeeping = bookkeeping,
            newId = { "id-${counter++}" },
        ).harvest(snapshotJson, previousRunStartedAtMs)

        return store.written.map { JSONObject(it) } to bookkeeping
    }

    @Test
    fun `reports an ANR from the previous run`() {
        val (records, _) = harvest(listOf(exit(previousRunStart + 500)), watermark = 1L, snapshot)

        assertEquals(1, records.size)
        assertEquals("ANR", records[0].getString("errorType"))
        assertEquals("Input dispatching timed out", records[0].getString("errorMessage"))
        assertEquals(previousRunStart + 500, records[0].getLong("crashEpochMs"))
        assertEquals(snapshot, records[0].getString("sessionSnapshotJson"))
    }

    /**
     * The genuinely-first launch: no snapshot was ever written, so the exit history describes
     * runs from before we existed and reporting them would attribute old deaths to a session
     * that never saw them.
     */
    @Test
    fun `reports nothing when no previous run left a snapshot, only seeds the watermark`() {
        val (records, bookkeeping) = harvest(
            listOf(exit(previousRunStart + 500), exit(previousRunStart + 900)),
            watermark = 0L,
            snapshot,
            previousRunStartedAtMs = 0L,
        )

        assertEquals(0, records.size)
        assertEquals(previousRunStart + 900, bookkeeping.lastProcessedExitMs())
    }

    /**
     * On a fresh install `recentExits()` is empty, so the watermark is never seeded — making the
     * FIRST non-empty harvest the one after the user's first ANR. Seeding whenever
     * `watermark == 0` would seed to that exit and report nothing, so every install would
     * silently swallow its first ANR, permanently. The `>= previousRunStartedAtMs` bound is what
     * actually makes reporting here safe.
     */
    @Test
    fun `reports the previous run's ANR on the first harvest after install`() {
        val (records, bookkeeping) = harvest(
            listOf(exit(previousRunStart + 500)),
            watermark = 0L,
            snapshot,
        )

        assertEquals(1, records.size)
        assertEquals("ANR", records[0].getString("errorType"))
        assertEquals(previousRunStart + 500, records[0].getLong("crashEpochMs"))
        assertEquals(snapshot, records[0].getString("sessionSnapshotJson"))
        assertEquals(previousRunStart + 500, bookkeeping.lastProcessedExitMs())
    }

    /**
     * Reporting on a zero watermark must not reach back past the run we can
     * describe. `timestampMs > watermark` is trivially true at 0, so the
     * previous-run bound is the ONLY thing separating the two here.
     */
    @Test
    fun `still bounds the first harvest by the previous run`() {
        val (records, _) = harvest(
            listOf(
                exit(previousRunStart - 5_000), // a run whose snapshot is long gone
                exit(previousRunStart + 500),
            ),
            watermark = 0L,
            snapshot,
        )

        assertEquals(1, records.size)
        assertEquals(previousRunStart + 500, records[0].getLong("crashEpochMs"))
    }

    @Test
    fun `skips exits older than the previous run — their snapshot is gone`() {
        val (records, _) = harvest(
            listOf(
                exit(previousRunStart - 5_000), // a run before the previous one
                exit(previousRunStart + 500),
            ),
            watermark = 1L,
            snapshot,
        )

        assertEquals(1, records.size)
        assertEquals(previousRunStart + 500, records[0].getLong("crashEpochMs"))
    }

    @Test
    fun `skips exits already reported`() {
        val (records, _) = harvest(
            listOf(exit(previousRunStart + 500), exit(previousRunStart + 900)),
            watermark = previousRunStart + 500,
            snapshot,
        )

        assertEquals(1, records.size)
        assertEquals(previousRunStart + 900, records[0].getLong("crashEpochMs"))
    }

    @Test
    fun `ignores JVM crashes — the in-process handler already recorded those`() {
        // REASON_CRASH would double-count every JVM crash, with a worse stack.
        val reasonCrash = 4
        val (records, _) = harvest(
            listOf(exit(previousRunStart + 500, reason = reasonCrash)),
            watermark = 1L,
            snapshot,
        )

        assertEquals(0, records.size)
    }

    /**
     * The history covers every process of the package, and the snapshot only the engine's own,
     * whose session the user was in. A `:media` or `:push` process dying never ended that session.
     */
    @Test
    fun `reports only the engine's own process's deaths, not another process's`() {
        val store = RecordingStore()
        GcRumExitInfoHarvester(
            reader = {
                listOf(
                    exit(
                        previousRunStart + 500,
                        reason = GcRumExitInfoHarvester.REASON_CRASH_NATIVE,
                        processName = "com.acme.app:media",
                    ),
                    exit(previousRunStart + 600, processName = "com.acme.app"),
                )
            },
            store = store,
            bookkeeping = FakeBookkeeping(1L),
            processName = "com.acme.app",
        ).harvest(snapshot, previousRunStart)

        val records = store.written.map { JSONObject(it) }
        assertEquals(listOf(previousRunStart + 600), records.map { it.getLong("crashEpochMs") })
    }

    /**
     * An RN or Flutter app can host its UI in a named process, with services in the default one.
     * The engine runs, and records its sessions, in the UI process, so that process's deaths are
     * the ones to report.
     */
    @Test
    fun `an engine in a named UI process reports that process's deaths`() {
        val store = RecordingStore()
        GcRumExitInfoHarvester(
            reader = {
                listOf(
                    exit(previousRunStart + 500, processName = "com.acme.app:ui"),
                    exit(previousRunStart + 600, processName = "com.acme.app"),
                )
            },
            store = store,
            bookkeeping = FakeBookkeeping(1L),
            processName = "com.acme.app:ui",
        ).harvest(snapshot, previousRunStart)

        val records = store.written.map { JSONObject(it) }
        assertEquals(listOf(previousRunStart + 500), records.map { it.getLong("crashEpochMs") })
    }

    @Test
    fun `reports a native crash with its own error type`() {
        val (records, _) = harvest(
            listOf(
                exit(
                    previousRunStart + 500,
                    reason = GcRumExitInfoHarvester.REASON_CRASH_NATIVE,
                    description = "SIGSEGV",
                )
            ),
            watermark = 1L,
            snapshot,
        )

        assertEquals("NativeCrash", records[0].getString("errorType"))
        assertEquals("SIGSEGV", records[0].getString("errorMessage"))
    }

    @Test
    fun `advances the watermark past skipped exits so they are not reconsidered`() {
        val reasonUserRequested = 1
        val (_, bookkeeping) = harvest(
            listOf(exit(previousRunStart + 900, reason = reasonUserRequested)),
            watermark = 1L,
            snapshot,
        )

        assertEquals(previousRunStart + 900, bookkeeping.lastProcessedExitMs())
    }

    @Test
    fun `marks the record as a post-mortem reconstruction`() {
        val (records, _) = harvest(listOf(exit(previousRunStart + 500)), watermark = 1L, snapshot)

        val metadata = records[0].getJSONObject("metadata")
        assertEquals("exit_info", metadata.getString("crash_source"))
        // The process never came back — unlike a live watchdog hang.
        assertEquals(false, metadata.getBoolean("recovered"))
        assertTrue(metadata.getBoolean("fatal"))
        assertEquals(GcRumExitInfoHarvester.REASON_ANR, metadata.getInt("exit_reason"))
    }

    @Test
    fun `parses the main thread's frames out of an ANR trace`() {
        val trace = """
            ----- pid 1234 at 2026-07-27 10:00:00 -----
            "main" prio=5 tid=1 Blocked
              | group="main" sCount=1
              at com.acme.shop.Checkout.computeTotals(Checkout.kt:142)
              at com.acme.shop.Cart.onPay(Cart.kt:88)
            "Binder:1234_1" prio=5 tid=9 Native
              at android.os.BinderProxy.transactNative(Binder.java:-2)
        """.trimIndent()

        val (records, _) = harvest(
            listOf(exit(previousRunStart + 500, traceText = trace)),
            watermark = 1L,
            snapshot,
        )

        val frames = records[0].getJSONArray("stacktrace")
        // Only "main" — the other threads in the dump are noise here.
        assertEquals(2, frames.length())
        assertEquals("com.acme.shop.Checkout", frames.getJSONObject(0).getString("filename"))
        assertEquals("computeTotals", frames.getJSONObject(0).getString("function"))
        assertEquals(142, frames.getJSONObject(0).getInt("lineno"))
        assertEquals("onPay", frames.getJSONObject(1).getString("function"))
    }

    @Test
    fun `reads the trace of an exit it reports, and of no other`() {
        // An ANR trace is often megabytes, and the history keeps exits already handled: reading
        // every one on every launch would be the cost, not the reporting.
        val handled = previousRunStart - 5_000
        val reported = previousRunStart + 500
        harvest(
            listOf(
                exit(handled, traceText = "an old, already-handled ANR"),
                exit(reported, traceText = "this run's ANR"),
            ),
            watermark = handled,
            snapshot,
        )

        assertEquals(listOf(reported), traceReads)
    }

    @Test
    fun `a trace is read no further than its cap`() {
        var consumed = 0
        val huge = object : java.io.Reader() {
            override fun read(buffer: CharArray, offset: Int, length: Int): Int {
                java.util.Arrays.fill(buffer, offset, offset + length, 'x')
                consumed += length
                return length
            }

            override fun close() = Unit
        }

        val text = readAtMost(huge, maxChars = 1_000)

        assertEquals(1_000, text.length)
        assertEquals(1_000, consumed)
    }

    @Test
    fun `still reports an ANR whose trace is missing or unparseable`() {
        // OEM trace formats vary; the timing and the fact of the ANR are most of
        // the value, so a parse miss must not drop the event.
        for (trace in listOf(null, "", "total garbage with no frames")) {
            val (records, _) = harvest(
                listOf(exit(previousRunStart + 500, traceText = trace)),
                watermark = 1L,
                snapshot,
            )

            assertEquals(1, records.size)
            assertEquals(0, records[0].getJSONArray("stacktrace").length())
        }
    }

    @Test
    fun `lifts the screen out of the snapshot`() {
        val (records, _) = harvest(listOf(exit(previousRunStart + 500)), watermark = 1L, snapshot)

        assertEquals("Checkout", records[0].getJSONObject("screen").getString("name"))
    }

    @Test
    fun `falls back to a generic message when the system supplies no description`() {
        val (records, _) = harvest(
            listOf(exit(previousRunStart + 500, description = null)),
            watermark = 1L,
            snapshot,
        )

        assertEquals("Application not responding", records[0].getString("errorMessage"))
    }

    @Test
    fun `does nothing when the system reports no exits`() {
        val (records, bookkeeping) = harvest(emptyList(), watermark = 42L, snapshot)

        assertEquals(0, records.size)
        assertEquals(42L, bookkeeping.lastProcessedExitMs())
    }

    /**
     * The cursor claims "everything at or below this has been dealt with", and a record that never
     * reached disk has not been. Advancing to the newest exit seen whatever the store did would
     * move the cursor past an exit nothing had persisted.
     *
     * This does not recover data, as the harvester's own comment says: the exit cannot be
     * reported on a subsequent launch either way, because `>= previousRunStartedAtMs` excludes an
     * exit older than the snapshot it would have to be paired with. What this buys is a cursor
     * that means what it says, so the next launch's arithmetic is not based on a lie.
     */
    @Test
    fun `a record the store refused does not advance the cursor past its exit`() {
        val store = RefusingStore()
        val bookkeeping = FakeBookkeeping(previousRunStart - 1)
        val failing = exit(previousRunStart + 500)

        GcRumExitInfoHarvester(
            reader = { listOf(failing) },
            store = store,
            bookkeeping = bookkeeping,
            newId = { "id-0" },
        ).harvest(snapshot, previousRunStart)

        assertEquals(1, store.attempts)
        assertTrue(
            "the cursor stepped over an exit whose record was never persisted",
            bookkeeping.lastProcessedExitMs() < failing.timestampMs,
        )
    }

}
