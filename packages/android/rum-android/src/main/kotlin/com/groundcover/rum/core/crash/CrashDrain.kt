package com.groundcover.rum.core.crash

import com.groundcover.rum.RedactKind
import com.groundcover.rum.RumEvent
import com.groundcover.rum.core.common.IdGenerator
import com.groundcover.rum.core.common.RumClock
import com.groundcover.rum.core.common.UserHook
import com.groundcover.rum.core.common.fractionalMsToNs
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.parseOrderedJson
import com.groundcover.rum.core.common.truncate
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.events.EnrichInput
import com.groundcover.rum.core.events.EventEnricher
import com.groundcover.rum.core.events.copyRumEvent
import com.groundcover.rum.core.events.redactingCauseMessages
import com.groundcover.rum.core.events.wireJson
import com.groundcover.rum.core.privacy.EffectivePrivacy
import com.groundcover.rum.core.privacy.redactObject
import com.groundcover.rum.core.privacy.redactOptions
import com.groundcover.rum.core.privacy.redactText
import com.groundcover.rum.core.transport.Batch
import com.groundcover.rum.core.transport.Transporter

// Reports crashes that killed a previous run. A crashed session is over, and its envelope isn't
// the one this run would stamp, so the drain bypasses the events pool and sends each record as a
// batch of its own, under the snapshot the engine filed at crash time. The current session never
// touches these.
//
// At least once: the engine keeps a record until its batch is delivered, and `crash_report_id` is
// stable across redeliveries, so a duplicate can be recognised. Losing a fatal is far worse than
// reporting it twice.

/**
 * Delivers every pending crash record, one at a time, acking each one delivered or
 * unsalvageable; [completion] runs once the pass is over. A record that wasn't delivered stays for
 * the next launch.
 */
internal fun drainCrashReports(
    store: CrashStore,
    config: ConfigManager,
    ids: IdGenerator,
    clock: RumClock,
    transporter: Transporter,
    completion: () -> Unit
) {
    val records = try {
        parseCrashRecords(store.pendingCrashReportsJson())
    } catch (error: Exception) {
        handleError(error)
        emptyList()
    }

    fun report(index: Int) {
        if (index >= records.size) {
            completion()
            return
        }
        val record = records[index]
        val acked = { ack: Boolean ->
            if (ack) {
                try {
                    store.clearPendingCrashReports(listOf(record.id))
                } catch (error: Exception) {
                    handleError(error)
                }
            }
            report(index + 1)
        }
        try {
            reportOne(record, config, ids, clock, transporter, acked)
        } catch (error: Exception) {
            // Left un-acked: the next launch gets another attempt. Caught per record, so one
            // failure doesn't abandon the records behind it.
            handleError(error)
            report(index + 1)
        }
    }
    report(0)
}

/** Whether to ack [record]: delivered, or unsalvageable. */
private fun reportOne(
    record: CrashRecord,
    config: ConfigManager,
    ids: IdGenerator,
    clock: RumClock,
    transporter: Transporter,
    ack: (Boolean) -> Unit
) {
    // No envelope means no session to file it under. Sending it under the current session would be
    // worse than dropping it: it would put another session's fatal into an unrelated one.
    val snapshot = snapshotOf(record.sessionSnapshotJson) ?: return ack(true)
    val snapshotScreen = crashScreen(snapshot.remove("screen"))
    val screen = record.screen ?: snapshotScreen ?: CrashScreen("", "")

    val enricher = EventEnricher(
        idGenerator = ids,
        clock = clock,
        platformAttributes = {
            mapOf("screen" to mapOf("name" to screen.name, "key" to screen.key))
        }
    )
    val built = enricher.enrich(
        EnrichInput(
            type = "exception",
            attributes = attributesOf(record, config.privacy),
            // When it crashed, not when it was reported.
            timestamp = record.crashEpochMs?.let(::fractionalMsToNs)
        )
    )

    // The pool runs these on addEvent; this path bypasses the pool, so it runs them itself. A
    // throwing beforeSend is unsalvageable: whether the app wanted the event is unknown, so it is
    // acked rather than retried forever. A false one is the app's choice, acked too. A throwing
    // enrichEvent costs only what it would have added: the hook gets a copy, so a throw after
    // changing it leaves the report as built.
    val options = config.config.options
    options.beforeSend?.let { beforeSend ->
        val keep = try {
            UserHook.run { beforeSend.shouldSend(built) }
        } catch (error: Exception) {
            handleError(error)
            return ack(true)
        }
        if (!keep) return ack(true)
    }
    var event: RumEvent = built
    options.enrichEvent?.let { enrichEvent ->
        event = try {
            // A Java hook can return null, which the type can't express: the report stays as built.
            UserHook.run { enrichEvent.enrich(copyRumEvent(built)) as RumEvent? } ?: built
        } catch (error: Exception) {
            handleError(error)
            built
        }
    }

    // The crashed session's envelope, verbatim: never the current one's.
    transporter.deliver(Batch(snapshot, listOf(event.wireJson())), ack)
}

/** The snapshot's envelope, or null without a session id to file under. */
private fun snapshotOf(json: String?): LinkedHashMap<String, Any?>? {
    if (json.isNullOrEmpty()) return null
    val decoded = try {
        parseOrderedJson(json) as? Map<*, *>
    } catch (error: Exception) {
        null
    } ?: return null
    val sessionId = decoded["session_id"] as? String
    if (sessionId.isNullOrEmpty()) return null
    return LinkedHashMap<String, Any?>().apply {
        for ((key, value) in decoded) put(key.toString(), value)
    }
}

private fun attributesOf(record: CrashRecord, privacy: EffectivePrivacy): Map<String, Any?> {
    val type = record.errorType.ifEmpty { "NativeCrash" }
    // Masked exactly as a reported error is: a crash message routinely carries request context
    // (a URL, an Authorization header), and maskErrors is on by default.
    val opts = privacy.redactOptions(RedactKind.ERROR)
    val mask = privacy.shouldMaskErrors
    val rawMessage = record.errorMessage.ifEmpty { "Native crash" }
    val message = if (mask) redactText(rawMessage, opts) else rawMessage
    // The engine's own metadata only; the markers after it are the SDK's, and crash_report_id must
    // not be at the mercy of a key-name heuristic.
    val metadata = LinkedHashMap(
        if (mask) {
            redactingCauseMessages(
                redactObject(record.metadata, opts),
                opts
            )
        } else {
            record.metadata
        }
    )
    metadata["native"] = true
    metadata["fatal"] = true
    // Stable across redeliveries, so a duplicate can be recognised.
    metadata["crash_report_id"] = record.id
    return mapOf(
        "error_type" to type,
        "error_message" to message,
        "error_stacktrace" to record.frames.map { it.toJson() },
        // As a reported error's, so native fatals group the same way; from the masked message, or
        // it would leak what the message just redacted.
        "error_fingerprint" to "$type:${truncate(message, maxLength = 400)}",
        "error_handled" to false,
        "error_metadata" to metadata
    )
}
