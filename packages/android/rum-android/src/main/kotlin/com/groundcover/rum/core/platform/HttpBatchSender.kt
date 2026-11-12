package com.groundcover.rum.core.platform

import com.groundcover.rum.core.transport.BatchRequest
import com.groundcover.rum.core.transport.BatchSender
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val TIMEOUT_MS = 30_000

/**
 * Sends batches with HttpURLConnection, one at a time on a thread of its own, so a slow network
 * never holds up the core. A batch counts as delivered only on a 2xx.
 */
internal class HttpBatchSender(
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "gc-rum-sender").apply { isDaemon = true }
    }
) : BatchSender {
    override fun send(endpoint: String, request: BatchRequest, completion: (Boolean) -> Unit) {
        executor.execute {
            val delivered = try {
                post(endpoint, request)
            } catch (error: Exception) {
                false
            }
            completion(delivered)
        }
    }

    private fun post(endpoint: String, request: BatchRequest): Boolean {
        val connection = URL(endpoint).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.doOutput = true
            connection.useCaches = false
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            connection.setFixedLengthStreamingMode(request.body.size)
            connection.outputStream.use { it.write(request.body) }
            val status = connection.responseCode
            // Read to the end, so the connection can be reused.
            (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.use { it.readBytes() }
            return status in 200..299
        } finally {
            connection.disconnect()
        }
    }
}
