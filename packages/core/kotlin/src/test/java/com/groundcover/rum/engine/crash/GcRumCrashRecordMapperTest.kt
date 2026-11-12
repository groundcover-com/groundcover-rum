package com.groundcover.rum.engine.crash

import com.facebook.react.common.JavascriptException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The record shape is the contract with the JS drainer, and a drift in it shows
 * up only as a missing attribute on a crash nobody is watching. These run on the
 * JVM with no emulator, so they can gate every build.
 */
class GcRumCrashRecordMapperTest {

    private val snapshot = """{"session_id":"s-1","screen":{"name":"Checkout","key":"Checkout-1"}}"""

    private fun buildRecord(
        throwable: Throwable,
        sessionSnapshotJson: String? = snapshot,
    ): JSONObject = JSONObject(
        GcRumCrashRecordMapper.buildRecord(
            id = "crash-1",
            crashEpochMs = 1_700_000_123_456,
            throwable = throwable,
            threadName = "main",
            sessionSnapshotJson = sessionSnapshotJson,
        )
    )

    private fun throwableWithStack(): Throwable {
        val error = IllegalStateException("checkout totals went negative")
        error.stackTrace = arrayOf(
            StackTraceElement("com.acme.shop.Checkout", "computeTotals", "Checkout.kt", 142),
            StackTraceElement("com.acme.shop.Cart", "onPay", "Cart.kt", 88),
        )
        return error
    }

    @Test
    fun `maps the fields the JS drainer reads`() {
        val record = buildRecord(throwableWithStack())

        assertEquals("crash-1", record.getString("id"))
        assertEquals(1_700_000_123_456, record.getLong("crashEpochMs"))
        assertEquals("java.lang.IllegalStateException", record.getString("errorType"))
        assertEquals("checkout totals went negative", record.getString("errorMessage"))
        assertEquals(snapshot, record.getString("sessionSnapshotJson"))
    }

    @Test
    fun `stack frames use the shape JS errors already produce`() {
        val frames = buildRecord(throwableWithStack()).getJSONArray("stacktrace")

        assertEquals(2, frames.length())
        val first = frames.getJSONObject(0)
        assertEquals("com.acme.shop.Checkout", first.getString("filename"))
        assertEquals("computeTotals", first.getString("function"))
        assertEquals(142, first.getInt("lineno"))
        assertEquals(0, first.getInt("colno"))
    }

    @Test
    fun `normalizes the JVM's negative line numbers for native and unknown frames`() {
        val error = RuntimeException("boom")
        // -2 is the JVM's marker for a native method; a negative line would be
        // nonsense to a backend expecting a source position.
        error.stackTrace = arrayOf(StackTraceElement("android.os.MessageQueue", "nativePollOnce", null, -2))

        val frame = buildRecord(error).getJSONArray("stacktrace").getJSONObject(0)

        assertEquals(0, frame.getInt("lineno"))
    }

    @Test
    fun `caps the frame count so a pathological stack cannot bloat the record`() {
        val error = RuntimeException("deep")
        error.stackTrace = Array(GcRumCrashRecordMapper.MAX_FRAMES + 50) {
            StackTraceElement("com.acme.Deep", "recurse", "Deep.kt", it)
        }

        val frames = buildRecord(error).getJSONArray("stacktrace")

        assertEquals(GcRumCrashRecordMapper.MAX_FRAMES, frames.length())
    }

    @Test
    fun `flattens the cause chain, where the real origin usually is`() {
        val root = IllegalArgumentException("negative quantity")
        val wrapper = RuntimeException("failed to check out", root)

        val causes = buildRecord(wrapper).getJSONObject("metadata").getJSONArray("causes")

        assertEquals(1, causes.length())
        assertEquals("java.lang.IllegalArgumentException", causes.getJSONObject(0).getString("type"))
        assertEquals("negative quantity", causes.getJSONObject(0).getString("message"))
    }

    @Test
    fun `stamps the native markers on the record`() {
        val metadata = buildRecord(throwableWithStack()).getJSONObject("metadata")

        assertTrue(metadata.getBoolean("native"))
        assertTrue(metadata.getBoolean("fatal"))
        assertEquals("jvm_handler", metadata.getString("crash_source"))
        assertEquals("main", metadata.getString("thread_name"))
    }

    @Test
    fun `lifts the screen out of the snapshot so the drainer need not unpack it twice`() {
        val screen = buildRecord(throwableWithStack()).getJSONObject("screen")

        assertEquals("Checkout", screen.getString("name"))
        assertEquals("Checkout-1", screen.getString("key"))
    }

    @Test
    fun `falls back to an empty screen when there is no snapshot`() {
        val record = buildRecord(throwableWithStack(), sessionSnapshotJson = null)

        assertEquals("", record.getJSONObject("screen").getString("name"))
        assertTrue(record.isNull("sessionSnapshotJson"))
    }

    @Test
    fun `falls back to an empty screen rather than throwing on a corrupt snapshot`() {
        val record = buildRecord(throwableWithStack(), sessionSnapshotJson = "{not json")

        assertEquals("", record.getJSONObject("screen").getString("name"))
    }

    @Test
    fun `uses the class name when a throwable carries no message`() {
        val record = buildRecord(NullPointerException())

        assertEquals("NullPointerException", record.getString("errorMessage"))
    }

    @Test
    fun `recognizes React Native's rethrow of a JS fatal, directly or wrapped`() {
        // The JS layer already reported this one with a source-mapped stack;
        // recording the native rethrow would double-report it with a worse one.
        val jsFatal = JavascriptException("Unexpected token")

        assertTrue(GcRumCrashRecordMapper.isReactNativeJsFatal(jsFatal))
        assertTrue(GcRumCrashRecordMapper.isReactNativeJsFatal(RuntimeException("wrapped", jsFatal)))
    }

    @Test
    fun `treats an ordinary JVM crash as reportable`() {
        assertFalse(GcRumCrashRecordMapper.isReactNativeJsFatal(IllegalStateException("ordinary")))
        // A same-named class from another package is not RN's.
        assertFalse(GcRumCrashRecordMapper.isReactNativeJsFatal(LookalikeJavascriptException()))
    }

    @Test
    fun `truncates an enormous message`() {
        val record = buildRecord(RuntimeException("x".repeat(10_000)))

        assertEquals(2_000, record.getString("errorMessage").length)
    }

    @Test
    fun `omits the causes array entirely when there is no cause`() {
        val metadata = buildRecord(RuntimeException("standalone")).getJSONObject("metadata")

        assertNull(metadata.optJSONArray("causes"))
    }
}

/** Same class name, different package — must NOT be mistaken for RN's. */
private class LookalikeJavascriptException : RuntimeException("lookalike")
