package com.groundcover.rum.engine

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The status JSON is read by JavaScript, and its key names are the contract.
 * Nothing off-device compares this encoder with the Swift one, so each side
 * pins its own keys and the TypeScript type is what holds them together.
 */
class GcRumEngineConfigTest {

    private fun encoded(status: GcRumEngineStatus): JSONObject =
        JSONObject(status.encodedJson())

    @Test
    fun `encodes the status keys JavaScript reads`() {
        val json = encoded(GcRumEngineStatus(crashes = true, gestures = true))

        assertTrue(json.getBoolean("crashes"))
        assertTrue(json.getBoolean("gestures"))
        assertFalse(json.getBoolean("hangs"))
        assertFalse(json.getBoolean("appStart"))
        assertFalse(json.getBoolean("vitals"))
    }

    /**
     * `gestures` and `gesturesAttached` are two different claims — created, versus hooked to a
     * window right now — and they must not collapse into one key. JS stands its own classifier
     * down on the second only: standing down on the first drops every gesture until the attach
     * lands, and forever if it never does.
     *
     * The key has to be present and false rather than omitted, because that is how a re-init says
     * "the tracker is gone" as opposed to saying nothing at all.
     */
    @Test
    fun `encodes gesturesAttached separately from gestures`() {
        val armedOnly = encoded(GcRumEngineStatus(gestures = true))
        assertTrue(armedOnly.getBoolean("gestures"))
        assertFalse(armedOnly.getBoolean("gesturesAttached"))

        val hooked = encoded(GcRumEngineStatus(gestures = true, gesturesAttached = true))
        assertTrue(hooked.getBoolean("gesturesAttached"))
    }

    /**
     * `crashes: false` alone has two meanings JS cannot tell apart: the host never asked, or it
     * asked and the handler could not be installed — on Android, a
     * `setDefaultUncaughtExceptionHandler` chain we refused to join. Correct behaviour, but on its
     * own it would leave apps reporting nothing with no explanation. The engine holds no logger by
     * design, so it reports the reason and JS warns.
     */
    @Test
    fun `carries the reason crash reporting is unavailable`() {
        val json = encoded(
            GcRumEngineStatus(crashesUnavailable = "another handler owns the chain")
        )

        assertEquals("another handler owns the chain", json.getString("crashesUnavailable"))
    }

    /**
     * Omitted, not null, when nothing is wrong — presence IS the signal on the
     * JS side, and a key that were always there would need null-checking at
     * every reader. Matches the Swift encoder, which omits a nil `String?`.
     */
    @Test
    fun `omits the reason entirely when crash reporting is healthy`() {
        val json = encoded(GcRumEngineStatus(crashes = true))

        assertFalse(json.has("crashesUnavailable"))
    }

    /**
     * The twin of `coercesLikeTheKotlinTwin` in GCRumEngineConfigTests.swift: the same
     * inputs must give the same answers, or one config arms different features depending
     * on which OS reads it. `optBoolean` and `optLong` coerce these string forms, and Swift
     * matches them, so these pin the shared behaviour and fail if a refactor tightens this side
     * alone.
     */
    @Test
    fun `coerces the string forms, matching the iOS twin`() {
        val flags = GcRumEngineConfig.decode(
            """{"features":{"hangs":"true","vitals":"TRUE","gestures":"nonsense"}}"""
        )
        assertTrue(flags.features.hangs)
        assertTrue(flags.features.vitals)
        assertFalse(flags.features.gestures)

        val numeric = GcRumEngineConfig.decode(
            """{"thresholds":{"hangThresholdMs":"3000","vitalsMaxSegmentMs":"12000"}}"""
        )
        assertEquals(3_000L, numeric.thresholds.hangThresholdMs)
        assertEquals(12_000L, numeric.thresholds.vitalsMaxSegmentMs)
    }

    /** A hang threshold of 0 or below reports every frame as a hang. */
    @Test
    fun `a threshold that is not a usable duration falls back rather than arming on it`() {
        listOf("0", "-1").forEach { value ->
            val config = GcRumEngineConfig.decode("""{"thresholds":{"hangThresholdMs":$value}}""")
            assertEquals("$value was armed", 5_000L, config.thresholds.hangThresholdMs)
        }
    }

    /**
     * `optString` COERCES: it would turn `42` into the envelope `"42"` here while iOS reads the
     * same config as "no snapshot". A snapshot that parses nowhere attributes a crash to nothing,
     * so both platforms take the strict contract.
     */
    @Test
    fun `a non-string snapshot is no snapshot, not a coerced one`() {
        assertNull(GcRumEngineConfig.decode("""{"snapshotJson":42}""").snapshotJson)
        assertNull(GcRumEngineConfig.decode("""{"snapshotJson":true}""").snapshotJson)
        assertNull(GcRumEngineConfig.decode("""{"snapshotJson":null}""").snapshotJson)
        assertEquals(
            """{"session_id":"s-1"}""",
            GcRumEngineConfig.decode("""{"snapshotJson":"{\"session_id\":\"s-1\"}"}""").snapshotJson
        )
    }

    /** The twin of `fractionalThresholdsTruncate`: `optLong` truncates, and Swift matches it. */
    @Test
    fun `truncates a fractional threshold, matching the iOS twin`() {
        val config = GcRumEngineConfig.decode(
            """{"thresholds":{"hangThresholdMs":2500.7,"vitalsMaxSegmentMs":12000.9}}"""
        )
        assertEquals(2_500L, config.thresholds.hangThresholdMs)
        assertEquals(12_000L, config.thresholds.vitalsMaxSegmentMs)

        val sub = GcRumEngineConfig.decode("""{"thresholds":{"hangThresholdMs":0.5}}""")
        assertEquals(5_000L, sub.thresholds.hangThresholdMs)
    }

    /**
     * THE version-skew case, and the reason `clearSnapshotAfterHarvest` is a boolean rather than
     * an "explicit JSON null in snapshotJson".
     *
     * A JS bundle older than this binary sends neither key. Defaulting to `true` — or reading a
     * missing `snapshotJson` as "clear" — would wipe the session envelope on every ordinary
     * SAMPLED launch, making every crash in that session unattributable. `false` is the only safe
     * default, and it has to be the one an ABSENT key produces.
     */
    @Test
    fun `an older JavaScript bundle never asks for a snapshot clear`() {
        val config = GcRumEngineConfig.decode("""{"features":{},"thresholds":{}}""")

        assertFalse(config.clearSnapshotAfterHarvest)
        assertEquals(null, config.snapshotJson)
    }

    @Test
    fun `decodes an explicit snapshot clear`() {
        val config = GcRumEngineConfig.decode(
            """{"features":{},"thresholds":{},"clearSnapshotAfterHarvest":true}"""
        )

        assertTrue(config.clearSnapshotAfterHarvest)
    }

    /**
     * Both keys together is a caller bug, but it must not decode into a state the engine has to
     * invent a rule for at runtime. Decoding keeps both; `GcRumEngine.start` is where the envelope
     * wins, and its Swift twin resolves it the same way.
     */
    @Test
    fun `keeps both the envelope and the clear flag when a caller sends both`() {
        val config = GcRumEngineConfig.decode(
            """{"features":{},"thresholds":{},"snapshotJson":"{}","clearSnapshotAfterHarvest":true}"""
        )

        assertEquals("{}", config.snapshotJson)
        assertTrue(config.clearSnapshotAfterHarvest)
    }
}
