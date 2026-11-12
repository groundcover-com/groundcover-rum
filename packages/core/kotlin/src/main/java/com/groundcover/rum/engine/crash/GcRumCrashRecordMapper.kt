package com.groundcover.rum.engine.crash

import org.json.JSONArray
import org.json.JSONObject

/**
 * Turns a Throwable into the JSON record the JS drainer reads.
 *
 * Pure and dependency-free on purpose: this is the piece most likely to break
 * silently (a renamed field surfaces only as a missing attribute on a crash
 * nobody is watching), so it is unit-testable on the JVM with no emulator.
 */
internal object GcRumCrashRecordMapper {
    /** Guards against a pathological cause chain or a synthetic stack. */
    const val MAX_FRAMES = 200

    /** The longest message kept, a cause's included. */
    const val MAX_MESSAGE_CHARS = 2_000

    /** The most causes a crash carries, as a handled error does; it also ends a cyclic chain. */
    const val MAX_CAUSE_DEPTH = 5

    /**
     * React Native rethrows an unhandled JS error natively in release builds. The
     * JS layer already reported it with a readable, source-mapped stack, so
     * recording it again here would double-report every JS fatal with a worse
     * stack.
     */
    fun isReactNativeJsFatal(throwable: Throwable): Boolean {
        var current: Throwable? = throwable
        var depth = 0
        while (current != null && depth < MAX_CAUSE_DEPTH) {
            val name = current.javaClass.name
            if (name.startsWith("com.facebook.react") && name.contains("JavascriptException")) {
                return true
            }
            current = current.cause
            depth++
        }
        return false
    }

    fun buildRecord(
        id: String,
        crashEpochMs: Long,
        throwable: Throwable,
        threadName: String,
        sessionSnapshotJson: String?,
        crashSource: String = "jvm_handler",
    ): String {
        val root = JSONObject()
        root.put("id", id)
        root.put("crashEpochMs", crashEpochMs)
        root.put("errorType", throwable.javaClass.name)
        root.put("errorMessage", truncate(throwable.message ?: throwable.javaClass.simpleName))
        root.put("stacktrace", buildStacktrace(throwable))
        root.put("metadata", buildMetadata(throwable, threadName, crashSource))
        // Kept as a STRING, not a nested object: JS parses it back out, and
        // re-encoding a snapshot we never inspect would only risk mangling it.
        if (sessionSnapshotJson != null) {
            root.put("sessionSnapshotJson", sessionSnapshotJson)
        } else {
            root.put("sessionSnapshotJson", JSONObject.NULL)
        }
        root.put("screen", GcRumScreenSnapshot.screenFrom(sessionSnapshotJson))
        return root.toString()
    }

    /** Frames in `{filename, function, lineno, colno}` — the same shape the JS
     *  error listener produces, so native and JS fatals render identically. */
    private fun buildStacktrace(throwable: Throwable): JSONArray {
        val frames = JSONArray()
        throwable.stackTrace.take(MAX_FRAMES).forEach { element ->
            frames.put(
                JSONObject()
                    .put("filename", element.className)
                    .put("function", element.methodName)
                    // Negative line numbers mean "native method" / "unknown" in
                    // the JVM; normalize to 0 like an unsymbolicated frame.
                    .put("lineno", element.lineNumber.coerceAtLeast(0))
                    .put("colno", 0)
            )
        }
        return frames
    }

    private fun buildMetadata(
        throwable: Throwable,
        threadName: String,
        crashSource: String,
    ): JSONObject {
        val metadata = JSONObject()
            .put("native", true)
            .put("fatal", true)
            .put("crash_source", crashSource)
            .put("thread_name", threadName)

        // The cause chain, flattened: a crash's real origin is usually several
        // `caused by` levels down, and the frames above only show the wrapper.
        val causes = JSONArray()
        var cause = throwable.cause
        var depth = 0
        while (cause != null && depth < MAX_CAUSE_DEPTH) {
            causes.put(
                JSONObject()
                    .put("type", cause.javaClass.name)
                    .put("message", truncate(cause.message ?: ""))
            )
            cause = cause.cause
            depth++
        }
        if (causes.length() > 0) metadata.put("causes", causes)

        return metadata
    }

    private fun truncate(text: String): String =
        if (text.length <= MAX_MESSAGE_CHARS) text else text.take(MAX_MESSAGE_CHARS)
}
