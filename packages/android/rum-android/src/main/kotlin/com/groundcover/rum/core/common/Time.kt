package com.groundcover.rum.core.common

import kotlin.math.floor
import kotlin.math.roundToLong

/**
 * The SDK's clock: epoch milliseconds. Injected wherever a time is read, so tests run on a fixed
 * one.
 */
internal typealias RumClock = () -> Long

internal val systemClock: RumClock = { System.currentTimeMillis() }

internal const val MS_TO_NANOSECONDS = 1_000_000L

/**
 * Epoch milliseconds to nanoseconds, the wire's unit, as exact 64-bit integers: a double steps in
 * 256 ns near 1.8e18.
 */
internal fun msToNs(ms: Long): Long = ms * MS_TO_NANOSECONDS

/** Nanoseconds back to milliseconds, the fraction dropped. */
internal fun nsToMs(ns: Long): Long = ns / MS_TO_NANOSECONDS

/**
 * [msToNs] for a time with a fractional part, as the engine reports some. The whole milliseconds
 * convert exactly; only the fraction goes through a double, so the result is off by under a
 * nanosecond rather than by the 256 ns a double steps in at today's epoch.
 */
internal fun fractionalMsToNs(ms: Double): Long {
    val whole = floor(ms)
    return msToNs(whole.toLong()) + ((ms - whole) * MS_TO_NANOSECONDS).roundToLong()
}
