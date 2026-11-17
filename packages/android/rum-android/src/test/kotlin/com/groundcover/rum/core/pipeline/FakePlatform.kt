package com.groundcover.rum.core.pipeline

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.common.MapStorage
import com.groundcover.rum.core.common.decodeJsonObject
import com.groundcover.rum.core.config.ConfigManager
import com.groundcover.rum.core.crash.CrashStore
import com.groundcover.rum.core.nativeengine.NativeEngine
import com.groundcover.rum.core.nativeengine.NativeEngineStatus
import com.groundcover.rum.core.transport.BatchRequest
import com.groundcover.rum.core.transport.BatchSender
import java.io.ByteArrayInputStream
import java.util.zip.GZIPInputStream

/** Runs work inline, and scheduled work when the test moves the clock past it. */
internal class ManualExecutor : CoreExecutor {
    private class Pending(val id: Int, val dueMs: Long, val work: () -> Unit)

    var nowMs = 0L
    private val pending = mutableListOf<Pending>()
    private var nextId = 0

    /** Scheduled work not yet run or cancelled. */
    val pendingCount: Int get() = pending.size

    override fun execute(work: () -> Unit) = work()

    override fun schedule(afterMs: Long, work: () -> Unit): ScheduledWork {
        val id = ++nextId
        pending.add(Pending(id, nowMs + afterMs, work))
        return ScheduledWork { pending.removeAll { it.id == id } }
    }

    /** Moves the clock forward, running what falls due in order. */
    fun advance(byMs: Long) {
        val target = nowMs + byMs
        while (true) {
            val next = pending.filter { it.dueMs <= target }.minByOrNull { it.dueMs } ?: break
            pending.remove(next)
            nowMs = next.dueMs
            next.work()
        }
        nowMs = target
    }
}

/** One request the pipeline handed to the platform, its body decoded. */
internal class SentRequest(val url: String, val headers: Map<String, String>, val body: ByteArray) {
    val batch: Map<String, Any?>
        get() {
            val raw = if (headers["Content-Encoding"] == "gzip") gunzip(body) else body
            return decodeJsonObject(String(raw, Charsets.UTF_8)) ?: emptyMap()
        }

    @Suppress("UNCHECKED_CAST")
    val sessionAttributes: Map<String, Any?>
        get() = batch["sessionAttributes"] as? Map<String, Any?> ?: emptyMap()

    @Suppress("UNCHECKED_CAST")
    val events: List<Map<String, Any?>>
        get() = batch["events"] as? List<Map<String, Any?>> ?: emptyList()
}

/** A sender that records every request instead of sending it. */
internal class RecordingSender : BatchSender {
    val requests = mutableListOf<SentRequest>()
    var delivers = true

    /** Runs as a request is handed over, before it completes. */
    var onSend: (() -> Unit)? = null

    /** Holds every completion until [releaseCompletions], as a slow network does. */
    var holdsCompletions = false
    private val held = mutableListOf<() -> Unit>()

    override fun send(endpoint: String, request: BatchRequest, completion: (Boolean) -> Unit) {
        requests.add(SentRequest(endpoint, request.headers, request.body))
        onSend?.invoke()
        val delivered = delivers
        if (holdsCompletions) held.add { completion(delivered) } else completion(delivered)
    }

    fun releaseCompletions() {
        holdsCompletions = false
        while (held.isNotEmpty()) held.removeAt(0).invoke()
    }
}

/** A platform with a settable clock, storage in memory, inline work, and a sender that records. */
internal class FakePlatform(nowMs: Long = 1_800_000_000_000L) {
    val storage = MapStorage()
    val sender = RecordingSender()
    val executor = ManualExecutor().apply { this.nowMs = nowMs }
    var device: Map<String, Any?> = mapOf("source" to "mobile-rum")
    var crashStore: CrashStore? = null
    var engine: NativeEngine? = null

    var nowMs: Long
        get() = executor.nowMs
        set(value) {
            executor.nowMs = value
        }

    val requests: List<SentRequest> get() = sender.requests

    val services: PlatformServices
        get() = PlatformServices(
            storage = storage,
            clock = { nowMs },
            sender = sender,
            deviceAttributes = { device },
            executor = executor,
            crashStore = crashStore,
            engine = engine
        )

    /** Every event type sent, in order. */
    val types: List<String> get() = requests.flatMap { r -> r.events.map { it["type"] as String } }
}

/**
 * The native engine, in memory: records what the pipeline asks of it, and starts at once unless a
 * test holds the start.
 */
internal class FakeNativeEngine : NativeEngine {
    override var onSignal: ((String, Map<String, Any?>) -> Unit)? = null
    val calls = mutableListOf<String>()
    var configJson: String? = null
        private set
    var status = NativeEngineStatus()

    /** Holds each start's completion until [finishStart], as a slow disk does. */
    var holdsStart = false
    private var heldStart: (() -> Unit)? = null

    /** The last start's config, decoded. */
    val config: Map<String, Any?> get() = configJson?.let { decodeJsonObject(it) } ?: emptyMap()

    @Suppress("UNCHECKED_CAST")
    val features: Map<String, Any?> get() = config["features"] as? Map<String, Any?> ?: emptyMap()

    override fun start(configJson: String, completion: (NativeEngineStatus) -> Unit) {
        calls.add("start")
        this.configJson = configJson
        val status = status
        if (holdsStart) heldStart = { completion(status) } else completion(status)
    }

    fun finishStart() {
        val held = heldStart
        heldStart = null
        held?.invoke()
    }

    override fun stop() {
        calls.add("stop")
    }

    /** What the next [flushFrameSegment] hands over. */
    var openSegment: Map<String, Any?>? = null

    override fun flushFrameSegment(completion: (Map<String, Any?>?) -> Unit) {
        calls.add("flushFrameSegment")
        val segment = openSegment
        openSegment = null
        completion(segment)
    }

    /** Emits [kind] as the engine would, from inside or after its start. */
    fun emit(kind: String, payload: Map<String, Any?>) {
        onSignal?.invoke(kind, payload)
    }
}

internal fun gunzip(data: ByteArray): ByteArray =
    GZIPInputStream(ByteArrayInputStream(data)).use { it.readBytes() }

internal fun aConfig(
    cluster: String = "c",
    apiKey: String = "k",
    batchSize: Int? = null,
    batchTimeoutMs: Long? = null,
    compression: Boolean? = false,
    debug: Boolean = false,
    beforeSend: com.groundcover.rum.BeforeSend? = null,
    enrichEvent: com.groundcover.rum.EnrichEvent? = null
) = ConfigManager(
    GroundcoverConfig(
        apiKey = apiKey,
        dsn = "ingest.example",
        cluster = cluster,
        environment = "e",
        appId = "a",
        options = GroundcoverOptions(
            debug = debug,
            beforeSend = beforeSend,
            enrichEvent = enrichEvent,
            transport = TransportOptions(
                batchSize = batchSize,
                batchTimeoutMs = batchTimeoutMs,
                compression = compression
            )
        )
    )
)
