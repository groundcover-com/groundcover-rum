package com.groundcover.rum.core.config

import com.groundcover.rum.BeforeSend
import com.groundcover.rum.EnrichEvent
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.GroundcoverOptionsUpdate
import com.groundcover.rum.NativeHooks
import com.groundcover.rum.NativeOptions
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.RumUser
import com.groundcover.rum.TracingOptions
import com.groundcover.rum.TracingOrigin
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.UrlPattern
import com.groundcover.rum.UserUpdate
import com.groundcover.rum.core.common.safeWarn
import com.groundcover.rum.core.common.toJsonMap

// The configuration the pipeline runs on: which groups merge one level deep on an update, how
// sessionMaxDuration is validated, how the identity merges or clears, and which fields an update
// may change. An out-of-range sessionMaxDuration in an update keeps the current cap.

/** The options with every default applied, as the pipeline reads them. */
internal data class ResolvedOptions(
    /** Empty means every signal. Fixed at start, when the capture hooks are installed. */
    val enabledEvents: List<RumEventName>,
    /** Fixed at start, when the sampling verdict is drawn. */
    val sessionSampleRate: Double,
    val sessionMaxDurationMs: Long,
    val debug: Boolean,
    val excludedUrls: List<UrlPattern>,
    val beforeSend: BeforeSend?,
    val enrichEvent: EnrichEvent?,
    /**
     * As provided, merged across updates. [com.groundcover.rum.core.privacy.resolvePrivacy]
     * applies the defaults, since it needs to tell an explicit level from an omitted one.
     */
    val privacy: PrivacyOptions,
    val tracing: ResolvedTracing,
    /**
     * As provided, merged across updates. The events pool validates the batch size and timeout
     * where it uses them.
     */
    val transport: TransportOptions,
    // Fixed at start.
    val appVersion: String?,
    val appBuild: String?,
    val native: NativeOptions?,
    val hooks: NativeHooks
) {
    fun isEnabled(name: RumEventName) = isEventEnabled(enabledEvents, name)
}

/**
 * Whether [enabled], an `enabledEvents` list, turns on [name]: an empty or absent list turns on
 * everything.
 */
internal fun isEventEnabled(enabled: List<RumEventName>?, name: RumEventName): Boolean =
    enabled.isNullOrEmpty() || name in enabled

/** Tracing options with their defaults applied. */
internal data class ResolvedTracing(
    val propagationUrls: List<String> = emptyList(),
    val propagationHeaders: List<String> = emptyList(),
    val traceIdHeaderName: String = "",
    val spanIdHeaderName: String = "",
    val origin: TracingOrigin = TracingOrigin("", "")
) {
    fun merging(update: TracingOptions?): ResolvedTracing {
        if (update == null) return this
        return ResolvedTracing(
            propagationUrls = update.propagationUrls ?: propagationUrls,
            propagationHeaders = update.propagationHeaders ?: propagationHeaders,
            traceIdHeaderName = update.traceIdHeaderName ?: traceIdHeaderName,
            spanIdHeaderName = update.spanIdHeaderName ?: spanIdHeaderName,
            origin = update.origin ?: origin
        )
    }
}

/**
 * The configuration the pipeline runs on: the start config, with defaults applied and updates
 * merged in.
 */
internal class SdkConfig(input: GroundcoverConfig) {
    var dsn = input.dsn
        private set
    val appId = input.appId
    var cluster = input.cluster
        private set
    var apiKey = input.apiKey
        private set
    var environment = input.environment
        private set
    var namespace = input.namespace ?: ""
        private set
    var releaseId = input.releaseId
        private set
    var user = input.user?.let { mergeUser(null, it) }
        private set
    var options = input.options.let { options ->
        ResolvedOptions(
            enabledEvents = options.enabledEvents ?: emptyList(),
            sessionSampleRate = options.sessionSampleRate ?: DEFAULT_SESSION_SAMPLE_RATE,
            sessionMaxDurationMs = normalizeSessionMaxDuration(
                options.sessionMaxDurationMs,
                DEFAULT_SESSION_MAX_DURATION_MS
            ),
            debug = options.debug ?: false,
            excludedUrls = options.excludedUrls ?: emptyList(),
            beforeSend = options.beforeSend,
            enrichEvent = options.enrichEvent,
            privacy = options.privacy ?: PrivacyOptions(),
            tracing = ResolvedTracing().merging(options.tracing),
            transport = options.transport ?: TransportOptions(),
            appVersion = options.appVersion,
            appBuild = options.appBuild,
            native = options.native,
            hooks = options.hooks
        )
    }
        private set

