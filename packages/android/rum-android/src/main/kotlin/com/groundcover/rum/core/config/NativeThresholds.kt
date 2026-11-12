package com.groundcover.rum.core.config

// The defaults and clamps for NativeOptions. A value out of range falls back to the default rather
// than reaching the engine, where a nonsense threshold would arm a watchdog that fires constantly
// or never.

/**
 * The main-thread stall before a hang is reported. Higher than iOS's on purpose: Android's own ANR
 * threshold is 5 s, so reporting sooner would flag stalls the OS itself tolerates.
 */
internal const val DEFAULT_HANG_THRESHOLD_MS = 5_000L

/**
 * The longest a frame-vitals segment runs before it is closed anyway. A safety valve, not a
 * cadence: segments normally end on a screen change or on backgrounding.
 */
internal const val DEFAULT_VITALS_MAX_SEGMENT_MS = 60_000L

private val HANG_THRESHOLD_RANGE_MS = 250L..60_000L
private val VITALS_MAX_SEGMENT_RANGE_MS = 1_000L..300_000L

/** [NativeOptions.hangThresholdMs][com.groundcover.rum.NativeOptions.hangThresholdMs], resolved. */
internal fun resolveHangThresholdMs(ms: Long?): Long =
    ms?.takeIf { it in HANG_THRESHOLD_RANGE_MS } ?: DEFAULT_HANG_THRESHOLD_MS

/**
 * [NativeOptions.vitalsMaxSegmentMs][com.groundcover.rum.NativeOptions.vitalsMaxSegmentMs],
 * resolved.
 */
internal fun resolveVitalsMaxSegmentMs(ms: Long?): Long =
    ms?.takeIf { it in VITALS_MAX_SEGMENT_RANGE_MS } ?: DEFAULT_VITALS_MAX_SEGMENT_MS
