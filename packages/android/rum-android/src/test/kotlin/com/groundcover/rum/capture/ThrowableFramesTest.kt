package com.groundcover.rum.capture

import java.io.IOException
import java.util.concurrent.ExecutionException
import org.junit.Assert.assertEquals
import org.junit.Test

class ThrowableFramesTest {
    @Test
    fun eachFrameIsItsClassMethodAndLine() {
        val error = IllegalStateException("declined").apply {
            stackTrace = arrayOf(
                StackTraceElement("com.example.Pay", "charge", "Pay.kt", 42),
                StackTraceElement("java.lang.Thread", "sleep", null, -2)
            )
        }
        assertEquals(
            listOf(
                mapOf(
                    "filename" to "com.example.Pay",
                    "function" to "charge",
                    "lineno" to 42,
                    "colno" to 0
                ),
                // A native method's line is -2, an unknown one's -1: both are 0, unsymbolicated.
                mapOf(
                    "filename" to "java.lang.Thread",
                    "function" to "sleep",
                    "lineno" to 0,
                    "colno" to 0
                )
            ),
            throwableFrames(error).map { it.toJson() }
        )
    }

    @Test
    fun atMost200FramesAreKept() {
        val error = RuntimeException().apply {
            stackTrace = Array(300) { StackTraceElement("C", "m$it", null, it) }
        }
        val frames = throwableFrames(error)
        assertEquals(200, frames.size)
        assertEquals("m0", frames.first().function)
    }

    @Test
    fun theCausesAreTheChainBelowNearestFirst() {
        val error = RuntimeException(
            "wrapped",
            ExecutionException("task failed", IOException(null as String?))
        )
        assertEquals(
            listOf(
                mapOf(
                    "type" to "java.util.concurrent.ExecutionException",
                    "message" to "task failed"
                ),
                mapOf("type" to "java.io.IOException", "message" to "")
            ),
            throwableCauses(error)
        )
        assertEquals(emptyList<Any>(), throwableCauses(RuntimeException("alone")))
    }

    @Test
    fun atMost5CausesSoACyclicChainEnds() {
        var deep: Throwable = IllegalStateException("root")
        repeat(9) { deep = RuntimeException("level $it", deep) }
        val causes = throwableCauses(RuntimeException("top", deep))
        assertEquals(5, causes.size)
        assertEquals("level 8", causes.first()["message"])

        // Throwable refuses itself as a cause, but a subclass can still return one.
        class SelfCaused : RuntimeException("again") {
            override val cause: Throwable get() = this
        }
        assertEquals(5, throwableCauses(SelfCaused()).size)
    }
}
