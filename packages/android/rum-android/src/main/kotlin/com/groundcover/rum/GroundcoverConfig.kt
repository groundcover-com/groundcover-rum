package com.groundcover.rum

// The SDK's configuration surface.
//
// Names mirror the React Native, Flutter and iOS SDKs one to one, so their READMEs and the
// dashboards' vocabulary carry over. Durations are milliseconds, named with `Ms` as React Native's
// native options are, and every class has a Builder for Java. Every option is optional, and null
// means the default. A Builder starts at the defaults, so its number and flag setters take
// primitives: Java can pass `5000` where a `Long?` would need `5000L`.

/** What [Groundcover.start] takes. */
class GroundcoverConfig(
    val apiKey: String,
    /** The ingest host, with or without a scheme; batches go to `{dsn}/json/rum`. */
    val dsn: String,
    val cluster: String,
    val environment: String,
    /** The application's identity. Must not be blank. */
    val appId: String,
    val namespace: String? = null,
    val releaseId: String? = null,
    val user: RumUser? = null,
    /** Start with this session id instead of a generated or persisted one. */
    val sessionId: String? = null,
    options: GroundcoverOptions = GroundcoverOptions()
) {
    /** A null from Java, which Kotlin's types don't stop, means the defaults. */
    val options: GroundcoverOptions = orDefault(options) { GroundcoverOptions() }

    class Builder(
        private val apiKey: String,
        private val dsn: String,
        private val cluster: String,
        private val environment: String,
        private val appId: String
    ) {
        private var namespace: String? = null
        private var releaseId: String? = null
        private var user: RumUser? = null
        private var sessionId: String? = null
        private var options = GroundcoverOptions()

        fun namespace(value: String?) = apply { namespace = value }

        fun releaseId(value: String?) = apply { releaseId = value }

        fun user(value: RumUser?) = apply { user = value }

        fun sessionId(value: String?) = apply { sessionId = value }

        fun options(value: GroundcoverOptions) = apply { options = value }

        fun build() = GroundcoverConfig(
            apiKey,
            dsn,
            cluster,
            environment,
            appId,
            namespace,
            releaseId,
            user,
            sessionId,
            options
        )
    }
}

/**
 * Options for [GroundcoverConfig]. The ones [GroundcoverOptionsUpdate] also carries can change
 * after start; the rest are fixed then.
 */
class GroundcoverOptions(
    /** Which signals to capture. Null or empty means all. Fixed at start. */
    val enabledEvents: List<RumEventName>? = null,
    /** The share of sessions to record, from 0 to 1. Defaults to 1. Decided once per session. */
    val sessionSampleRate: Double? = null,
    /**
     * The target longest session. Enforced on the next activity, so an idle session keeps its id
     * past it. Defaults to 4 hours; must be between 1 minute and 8 hours, or the default applies.
     * Sessions also end after 30 minutes without user input.
     */
    val sessionMaxDurationMs: Long? = null,
    /** Logs what the SDK does, with a `[groundcover]` prefix. */
    val debug: Boolean? = null,
    /** Requests network capture skips. The SDK's own requests are always skipped. */
    val excludedUrls: List<UrlPattern>? = null,
    /** Inspects each event before it is queued; return false to drop it. */
    val beforeSend: BeforeSend? = null,
    /** Changes each event before it is queued, and returns it. */
    val enrichEvent: EnrichEvent? = null,
    val privacy: PrivacyOptions? = null,
    val tracing: TracingOptions? = null,
    val transport: TransportOptions? = null,
    /** The app version on the session envelope, when the package's own should not be used. */
    val appVersion: String? = null,
    /** The app build on the session envelope, when the package's own should not be used. */
    val appBuild: String? = null,
    /** Tuning for hangs, frame vitals and time to interactive. Fixed at start. */
    val native: NativeOptions? = null,
    hooks: NativeHooks = NativeHooks()
) {
    /**
     * The automatic capture hooks, each of which can be turned off. Fixed at start. A null from
     * Java, which Kotlin's types don't stop, means the defaults.
     */
    val hooks: NativeHooks = orDefault(hooks) { NativeHooks() }

    class Builder {
        private var enabledEvents: List<RumEventName>? = null
        private var sessionSampleRate: Double? = null
        private var sessionMaxDurationMs: Long? = null
        private var debug: Boolean? = null
        private var excludedUrls: List<UrlPattern>? = null
        private var beforeSend: BeforeSend? = null
        private var enrichEvent: EnrichEvent? = null
        private var privacy: PrivacyOptions? = null
        private var tracing: TracingOptions? = null
        private var transport: TransportOptions? = null
        private var appVersion: String? = null
        private var appBuild: String? = null
        private var native: NativeOptions? = null
        private var hooks = NativeHooks()

        fun enabledEvents(value: List<RumEventName>?) = apply { enabledEvents = value }

        fun sessionSampleRate(value: Double) = apply { sessionSampleRate = value }

        fun sessionMaxDurationMs(value: Long) = apply { sessionMaxDurationMs = value }

        fun debug(value: Boolean) = apply { debug = value }

        fun excludedUrls(value: List<UrlPattern>?) = apply { excludedUrls = value }

        fun beforeSend(value: BeforeSend?) = apply { beforeSend = value }

        fun enrichEvent(value: EnrichEvent?) = apply { enrichEvent = value }

        fun privacy(value: PrivacyOptions?) = apply { privacy = value }

        fun tracing(value: TracingOptions?) = apply { tracing = value }

        fun transport(value: TransportOptions?) = apply { transport = value }

        fun appVersion(value: String?) = apply { appVersion = value }

        fun appBuild(value: String?) = apply { appBuild = value }

        // `native` is a Java keyword, so Java calls this nativeOptions.
        @JvmName("nativeOptions")
        fun native(value: NativeOptions?) = apply { native = value }

        fun hooks(value: NativeHooks) = apply { hooks = value }

        fun build() = GroundcoverOptions(
            enabledEvents,
            sessionSampleRate,
            sessionMaxDurationMs,
            debug,
            excludedUrls,
            beforeSend,
            enrichEvent,
            privacy,
            tracing,
            transport,
            appVersion,
            appBuild,
            native,
            hooks
        )
    }
}

