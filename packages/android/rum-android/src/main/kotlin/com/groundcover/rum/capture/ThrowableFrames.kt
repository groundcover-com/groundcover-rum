package com.groundcover.rum.capture

import com.groundcover.rum.core.events.ErrorFrame
import com.groundcover.rum.engine.crash.GcRumCrashRecordMapper

// A handled error is capped as the engine caps a crash, so the two read alike.

/**
 * [throwable]'s frames as the engine writes a crash's: `{filename: the class, function: the
 * method, lineno}`, column 0, and a native or unknown line 0. At most the engine's frame cap.
 */
internal fun throwableFrames(throwable: Throwable): List<ErrorFrame> =
    throwable.stackTrace.take(GcRumCrashRecordMapper.MAX_FRAMES).map { element ->
        ErrorFrame(
            filename = element.className,
            function = element.methodName,
            lineno = element.lineNumber.coerceAtLeast(0),
            colno = 0
        )
    }

/**
 * [throwable]'s cause chain as the engine writes a crash's `causes`: `{type: the class, message}`,
 * nearest first. A wrapper's real origin is usually several `caused by` levels down.
 */
internal fun throwableCauses(throwable: Throwable): List<Map<String, Any?>> {
    val causes = ArrayList<Map<String, Any?>>()
    var cause = throwable.cause
    while (cause != null && causes.size < GcRumCrashRecordMapper.MAX_CAUSE_DEPTH) {
        causes.add(
            mapOf(
                "type" to cause.javaClass.name,
                "message" to (cause.message ?: "").take(GcRumCrashRecordMapper.MAX_MESSAGE_CHARS)
            )
        )
        cause = cause.cause
    }
    return causes
}
