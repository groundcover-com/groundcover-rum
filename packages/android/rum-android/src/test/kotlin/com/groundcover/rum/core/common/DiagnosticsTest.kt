package com.groundcover.rum.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticsTest {
    @Test
    fun logIsSilentUnlessDebugIsOnAndCarriesThePrefix() {
        val lines = mutableListOf<String>()
        val diagnostics = RumDiagnostics(sink = { lines.add(it) })
        diagnostics.log("before")
        diagnostics.configure(debug = true)
        diagnostics.log("after", 42)
        assertEquals(1, lines.size)
        assertTrue(lines.single().contains("[groundcover] after 42"))
    }

    @Test
    fun warnIsWrittenWhateverTheDebugSetting() {
        val lines = mutableListOf<String>()
        val diagnostics = RumDiagnostics(sink = { lines.add(it) })
        diagnostics.warn("[groundcover] sessionMaxDuration out of range")
        assertEquals(listOf("[groundcover] sessionMaxDuration out of range"), lines)
    }

    @Test
    fun aSinkThatThrowsNeverReachesTheCaller() {
        val diagnostics = RumDiagnostics(sink = { throw IllegalStateException("sink down") })
        diagnostics.configure(debug = true)
        diagnostics.log("line")
        diagnostics.warn("line")
    }

    @Test
    fun aLineWrittenFromInsideTheSinkIsDropped() {
        // An app that routes what the SDK prints back into the SDK's logger would otherwise make
        // each line write another, without end.
        val lines = mutableListOf<String>()
        lateinit var diagnostics: RumDiagnostics
        diagnostics = RumDiagnostics(sink = { line ->
            lines.add(line)
            diagnostics.warn("echo of $line")
        })
        diagnostics.warn("first")
        assertEquals(listOf("first"), lines)
    }
}