/** The signals [GroundcoverOptions.enabledEvents] switches, by the React Native SDK's names. */
enum class RumEventName(val wireName: String) {
    INTERACTION("interaction"),
    NETWORK("network"),
    LOGS("logs"),
    NAVIGATION("navigation"),
    EXCEPTIONS("exceptions"),

    /** Crashes, reported on the next launch under the session they happened in. */
    CRASHES("crashes"),

    /** Main-thread stalls the app recovered from, and ANRs. */
    HANGS("hangs"),

    /** Slow and frozen frames, and the time they lost, per screen. */
    VITALS("vitals"),

    /** App start (cold, warm, hot) and time to interactive. */
    APP_START("appStart")
}

/**
 * The automatic capture hooks. Each is on by default and can be turned off on its own, for an app
 * whose own instrumentation clashes with it; what it captured can then be sent through the API.
 */
class NativeHooks(
    /**
     * Screens from each Activity's lifecycle. An Activity whose content names a screen of its own (a
     * Fragment, or a `GroundcoverNavigationEffect` destination) reports that one instead.
     */
    val activities: Boolean = true,
    /**
     * Screens from each Fragment's lifecycle and show/hide tab switches: the app's own shown
     * Fragment that holds none of the app's own, decided after its first frame. A dialog or bottom
     * sheet, and the Fragments in it, isn't a screen: the one under it stays current, where iOS
     * reports a sheet as one.
     */
    val fragments: Boolean = true,
    /**
     * Taps and gestures, from a wrapper around each window's callback: every Activity's, and every
     * Dialog's or other window's the window manager lists.
     */
    val windowCallback: Boolean = true,
    /**
     * One input event when editing a text field ends: focus leaves it or its window, Enter, or a
     * tap outside it. Never the text. Read through the window callbacks, so [windowCallback] has
     * to be on too.
     */
    val textFields: Boolean = true
) {
    class Builder {
        private var activities = true
        private var fragments = true
        private var windowCallback = true
        private var textFields = true

        fun activities(value: Boolean) = apply { activities = value }

        fun fragments(value: Boolean) = apply { fragments = value }

        fun windowCallback(value: Boolean) = apply { windowCallback = value }

        fun textFields(value: Boolean) = apply { textFields = value }

        fun build() = NativeHooks(activities, fragments, windowCallback, textFields)
    }
}

/** A URL that [GroundcoverOptions.excludedUrls] matches. */
sealed class UrlPattern {
    /**
     * A string with `*` or `?` is a glob matched anywhere in the URL, where `*` is any run of
     * characters and `?` any one character. Any other string must equal the whole URL.
     */
    class Text(val value: String) : UrlPattern()

    /** A regular expression, matched anywhere in the URL. */
    class Expression(val regex: Regex) : UrlPattern()