    /** The ingest base URL: the DSN, with `https://` when it names no scheme. */
    val endpoint: String get() = if (dsn.startsWith("http")) dsn else "https://$dsn"

    fun update(update: GroundcoverConfigUpdate) {
        update.options?.let { options = merge(options, it) }
        when (val change = update.user) {
            is UserUpdate.Set -> user = mergeUser(user, change.user)
            is UserUpdate.Clear -> user = null
            null -> Unit
        }
        present(update.dsn)?.let { dsn = it }
        present(update.apiKey)?.let { apiKey = it }
        present(update.cluster)?.let { cluster = it }
        present(update.environment)?.let { environment = it }
        present(update.namespace)?.let { namespace = it }
        present(update.releaseId)?.let { releaseId = it }
    }
}

private fun present(value: String?): String? = value?.takeIf { it.isNotEmpty() }

/**
 * [ms] when within 1 minute to 8 hours, else [current]: the default at start, and the cap the
 * session already runs on in an update, which the app chose and a bad update shouldn't undo.
 */
private fun normalizeSessionMaxDuration(ms: Long?, current: Long): Long {
    if (ms == null) return current
    if (ms < MIN_SESSION_MAX_DURATION_MS || ms > MAX_SESSION_MAX_DURATION_MS) {
        safeWarn(
            "[groundcover] sessionMaxDuration must be between $MIN_SESSION_MAX_DURATION_MS ms " +
                "(1 minute) and $MAX_SESSION_MAX_DURATION_MS ms (8 hours); using " +
                "${current / 60_000} minutes"
        )
        return current
    }
    return ms
}

/**
 * [base] with [update]'s non-null options applied. What start fixes is [base]'s: the capture hooks
 * are installed then and never again, and the sampling verdict is drawn then, so a later value
 * would say one thing while the SDK did another.
 */
private fun merge(base: ResolvedOptions, update: GroundcoverOptionsUpdate) = base.copy(
    sessionMaxDurationMs = normalizeSessionMaxDuration(
        update.sessionMaxDurationMs,
        base.sessionMaxDurationMs
    ),
    debug = update.debug ?: base.debug,
    excludedUrls = update.excludedUrls ?: base.excludedUrls,
    beforeSend = update.beforeSend ?: base.beforeSend,
    enrichEvent = update.enrichEvent ?: base.enrichEvent,
    privacy = mergePrivacy(base.privacy, update.privacy),
    tracing = base.tracing.merging(update.tracing),
    transport = mergeTransport(base.transport, update.transport)
)

private fun mergePrivacy(base: PrivacyOptions, update: PrivacyOptions?): PrivacyOptions {
    if (update == null) return base
    return PrivacyOptions(
        level = update.level ?: base.level,
        maskNetworkBodies = update.maskNetworkBodies ?: base.maskNetworkBodies,
        maskNetworkQueryParams = update.maskNetworkQueryParams ?: base.maskNetworkQueryParams,
        maskLogs = update.maskLogs ?: base.maskLogs,
        maskErrors = update.maskErrors ?: base.maskErrors,
        sensitiveKeys = update.sensitiveKeys ?: base.sensitiveKeys,
        redact = update.redact ?: base.redact,
        maskInteractionLabels = update.maskInteractionLabels ?: base.maskInteractionLabels
    )
}

private fun mergeTransport(base: TransportOptions, update: TransportOptions?): TransportOptions {
    if (update == null) return base
    return TransportOptions(
        batchSize = update.batchSize ?: base.batchSize,
        batchTimeoutMs = update.batchTimeoutMs ?: base.batchTimeoutMs,
        compression = update.compression ?: base.compression
    )
}

/**
 * [update] merged into [base]: the fields it gives replace the current ones, and the rest stay.
 * New properties are made JSON data here, once, rather than on every batch envelope that carries
 * them.
 */
private fun mergeUser(base: RumUser?, update: RumUser) = RumUser(
    id = update.id ?: base?.id,
    email = update.email ?: base?.email,
    name = update.name ?: base?.name,
    role = update.role ?: base?.role,
    organization = update.organization ?: base?.organization,
    properties = update.properties?.let { toJsonMap(it) } ?: base?.properties
)
