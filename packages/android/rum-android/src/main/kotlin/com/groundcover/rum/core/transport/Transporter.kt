package com.groundcover.rum.core.transport

import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.config.DEFAULT_COMPRESSION
import com.groundcover.rum.core.pipeline.CoreExecutor
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Collections
import java.util.zip.GZIPOutputStream

/** One batch POST, as the platform sends it. */
internal class BatchRequest(val headers: Map<String, String>, val body: ByteArray) {
    val method = "POST"
}

/** How a batch POST ended. */
internal sealed interface SendOutcome {
    /** The ingest answered 2xx. */
    object Delivered : SendOutcome

    /** The ingest answered outside 2xx: it refused the batch. */
    data class Rejected(val status: Int) : SendOutcome

    /** No answer: no network, a timeout, or an endpoint that is not a URL. */
    object Failed : SendOutcome
}

internal val SendOutcome.isDelivered: Boolean
    get() = this == SendOutcome.Delivered

/**
 * The one network primitive the core needs; the platform owns how a batch reaches the wire.
 * [completion] reports how the request ended. Called from any thread.
 */
internal fun interface BatchSender {
    fun send(endpoint: String, request: BatchRequest, completion: (SendOutcome) -> Unit)
}

/**
 * Statuses that mean the endpoint refuses this SDK's credentials. Every batch after one of these
 * is refused the same way, so the app records nothing until the apiKey or dsn is fixed: that
 * warrants a warning outside debug.
 */
private val CREDENTIAL_REJECTIONS = setOf(401, 403)

/** A batch on its way out: the envelope plus the events. */
internal class Batch(val sessionAttributes: Map<String, Any?>, val events: List<Map<String, Any?>>)

/** [data] gzipped, or null when it can't be, so the batch goes out uncompressed instead. */
internal fun gzip(data: ByteArray): ByteArray? = try {
    val out = ByteArrayOutputStream()
    GZIPOutputStream(out).use { it.write(data) }
    out.toByteArray()
} catch (error: IOException) {
    null
}

/**
 * Builds a batch's request on the core thread (JSON, UTF-8, gzip) and hands it to the sender. A
 * live batch is fire-and-forget; a delivery reports a verdict, for the crash drain to delete a
 * record only once it landed. Memory only: nothing is retried or kept.
 */
internal class Transporter(
    private val config: ConfigManager,
    private val sender: BatchSender,
    private val executor: CoreExecutor,
    private val diagnostics: RumDiagnostics = RumDiagnostics.shared
) {
    // Credential rejections already warned about: one warning per status is enough to act on, and
    // a batch goes out every few seconds. Completions arrive on the sender's thread.
    private val warnedStatuses: MutableSet<Int> = Collections.synchronizedSet(HashSet())

    /**
     * A refused batch and its events are gone: logged in debug, and warned about even without
     * debug when the endpoint refuses the credentials, since that silently drops every batch. As
     * the browser SDK does.
     */
    private fun reportRejection(outcome: SendOutcome, endpoint: String) {
        if (outcome !is SendOutcome.Rejected) return
        val status = outcome.status
        diagnostics.log("Batch rejected by $endpoint with HTTP $status")
        if (status in CREDENTIAL_REJECTIONS && warnedStatuses.add(status)) {
            diagnostics.warn(
                "[groundcover] $endpoint rejected a batch with HTTP $status. Check the apiKey " +
                    "and dsn passed to Groundcover.start(): no RUM data is recorded until they " +
                    "are accepted."
            )
        }
    }

    /** [batch] as the request that carries it; null without an API key, when nothing is sent. */
    private fun request(batch: Batch): Pair<String, BatchRequest>? {
        val config = config.config
        val apiKey = config.apiKey
        if (apiKey.isEmpty()) return null
        val json = encodeJson(
            mapOf("sessionAttributes" to batch.sessionAttributes, "events" to batch.events)
        )
        if (config.options.debug) diagnostics.log("Sending batch:", json)
        val bytes = json.toByteArray(Charsets.UTF_8)
        val compressed = if (config.options.transport.compression ?: DEFAULT_COMPRESSION) {
            gzip(bytes)
        } else {
            null
        }
        val headers = linkedMapOf(
            "Content-Type" to "application/json",
            "apikey" to apiKey,
            "Content-Encoding" to if (compressed != null) "gzip" else ""
        )
        return "${config.endpoint}/json/rum" to BatchRequest(headers, compressed ?: bytes)
    }

    fun send(batch: Batch) {
        try {
            val (endpoint, request) = request(batch) ?: run {
                diagnostics.log("No API key found")
                return
            }
            sender.send(endpoint, request) { outcome ->
                if (outcome == SendOutcome.Failed) {
                    diagnostics.log("Network error while sending batch")
                }
                reportRejection(outcome, endpoint)
            }
        } catch (error: Exception) {
            diagnostics.log("Failed to send batch:", error)
        }
    }

    /**
     * Sends [batch] and reports, on the core thread, whether it was delivered. False without an
     * API key, when nothing is sent.
     */
    fun deliver(batch: Batch, completion: (Boolean) -> Unit) {
        val outgoing = try {
            request(batch)
        } catch (error: Exception) {
            diagnostics.log("Failed to deliver batch:", error)
            null
        }
        if (outgoing == null) {
            completion(false)
            return
        }
        try {
            sender.send(outgoing.first, outgoing.second) { outcome ->
                reportRejection(outcome, outgoing.first)
                executor.execute { completion(outcome.isDelivered) }
            }
        } catch (error: Exception) {
            diagnostics.log("Failed to deliver batch:", error)
            completion(false)
        }
    }
}