    companion object {
        @JvmStatic
        fun of(value: String): UrlPattern = Text(value)

        @JvmStatic
        fun of(regex: Regex): UrlPattern = Expression(regex)

        @JvmStatic
        fun of(pattern: java.util.regex.Pattern): UrlPattern = Expression(pattern.toRegex())
    }
}

/** The master switch for data masking. */
enum class PrivacyLevel(val wireName: String) {
    /**
     * Masks sensitive data only: sensitive-key matches, views marked private, and network, log
     * and error payloads. The default.
     */
    MASK_SENSITIVE("mask-sensitive"),

    /** Also masks the label, hint and value text of every tap and input. */
    MASK_ALL("mask-all"),

    /** Opts out of masking, except credential headers. */
    ALLOW("allow")
}

/** The event surface a [RedactField] belongs to. */
enum class RedactKind(val wireName: String) {
    REQUEST_BODY("request-body"),
    RESPONSE_BODY("response-body"),
    QUERY("query"),
    HEADER("header"),
    LOG("log"),
    ERROR("error")
}

/** One leaf value the redaction walk visits, as a [Redactor] sees it. */
class RedactField(
    /** The leaf's own key; empty for a whole-string field (a log or error message). */
    val key: String,
    /** The leaf value: a string, number, Boolean or null, never a map or list. */
    val value: Any?,
    /** The full key path to the leaf; empty for a whole-string field. */
    val path: List<String>,
    val kind: RedactKind,
    /** Whether the built-in patterns or `sensitiveKeys` would redact it. */
    val sensitive: Boolean
)

/**
 * A per-leaf redaction hook. Return a replacement string, number or Boolean, or null to keep the
 * SDK's default (`[REDACTED]` when the field is sensitive, the value otherwise), so a hook that
 * cares about one field can't switch masking off elsewhere. Called off the main thread. A hook
 * that throws gets the default for that field.
 */
fun interface Redactor {
    fun redact(field: RedactField): Any?
}

/**
 * Inspects an event before it is queued; return false to drop it. Called off the main thread. A
 * hook that throws drops the event.
 */
fun interface BeforeSend {
    fun shouldSend(event: RumEvent): Boolean
}

/**
 * Changes an event before it is queued, and returns it. Called off the main thread. A hook that
 * throws drops the event.
 */
fun interface EnrichEvent {
    fun enrich(event: RumEvent): RumEvent
}

/** Data masking for every captured surface. On by default, at [PrivacyLevel.MASK_SENSITIVE]. */
class PrivacyOptions(
    val level: PrivacyLevel? = null,
    /** Redact network request and response bodies. On unless the level is `ALLOW`. */
    val maskNetworkBodies: Boolean? = null,
    /** Redact URL query parameters. On unless the level is `ALLOW`. */
    val maskNetworkQueryParams: Boolean? = null,
    /** Redact log messages and attributes. On unless the level is `ALLOW`. */
    val maskLogs: Boolean? = null,
    /**
     * Redact error messages and metadata; stack frames are sent as they are. On unless the level
     * is `ALLOW`.
     */
    val maskErrors: Boolean? = null,
    /** Extra case-insensitive key substrings to treat as sensitive, added to the built-in ones. */
    val sensitiveKeys: List<String>? = null,
    val redact: Redactor? = null,
    /**
     * Mask tap labels under any level. Always on under `MASK_ALL`; the role and component path
     * stay, being structural.
     */
    val maskInteractionLabels: Boolean? = null
) {
    class Builder {
        private var level: PrivacyLevel? = null
        private var maskNetworkBodies: Boolean? = null
        private var maskNetworkQueryParams: Boolean? = null
        private var maskLogs: Boolean? = null
        private var maskErrors: Boolean? = null
        private var sensitiveKeys: List<String>? = null
        private var redact: Redactor? = null
        private var maskInteractionLabels: Boolean? = null

        fun level(value: PrivacyLevel?) = apply { level = value }

        fun maskNetworkBodies(value: Boolean) = apply { maskNetworkBodies = value }

        fun maskNetworkQueryParams(value: Boolean) = apply { maskNetworkQueryParams = value }

        fun maskLogs(value: Boolean) = apply { maskLogs = value }

        fun maskErrors(value: Boolean) = apply { maskErrors = value }

        fun sensitiveKeys(value: List<String>?) = apply { sensitiveKeys = value }

        fun redact(value: Redactor?) = apply { redact = value }

        fun maskInteractionLabels(value: Boolean) = apply { maskInteractionLabels = value }

        fun build() = PrivacyOptions(
            level,
            maskNetworkBodies,
            maskNetworkQueryParams,
            maskLogs,
            maskErrors,
            sensitiveKeys,
            redact,
            maskInteractionLabels
        )
    }
}

