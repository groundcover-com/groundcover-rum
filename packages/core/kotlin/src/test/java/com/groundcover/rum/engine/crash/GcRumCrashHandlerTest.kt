package com.groundcover.rum.engine.crash

import com.facebook.react.common.JavascriptException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The handler CHAIN — the part of crash capture that can break the app rather than merely
 * lose a report. The platform's default handler shows the dialog and kills the process, so
 * everything here is about staying a link that reaches it and never becoming the end: an app
 * that crashes into a dead end is worse than one with no crash reporting.
 *
 * These mutate process-global state, so the real default is saved and restored around each.
 */
class GcRumCrashHandlerTest {

    @get:Rule
    val temp = TemporaryFolder()

    private var hostDefault: Thread.UncaughtExceptionHandler? = null

    @Before
    fun rememberHostDefault() {
        hostDefault = Thread.getDefaultUncaughtExceptionHandler()
    }

    @After
    fun restoreHostDefault() {
        Thread.setDefaultUncaughtExceptionHandler(hostDefault)
    }

    /** Stands in for the platform handler at the end of the chain. */
    private class Terminal : Thread.UncaughtExceptionHandler {
        val seen = mutableListOf<Throwable>()
        override fun uncaughtException(thread: Thread, throwable: Throwable) {
            seen.add(throwable)
        }
    }

    /**
     * Another crash SDK installing AFTER us and chaining onto whatever it found —
     * which is what other JVM crash reporters typically do, and the only reason the
     * "somebody chained onto us" branch is reachable at all.
     */
    private class Chaining(private val next: Thread.UncaughtExceptionHandler?) :
        Thread.UncaughtExceptionHandler {
        override fun uncaughtException(thread: Thread, throwable: Throwable) {
            next?.uncaughtException(thread, throwable)
        }
    }

    private fun newStore() = GcRumSnapshotStore(temp.newFolder())

    // region Install outcome

    /**
     * [GcRumCrashHandler.install] refuses to chain onto ANOTHER GcRumCrashHandler, which
     * would recurse on a crash — reachable for real, since a destroyed React instance whose
     * `uninstall` could not unhook leaves its handler as the default. A silent refusal
     * would let the engine report `crashes = true` from a bare `runCatching` while every
     * crash went to a released engine's store, so the install has to SAY whether it armed.
     */
    @Test
    fun `install reports success when it takes the chain`() {
        Thread.setDefaultUncaughtExceptionHandler(Terminal())

        val armed = GcRumCrashHandler(newStore()).install()

        assertTrue(armed)
    }

    @Test
    fun `re-arming the same handler still reports success`() {
        Thread.setDefaultUncaughtExceptionHandler(Terminal())
        val handler = GcRumCrashHandler(newStore())
        handler.install()

        // A second nativeInit — RN fast-refresh re-initializes in place — is the
        // same engine asking again, and it IS recording.
        assertTrue(handler.install())
    }

    @Test
    fun `install reports failure when a stranded GcRum handler owns the chain`() {
        Thread.setDefaultUncaughtExceptionHandler(Terminal())
        // A previous engine's handler that outlived its release().
        GcRumCrashHandler(newStore()).install()

        val armed = GcRumCrashHandler(newStore()).install()

        assertFalse(armed)
    }

    /**
     * Chaining onto a FOREIGN handler is the normal, supported case on Android —
     * unlike iOS, where KSCrash is a process-wide singleton somebody else may
     * own. This must keep reporting success, or the SDK would warn about
     * another crash reporter's perfectly healthy install.
     */
    @Test
    fun `install reports success when chaining onto another SDK`() {
        Thread.setDefaultUncaughtExceptionHandler(Chaining(Terminal()))

        assertTrue(GcRumCrashHandler(newStore()).install())
    }

    // endregion

    private fun crash(throwable: Throwable) {
        Thread.getDefaultUncaughtExceptionHandler()!!
            .uncaughtException(Thread.currentThread(), throwable)
    }

    @Test
    fun `while installed a crash is recorded and still reaches the platform handler`() {
        val platform = Terminal()
        Thread.setDefaultUncaughtExceptionHandler(platform)
        val store = newStore()
        GcRumCrashHandler(store).install()

        val boom = IllegalStateException("boom")
        crash(boom)

        assertEquals(1, store.readPendingRecords().size)
        assertEquals(listOf<Throwable>(boom), platform.seen)
    }

    @Test
    fun `uninstalling when nobody chained onto us hands the host its handler back`() {
        val platform = Terminal()
        Thread.setDefaultUncaughtExceptionHandler(platform)
        val handler = GcRumCrashHandler(newStore())

        handler.install()
        assertSame(handler, Thread.getDefaultUncaughtExceptionHandler())

        handler.uninstall()
        assertSame(platform, Thread.getDefaultUncaughtExceptionHandler())
    }

