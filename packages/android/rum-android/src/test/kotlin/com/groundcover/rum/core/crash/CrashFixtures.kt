package com.groundcover.rum.core.crash

import com.groundcover.rum.BeforeSend
import com.groundcover.rum.EnrichEvent
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.common.writeJsJson
import com.groundcover.rum.core.pipeline.CorePipeline
import com.groundcover.rum.core.pipeline.FakePlatform

/** The engine's crash store, in memory. */
internal class FakeCrashStore(records: List<Map<String, Any?>> = emptyList()) : CrashStore {
    val records = records.toMutableList()
    val snapshots = mutableListOf<String?>()
    val cleared = mutableListOf<String>()
    var reads = 0
        private set

    override fun updateSessionSnapshot(json: String?) {
        snapshots.add(json)
    }

    override fun pendingCrashReportsJson(): String {
        reads++
        return writeJsJson(records)
    }

    override fun clearPendingCrashReports(ids: List<String>) {
        cleared.addAll(ids)
        records.removeAll { it["id"] in ids }
    }
}

internal val CRASHED_SESSION: Map<String, Any?> = linkedMapOf(
    "source" to "mobile-rum",
    "session_id" to "crashed-session",
    "session_start_time" to 1_690_000_000_000_000_000L,
    "user" to mapOf("id" to "user-123"),
    "screen" to mapOf("name" to "Native", "key" to "Native-1")
)

internal fun aRecord(
    id: String = "r1",
    crashEpochMs: Any? = 1_700_000_000_000L,
    errorType: Any? = "java.lang.IllegalStateException",
    errorMessage: Any? = "groundcover test crash (native)",
    stacktrace: Any? = listOf(
        mapOf("filename" to "Crash.kt", "function" to "boom", "lineno" to 7, "colno" to 0)
    ),
    metadata: Any? = mapOf("crash_source" to "jvm_handler"),
    snapshot: Map<String, Any?>? = CRASHED_SESSION,
    screen: Any? = null
): Map<String, Any?> = linkedMapOf<String, Any?>(
    "id" to id,
    "crashEpochMs" to crashEpochMs,
    "errorType" to errorType,
    "errorMessage" to errorMessage,
    "stacktrace" to stacktrace,
    "metadata" to metadata,
    "sessionSnapshotJson" to snapshot?.let { writeJsJson(it) }
).apply { if (screen != null) put("screen", screen) }

internal fun aCrashConfig(
    sampled: Boolean = true,
    beforeSend: BeforeSend? = null,
    enrichEvent: EnrichEvent? = null
) = GroundcoverConfig(
    apiKey = "k",
    dsn = "ingest.example",
    cluster = "c",
    environment = "e",
    appId = "a",
    options = GroundcoverOptions(
        sessionSampleRate = if (sampled) 1.0 else 0.0,
        beforeSend = beforeSend,
        enrichEvent = enrichEvent,
        transport = TransportOptions(batchSize = 0, compression = false)
    )
)

internal fun startedWith(
    store: FakeCrashStore,
    config: GroundcoverConfig = aCrashConfig()
): Pair<CorePipeline, FakePlatform> {
    val platform = FakePlatform().apply { crashStore = store }
    val pipeline = CorePipeline()
    pipeline.start(config, platform.services)
    return pipeline to platform
}