/** The `origin` tag stamped on injected trace headers. */
class TracingOrigin(val name: String, val value: String)

/** Distributed-tracing header propagation for outgoing requests. */
class TracingOptions(
    /**
     * Request URLs that get a `traceparent` header: whole-URL matches in which only `*` is a
     * wildcard. A request that already carries one of [propagationHeaders] keeps its own and gets
     * no trace header.
     */
    val propagationUrls: List<String>? = null,
    /**
     * Header names that carry the W3C trace context on traced requests. When set, they replace
     * `traceparent`: list it too to keep it.
     */
    val propagationHeaders: List<String>? = null,
    /** A header that also carries the trace id. */
    val traceIdHeaderName: String? = null,
    /** A header that also carries the span id. */
    val spanIdHeaderName: String? = null,
    val origin: TracingOrigin? = null
) {
    class Builder {
        private var propagationUrls: List<String>? = null
        private var propagationHeaders: List<String>? = null
        private var traceIdHeaderName: String? = null
        private var spanIdHeaderName: String? = null
        private var origin: TracingOrigin? = null

        fun propagationUrls(value: List<String>?) = apply { propagationUrls = value }

        fun propagationHeaders(value: List<String>?) = apply { propagationHeaders = value }

        fun traceIdHeaderName(value: String?) = apply { traceIdHeaderName = value }

        fun spanIdHeaderName(value: String?) = apply { spanIdHeaderName = value }

        fun origin(value: TracingOrigin?) = apply { origin = value }

        fun build() = TracingOptions(
            propagationUrls,
            propagationHeaders,
            traceIdHeaderName,
            spanIdHeaderName,
            origin
        )
    }
}

/** Batching and delivery. */
class TransportOptions(
    /** Events buffered before a batch is sent. Defaults to 10; 0 sends every event on its own. */
    val batchSize: Int? = null,
    /** Longest a batch waits before it is sent anyway. Defaults to 10 seconds. */
    val batchTimeoutMs: Long? = null,
    /** Gzip outgoing batches. Defaults to true. */
    val compression: Boolean? = null
) {
    class Builder {
        private var batchSize: Int? = null
        private var batchTimeoutMs: Long? = null
        private var compression: Boolean? = null

        fun batchSize(value: Int) = apply { batchSize = value }

        fun batchTimeoutMs(value: Long) = apply { batchTimeoutMs = value }

        fun compression(value: Boolean) = apply { compression = value }

        fun build() = TransportOptions(batchSize, batchTimeoutMs, compression)
    }
}

/**
 * Tuning for hangs, frame vitals and time to interactive. Tuning only:
 * [GroundcoverOptions.enabledEvents] is the one way to turn a signal off.
 */
class NativeOptions(
    /**
     * How long the main thread must be blocked before a hang is reported. Defaults to 5 seconds,
     * Android's own ANR threshold; a value outside 250 ms to 60 s falls back to it.
     */
    val hangThresholdMs: Long? = null,
    /**
     * Longest a frame-vitals segment may run before it is closed anyway. Defaults to 60 seconds;
     * a value outside 1 s to 5 minutes falls back to it. Segments normally end on a screen change
     * or on backgrounding, so this is a safety valve, not a cadence.
     */
    val vitalsMaxSegmentMs: Long? = null,
    /** Which moment counts as interactive. Defaults to [TtiMode.AUTO]. */
    val tti: TtiMode? = null
) {
    class Builder {
        private var hangThresholdMs: Long? = null
        private var vitalsMaxSegmentMs: Long? = null
        private var tti: TtiMode? = null

        fun hangThresholdMs(value: Long) = apply { hangThresholdMs = value }

        fun vitalsMaxSegmentMs(value: Long) = apply { vitalsMaxSegmentMs = value }

        fun tti(value: TtiMode?) = apply { tti = value }

        fun build() = NativeOptions(hangThresholdMs, vitalsMaxSegmentMs, tti)
    }
}

/** Which moment counts as interactive for time to interactive. */
enum class TtiMode {
    /** The first screen landing. A floor, not a promise: it comes before that screen's data loads. */
    AUTO,

    /**
     * When the app calls [Groundcover.markAppInteractive]: the honest measure, called once the
     * first screen is genuinely usable.
     */
    MANUAL
}

