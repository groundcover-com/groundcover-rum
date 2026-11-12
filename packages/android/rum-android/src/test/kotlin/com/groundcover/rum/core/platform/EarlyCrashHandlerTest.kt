package com.groundcover.rum.core.platform

import com.groundcover.rum.engine.crash.GcRumCrashHandler
import com.groundcover.rum.engine.crash.GcRumPendingRecordWriter
import com.groundcover.rum.engine.crash.GcRumSnapshotStore
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The handler that covers a launch until the engine's own is installed: a crash right after start
// returns must still reach disk, and once the engine owns crash capture this one must neither
// record a second copy nor stop the crash reaching the platform. Robolectric for org.json. These
// change the process-wide default handler, so the real one is restored around each.
@RunWith(RobolectricTestRunner::class)
class EarlyCrashHandlerTest {
    @get:Rule
    val temp = TemporaryFolder()

    private var hostDefault: Thread.UncaughtExceptionHandler? = null
    private val terminal = Terminal()
    private val written = mutableListOf<String>()
    private val writer = object : GcRumPendingRecordWriter {
        override fun writePendingRecord(id: String, json: String) = written.add(json)
    }
    private val snapshot = """{"session_id":"s-now","screen":{"name":"","key":""}}"""

    private class Terminal : Thread.UncaughtExceptionHandler {
        val seen = mutableListOf<Throwable>()
        override fun uncaughtException(thread: Thread, throwable: Throwable) {
            seen.add(throwable)
        }
    }

    @Before
    fun installTerminal() {
        hostDefault = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler(terminal)
    }

    @After
    fun restoreHostDefault() {
        Thread.setDefaultUncaughtExceptionHandler(hostDefault)
    }

    private fun early(snapshotJson: String? = snapshot) =
        EarlyCrashHandler(snapshotJson, makeWriter = { writer }, newId = { "early-1" })

    private fun crash(message: String = "launch crash") = IllegalStateException(message).also {
        Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(Thread.currentThread(), it)
    }

    @Test
    fun aCrashBeforeTheEngineInstallsIsRecordedUnderThisRunsSessionAndStillReachesThePlatform() {
        early().install()

        val thrown = crash()

        val record = JSONObject(written.single())
        assertEquals("early-1", record.getString("id"))
        assertEquals("java.lang.IllegalStateException", record.getString("errorType"))
        assertEquals(snapshot, record.getString("sessionSnapshotJson"))
        assertEquals(listOf(thrown), terminal.seen)
    }

    @Test
    fun onceTheEngineHandlerSitsOnTopOnlyItRecords() {
        early().install()
        val engineHandler =
            GcRumCrashHandler(GcRumSnapshotStore(temp.newFolder()), newId = { "engine-1" })
        engineHandler.install()

        crash()

        assertTrue("the engine's handler wrote it, this one didn't", written.isEmpty())
        assertEquals(1, terminal.seen.size)
        engineHandler.uninstall()
    }

    @Test
    fun afterTheHandOverItRecordsNothingAndStepsOutOfTheChain() {
        val handler = early()
        handler.install()

        handler.handOver()

        assertSame(terminal, Thread.getDefaultUncaughtExceptionHandler())
        handler.uncaughtException(Thread.currentThread(), IllegalStateException("late"))
        assertTrue(written.isEmpty())
        assertEquals(1, terminal.seen.size)
    }

    @Test
    fun handedOverBeneathAnotherHandlerItOnlyPassesCrashesOn() {
        val handler = early()
        handler.install()
        val other = Thread.UncaughtExceptionHandler { thread, error ->
            handler.uncaughtException(thread, error)
        }
        Thread.setDefaultUncaughtExceptionHandler(other)

        handler.handOver()
        crash()

        assertSame(other, Thread.getDefaultUncaughtExceptionHandler())
        assertTrue(written.isEmpty())
        assertEquals(1, terminal.seen.size)
    }

    @Test
    fun withoutASessionSnapshotThereIsNothingToFileTheCrashUnder() {
        early(snapshotJson = null).install()

        crash()

        assertTrue(written.isEmpty())
        assertEquals(1, terminal.seen.size)
    }

    @Test
    fun aFailingWriteNeverChangesHowTheAppCrashes() {
        EarlyCrashHandler(snapshot, makeWriter = { error("disk gone") }).install()

        crash()

        assertEquals(1, terminal.seen.size)
    }
}
