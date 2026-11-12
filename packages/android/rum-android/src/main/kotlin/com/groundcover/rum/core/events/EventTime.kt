package com.groundcover.rum.core.events

import com.groundcover.rum.RumEvent

// Reading an event's own occurrence time back off the event. Only top-level fields count, and
// both must be read: a network event has a `startTimestamp` and no `timestamp`, every other event
// the reverse. Attributes are off limits: a navigation keeps a `start_timestamp` there in
// milliseconds, which read as nanoseconds lands in 1970.

/**
 * Whether [value] is a time to trust: inside (nowNs - maxAgeNs, nowNs].
 *
 * The window is what makes deriving session identity from event data safe. Legitimate backdating
 * is small (a rotation stamped from a second clock read, an in-flight network span); everything
 * untrustworthy is off by orders of magnitude (milliseconds where nanoseconds belong reads as
 * 1970, and 0 means unset). Both bounds come from the same clock read as [nowNs], so a uniformly
 * wrong device clock shifts them together. The lower bound is strict: at exactly one idle window
 * back the inactivity check already reads stale.
 */
internal fun isTrustedEventTime(value: Long?, nowNs: Long, maxAgeNs: Long): Boolean =
    value != null && value > 0 && value <= nowNs && value > nowNs - maxAgeNs

/** The earliest trusted occurrence time across [events], or null. */
internal fun earliestTrustedEventTime(events: List<RumEvent?>, nowNs: Long, maxAgeNs: Long): Long? {
    var earliest: Long? = null
    for (event in events) {
        if (event == null) continue
        for (value in listOf(event.timestamp, event.startTimestamp)) {
            if (isTrustedEventTime(value, nowNs, maxAgeNs) &&
                (earliest == null || value!! < earliest)
            ) {
                earliest = value
            }
        }
    }
    return earliest
}
