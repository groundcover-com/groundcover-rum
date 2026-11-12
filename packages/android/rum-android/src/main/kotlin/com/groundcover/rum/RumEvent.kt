package com.groundcover.rum

/**
 * One captured event, as [BeforeSend] and [EnrichEvent] see it.
 *
 * The [attributes] are dot-flattened before the hooks run, so a tap's
 * `interaction_target: {label}` arrives as `"interaction_target.label"`. The one nested attribute
 * is `screen`, added after flattening. Timestamps are nanoseconds since the epoch.
 *
 * An `enrichEvent` hook may change anything here except [type] and [id], and returns the event:
 * this one or a new one.
 */
class RumEvent
@JvmOverloads
constructor(
    /** `interaction`, `network`, `log`, `navigation`, `custom`, `exception` or `performance`. */
    val type: String,
    val id: String,
    var spanId: String,
    var parentSpanId: String? = null,
    var traceId: String? = null,
    var timestamp: Long? = null,
    /** A network event is a span: it has these instead of [timestamp]. */
    var startTimestamp: Long? = null,
    var endTimestamp: Long? = null,
    /** `"METHOD path"`, on network events only. */
    var spanName: String? = null,
    var attributes: MutableMap<String, Any?> = mutableMapOf()
)
