package com.groundcover.rum.core.config

internal const val DEFAULT_SESSION_MAX_DURATION_MS = 4 * 60 * 60 * 1000L
internal const val MIN_SESSION_MAX_DURATION_MS = 60 * 1000L
internal const val MAX_SESSION_MAX_DURATION_MS = 8 * 60 * 60 * 1000L

/**
 * One idle window, two consumers: the lazy gap check rotates the session when user activity
 * resumes after a gap this long, and idle policies key off it.
 */
internal const val SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000L

/**
 * The activity clock is stamped on every user interaction and persisted at most this often. The
 * gap check runs at 30-minute resolution, so a value up to a minute stale across a restart is
 * harmless.
 */
internal const val ACTIVITY_PERSIST_THROTTLE_MS = 60 * 1000L

internal const val DEFAULT_SESSION_SAMPLE_RATE = 1.0
internal const val DEFAULT_BATCH_SIZE = 10
internal const val DEFAULT_BATCH_TIMEOUT_MS = 10_000L
internal const val DEFAULT_COMPRESSION = true
