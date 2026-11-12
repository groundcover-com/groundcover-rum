package com.groundcover.rum.core.crash

import com.groundcover.rum.core.common.writeJsJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Crash records as the engine filed them, read off its disk: coerced at the trust boundary, never
// dropped but for a missing ack key.
class CrashRecordTest {
    @Test
    fun oneWithoutAnIdIsDroppedSinceItCouldNeverBeAcked() {
        val records = parseCrashRecords(
            writeJsJson(
                listOf(aRecord(id = "kept"), mapOf("errorType" to "NoId"), mapOf("id" to ""), "x")
            )
        )
        assertEquals(listOf("kept"), records.map { it.id })
    }

    @Test
    fun aMalformedFieldCostsWhatAMissingOneDoes() {
        val record = parseCrashRecords(
            writeJsJson(
                listOf(
                    aRecord(
                        crashEpochMs = "yesterday",
                        errorType = 7,
                        errorMessage = mapOf("a" to 1),
                        stacktrace = "frames",
                        metadata = "meta",
                        screen = mapOf("name" to "", "key" to "")
                    )
                )
            )
        ).single()
        assertNull(record.crashEpochMs)
        assertEquals("", record.errorType)
        assertEquals("", record.errorMessage)
        assertTrue(record.frames.isEmpty())
        assertTrue(record.metadata.isEmpty())
        // The engines' "couldn't read one" sentinel: the snapshot's applies.
        assertNull(record.screen)
    }

    @Test
    fun aCorruptCauseChainIsCappedAtItsHead() {
        val causes = List(40) { mapOf("type" to "E$it", "message" to "$it") }
        val record =
            parseCrashRecords(writeJsJson(listOf(aRecord(metadata = mapOf("causes" to causes)))))
                .single()
        val kept = record.metadata["causes"] as List<*>
        assertEquals(20, kept.size)
        assertEquals("E0", (kept.first() as Map<*, *>)["type"])
    }

    @Test
    fun unreadableJsonIsNoRecords() {
        assertTrue(parseCrashRecords("not json").isEmpty())
        assertTrue(parseCrashRecords("{\"id\": \"r1\"}").isEmpty())
    }

    @Test
    fun aFrameWithoutAFilenameIsDroppedAndTheRestFallBack() {
        val frames = stackFrames(
            listOf(
                mapOf("filename" to "A.kt", "function" to "f", "lineno" to 3, "colno" to 1),
                mapOf("function" to "nameless"),
                mapOf("filename" to "B.kt", "lineno" to "x")
            )
        )
        assertEquals(listOf("A.kt", "B.kt"), frames.map { it.filename })
        assertEquals("", frames.last().function)
        assertEquals(0, frames.last().lineno)
    }
}