    /**
     * The chain must survive an uninstall we could not complete. `uninstall()` rightly
     * refuses to restore when it is no longer the default — cutting the other SDK out would
     * be worse — but we are still IN the chain and still called, so dropping `previous`
     * makes us the end of it and the platform handler is never reached. Happens on engine
     * release, i.e. every full React reload.
     */
    @Test
    fun `uninstalling while another SDK is chained onto us keeps the chain intact`() {
        val platform = Terminal()
        Thread.setDefaultUncaughtExceptionHandler(platform)

        val handler = GcRumCrashHandler(newStore())
        handler.install()

        Thread.setDefaultUncaughtExceptionHandler(
            Chaining(Thread.getDefaultUncaughtExceptionHandler())
        )

        handler.uninstall()

        val boom = IllegalStateException("boom")
        crash(boom)

        assertEquals(
            "the platform handler must still be reached through us — it is what kills the process",
            listOf<Throwable>(boom),
            platform.seen,
        )
    }

    /**
     * …and having stayed in the chain, we must stop WRITING.
     *
     * The store belongs to a released engine. Records written to it carry
     * whatever snapshot that engine last held — or none — so the drainer discards
     * them, but they still count against MAX_PENDING_RECORDS and evict real crash
     * reports that were waiting for a working network.
     */
    @Test
    fun `a crash after uninstall is delegated but no longer recorded`() {
        val platform = Terminal()
        Thread.setDefaultUncaughtExceptionHandler(platform)

        val store = newStore()
        val handler = GcRumCrashHandler(store)
        handler.install()

        Thread.setDefaultUncaughtExceptionHandler(
            Chaining(Thread.getDefaultUncaughtExceptionHandler())
        )
        handler.uninstall()

        crash(IllegalStateException("after release"))

        assertEquals(
            "a released engine's store must not keep taking records",
            0,
            store.readPendingRecords().size,
        )
    }

    /**
     * Non-vacuous control for the two tests above: the same arrangement, WITHOUT
     * the uninstall, does record. Without this, a handler that never recorded
     * anything at all would satisfy them both.
     */
    @Test
    fun `the same chained arrangement still records while installed`() {
        val platform = Terminal()
        Thread.setDefaultUncaughtExceptionHandler(platform)

        val store = newStore()
        GcRumCrashHandler(store).install()
        Thread.setDefaultUncaughtExceptionHandler(
            Chaining(Thread.getDefaultUncaughtExceptionHandler())
        )

        crash(IllegalStateException("still armed"))

        assertEquals(1, store.readPendingRecords().size)
        assertEquals(1, platform.seen.size)
    }

    /**
     * A JS fatal already shipped from JavaScript with a source-mapped stack;
     * recording React Native's native rethrow would double-report it with a worse
     * one. It must still be delegated, though — RN's own handler is what turns it
     * into a redbox or a process kill.
     */
    @Test
    fun `a React Native JS fatal is delegated but not recorded`() {
        val platform = Terminal()
        Thread.setDefaultUncaughtExceptionHandler(platform)
        val store = newStore()
        GcRumCrashHandler(store).install()

        crash(JavascriptException("already reported from JS"))

        assertEquals(0, store.readPendingRecords().size)
        assertEquals(1, platform.seen.size)
    }

    /**
     * THE FILE'S OPENING PROMISE, under the one condition that can break it: "the previous handler
     * is always invoked in a `finally`, so our recording can never swallow a crash."
     *
     * `uninstall()` runs on RN's native-modules thread during React-instance teardown, and a crash
     * can be on any other thread. That other thread is inside `record()` — a temp write plus an
     * **fsync** — so the gap between entering `uncaughtException` and reading the delegate in the
     * `finally` is bounded by a disk sync, not by a few instructions. Were the delegate read after
     * that gap, nulling the field inside it would mean the platform handler never runs: no dialog,
     * no process death, an app left hanging on a crash it should have died from. A crash during
     * teardown is explicitly in scope — `stop()` deliberately leaves the handler armed for exactly
     * that case.
     *
     * Deterministic rather than a race the test hopes to lose: the store's `renameFile` seam holds
     * the crashing thread inside the write until `uninstall()` has returned.
     */
    @Test
    fun `a crash still reaches the platform handler when the engine is released mid-write`() {
        val enteredWrite = CountDownLatch(1)
        val uninstalled = CountDownLatch(1)
        val store = GcRumSnapshotStore(
            temp.newFolder(),
            renameFile = { source: File, dest: File ->
                enteredWrite.countDown()
                uninstalled.await(5, TimeUnit.SECONDS)
                source.renameTo(dest)
            },
        )
        val platform = Terminal()
        Thread.setDefaultUncaughtExceptionHandler(platform)

        val handler = GcRumCrashHandler(store)
        assertTrue(handler.install())

        val boom = RuntimeException("boom")
        val escaped = AtomicReference<Throwable?>(null)
        val crashing = Thread {
            runCatching { handler.uncaughtException(Thread.currentThread(), boom) }
                .onFailure { escaped.set(it) }
        }
        crashing.start()

        assertTrue("the crashing thread never reached the write", enteredWrite.await(5, TimeUnit.SECONDS))
        handler.uninstall()
        uninstalled.countDown()
        crashing.join(5_000)

        assertNull("recording threw instead of delegating", escaped.get())
        assertEquals(listOf<Throwable>(boom), platform.seen)
    }
}
