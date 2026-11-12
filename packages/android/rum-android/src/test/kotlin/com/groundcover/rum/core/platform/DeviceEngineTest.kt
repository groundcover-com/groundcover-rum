package com.groundcover.rum.core.platform

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.core.nativeengine.NativeEngineStatus
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The engine's crash handler is installed on its own thread after start has returned; the device
// engine covers the gap with an early handler. The engine's work is held back here, so the gap is
// as wide as the test wants. These change the process-wide default handler, restored around each.
@RunWith(RobolectricTestRunner::class)
class DeviceEngineTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val held = mutableListOf<Runnable>()
    private val engine = DeviceEngine(app) { work -> held.add(work) }
    private val snapshot = """{"session_id":"s-now","screen":{"name":"","key":""}}"""
    private val pendingDir = File(app.noBackupFilesDir, "groundcover-rum/pending")
    private val terminal = Terminal()
    private var hostDefault: Thread.UncaughtExceptionHandler? = null

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
        pendingDir.deleteRecursively()
    }

    @After
    fun restoreHostDefault() {
        engine.stop()
        runHeld()
        Thread.setDefaultUncaughtExceptionHandler(hostDefault)
    }

    private fun runHeld() {
        while (held.isNotEmpty()) held.removeAt(0).run()
    }

    private fun config(crashes: Boolean) =
        """{"features":{"crashes":$crashes},"snapshotJson":${JSONObject.quote(snapshot)}}"""

    private fun crash(message: String) {
        Thread.getDefaultUncaughtExceptionHandler()!!
            .uncaughtException(Thread.currentThread(), IllegalStateException(message))
    }

    private fun records() = pendingDir.listFiles { file -> file.name.endsWith(".json") }
        .orEmpty()
        .map { JSONObject(it.readText()) }

    @Test
    fun aCrashBeforeTheEngineIsBuiltIsRecordedUnderThisRunsSession() {
        engine.start(config(crashes = true)) {}

        crash("in onCreate, right after start")

        val record = records().single()
        assertEquals("in onCreate, right after start", record.getString("errorMessage"))
        assertEquals(snapshot, record.getString("sessionSnapshotJson"))
        assertEquals(1, terminal.seen.size)
    }

    @Test
    fun onceTheEngineHasStartedItsHandlerAloneRecords() {
        var status: NativeEngineStatus? = null
        engine.start(config(crashes = true)) { status = it }
        runHeld()
        assertTrue(status!!.crashes)

        crash("later")

        assertEquals(listOf("later"), records().map { it.getString("errorMessage") })
        assertEquals(1, terminal.seen.size)
    }

    @Test
    fun withCrashCaptureOffNothingIsInstalled() {
        engine.start(config(crashes = false)) {}

        assertSame(terminal, Thread.getDefaultUncaughtExceptionHandler())
    }
}