/** A user identity, stamped on every batch once set. */
class RumUser(
    val id: String? = null,
    val email: String? = null,
    val name: String? = null,
    val role: String? = null,
    val organization: String? = null,
    val properties: Map<String, Any?>? = null
) {
    class Builder {
        private var id: String? = null
        private var email: String? = null
        private var name: String? = null
        private var role: String? = null
        private var organization: String? = null
        private var properties: Map<String, Any?>? = null

        fun id(value: String?) = apply { id = value }

        fun email(value: String?) = apply { email = value }

        fun name(value: String?) = apply { name = value }

        fun role(value: String?) = apply { role = value }

        fun organization(value: String?) = apply { organization = value }

        fun properties(value: Map<String, Any?>?) = apply { properties = value }

        fun build() = RumUser(id, email, name, role, organization, properties)
    }
}

/**
 * What [Groundcover.updateConfig] takes: [GroundcoverConfig] without what is fixed at start. Null
 * fields stay as they are.
 */
class GroundcoverConfigUpdate(
    val apiKey: String? = null,
    val dsn: String? = null,
    val cluster: String? = null,
    val environment: String? = null,
    val namespace: String? = null,
    val releaseId: String? = null,
    val user: UserUpdate? = null,
    val options: GroundcoverOptionsUpdate? = null
) {
    class Builder {
        private var apiKey: String? = null
        private var dsn: String? = null
        private var cluster: String? = null
        private var environment: String? = null
        private var namespace: String? = null
        private var releaseId: String? = null
        private var user: UserUpdate? = null
        private var options: GroundcoverOptionsUpdate? = null

        fun apiKey(value: String?) = apply { apiKey = value }

        fun dsn(value: String?) = apply { dsn = value }

        fun cluster(value: String?) = apply { cluster = value }

        fun environment(value: String?) = apply { environment = value }

        fun namespace(value: String?) = apply { namespace = value }

        fun releaseId(value: String?) = apply { releaseId = value }

        fun user(value: UserUpdate?) = apply { user = value }

        fun options(value: GroundcoverOptionsUpdate?) = apply { options = value }

        fun build() = GroundcoverConfigUpdate(
            apiKey,
            dsn,
            cluster,
            environment,
            namespace,
            releaseId,
            user,
            options
        )
    }
}

/** A change to the identity in [GroundcoverConfigUpdate]. */
sealed class UserUpdate {
    /**
     * Merges into the identity: the fields it gives replace the current ones, and the rest stay.
     */
    class Set(val user: RumUser) : UserUpdate()

    /** Removes it, as at a logout, so the next user's events don't carry it. */
    object Clear : UserUpdate()

    companion object {
        @JvmStatic
        fun set(user: RumUser): UserUpdate = Set(user)

        @JvmStatic
        fun clear(): UserUpdate = Clear
    }
}

/** The options [Groundcover.updateConfig] can change. Null fields stay as they are. */
class GroundcoverOptionsUpdate(
    val sessionMaxDurationMs: Long? = null,
    val debug: Boolean? = null,
    val excludedUrls: List<UrlPattern>? = null,
    val beforeSend: BeforeSend? = null,
    val enrichEvent: EnrichEvent? = null,
    val privacy: PrivacyOptions? = null,
    val tracing: TracingOptions? = null,
    val transport: TransportOptions? = null
) {
    class Builder {
        private var sessionMaxDurationMs: Long? = null
        private var debug: Boolean? = null
        private var excludedUrls: List<UrlPattern>? = null
        private var beforeSend: BeforeSend? = null
        private var enrichEvent: EnrichEvent? = null
        private var privacy: PrivacyOptions? = null
        private var tracing: TracingOptions? = null
        private var transport: TransportOptions? = null

        fun sessionMaxDurationMs(value: Long) = apply { sessionMaxDurationMs = value }

        fun debug(value: Boolean) = apply { debug = value }

        fun excludedUrls(value: List<UrlPattern>?) = apply { excludedUrls = value }

        fun beforeSend(value: BeforeSend?) = apply { beforeSend = value }

        fun enrichEvent(value: EnrichEvent?) = apply { enrichEvent = value }

        fun privacy(value: PrivacyOptions?) = apply { privacy = value }

        fun tracing(value: TracingOptions?) = apply { tracing = value }

        fun transport(value: TransportOptions?) = apply { transport = value }

        fun build() = GroundcoverOptionsUpdate(
            sessionMaxDurationMs,
            debug,
            excludedUrls,
            beforeSend,
            enrichEvent,
            privacy,
            tracing,
            transport
        )
    }
}

/**
 * [given], or [default]'s value when Java passed null where the Kotlin type says it can't: the SDK
 * is built without parameter null checks, so the null arrives here instead of throwing.
 */
private inline fun <T : Any> orDefault(given: T, default: () -> T): T {
    val nullable: T? = given
    return nullable ?: default()
}
