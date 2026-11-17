package com.groundcover.rum.core.transport

import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.common.encodeJson
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.config.DEFAULT_COMPRESSION
import com.groundcover.rum.core.pipeline.CoreExecutor
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.zip.GZIPOutputStream

/** One batch POST, as the platform sends it. */
internal class BatchRequest(val headers: Map<String, String>, val body: ByteArray) {
    val method = "POST"
}

/**
 * The one network primitive the core needs; the platform owns how a batch reaches the wire.
 * [completion] reports whether the batch was delivered: the request completed with a 2xx.
 */
internal fun interface BatchSender {
    fun send(endpoint: String, request: BatchRequest, completion: (Boolean) -> Unit)
}

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
            sender.send(endpoint, request) { delivered ->
                if (!delivered) diagnostics.log("Network error while sending batch")
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
            sender.send(outgoing.first, outgoing.second) { delivered ->
                executor.execute { completion(delivered) }
            }
        } catch (error: Exception) {
            diagnostics.log("Failed to deliver batch:", error)
            completion(false)
        }
    }
}
