/// The SDK's configuration surface.
///
/// Names mirror `@groundcover/react-native` one to one, so its README and the
/// dashboards' vocabulary carry over. Only the types are Dart's: a [Duration]
/// where RN takes milliseconds, a [Pattern] where RN takes `string | RegExp`.
///
/// These live in the core, not the API layer, because the pipeline consumes
/// them and the core may import nothing outside itself.
library;

import '../events/rum_event.dart';

/// The listeners `enabledEvents` switches, by name: the same names as the
/// React Native SDK's `enabledEvents`.
enum RumEventName {
  interaction,
  network,
  logs,
  navigation,
  exceptions,

  /// Native crashes, reported on the next launch under the session they
  /// happened in.
  crashes,

  /// App hangs: main-thread stalls the app recovered from, from the native
  /// engine's watchdog. Dart runs on that thread, so a long Dart stall is one.
  hangs,

  /// Frame vitals: slow and frozen frames, and the time they lost, per
  /// screen, from Flutter's own frame timings.
  vitals,

  /// App start (cold, warm, hot) and time to interactive.
  appStart,
}

/// The master switch for data masking.
enum PrivacyLevel {
  /// Masks sensitive data only: sensitive-key matches, `GroundcoverPrivate`
  /// widgets, and network, log and error payloads. The default.
  maskSensitive('mask-sensitive'),

  /// Also masks the label, hint and value text of every tap and input,
  /// whatever [PrivacyOptions.maskInteractionLabels] says.
  maskAll('mask-all'),

  /// Opts out of masking, except credential headers: authorization, cookies,
  /// and names with token, key, secret, password, auth, bearer or credential.
  allow('allow');

  const PrivacyLevel(this.wireName);

  /// The name RN and the browser SDK use for this level.
  final String wireName;
}

/// The event surface a [RedactField] belongs to.
enum RedactKind {
  requestBody('request-body'),
  responseBody('response-body'),
  query('query'),
  header('header'),
  log('log'),
  error('error');

  const RedactKind(this.wireName);

  /// The name RN and the browser SDK use for this kind.
  final String wireName;
}

/// One leaf value the redaction walk visits, as a [Redactor] sees it.
final class RedactField {
  const RedactField({
    required this.key,
    required this.value,
    required this.path,
    required this.kind,
    required this.sensitive,
  });

  /// The leaf's own key; `''` for a whole-string field (a log or error
  /// message).
  final String key;

  /// The leaf value: a string, number, bool or null, never a map or list.
  final Object? value;

  /// The full key path to the leaf; empty for a whole-string field.
  final List<String> path;

  /// Which event surface the leaf came from. A header's name is in [key].
  final RedactKind kind;

  /// Whether the built-in patterns or `sensitiveKeys` would redact it.
  final bool sensitive;
}

/// A per-leaf redaction hook. Return a replacement string, number or bool,
/// or null to keep the SDK's default (`'[REDACTED]'` when the field is
/// [RedactField.sensitive], the value otherwise), so a hook that cares about
/// one field cannot switch masking off elsewhere.
///
/// RN's hook can also replace a value with `null`; a Dart hook cannot, since
/// null is how it defers.
typedef Redactor = Object? Function(RedactField field);

/// Inspects each event before it is queued; return false to drop it.
typedef BeforeSend = bool Function(RumEvent event);

/// Changes each event before it is queued and returns it.
typedef EnrichEvent = RumEvent Function(RumEvent event);

/// Unified data masking for every captured surface. On by default, at
/// [PrivacyLevel.maskSensitive].
final class PrivacyOptions {
  const PrivacyOptions({
    this.level,
    this.maskNetworkBodies,
    this.maskNetworkQueryParams,
    this.maskLogs,
    this.maskErrors,
    this.sensitiveKeys,
    this.redact,
    this.maskInteractionLabels,
  });

  final PrivacyLevel? level;

  /// Redact network request and response bodies. On unless [level] is
  /// [PrivacyLevel.allow].
  final bool? maskNetworkBodies;

  /// Redact URL query parameters. On unless [level] is [PrivacyLevel.allow].
  final bool? maskNetworkQueryParams;

  /// Redact log messages and attributes. On unless [level] is
  /// [PrivacyLevel.allow].
  final bool? maskLogs;

  /// Redact error messages and metadata; stack frames are sent as they are.
  /// On unless [level] is [PrivacyLevel.allow].
  final bool? maskErrors;

  /// Extra case-insensitive key substrings to treat as sensitive, added to
  /// the built-in patterns.
  final List<String>? sensitiveKeys;

  /// A per-leaf hook; see [Redactor]. For whole-event changes use
  /// [GroundcoverOptions.enrichEvent].
  final Redactor? redact;

  /// Mask the label, hint and value text of every interaction under any
  /// level. Always on under [PrivacyLevel.maskAll]; the role, state,
  /// component and component path stay, being structural.
  final bool? maskInteractionLabels;
}

/// The `origin` tag stamped on injected trace headers.
final class TracingOrigin {
  const TracingOrigin({required this.name, required this.value});

  final String name;
  final String value;
}

/// Distributed-tracing header propagation for outgoing requests.
final class TracingOptions {
  const TracingOptions({
    this.propagationUrls,
    this.propagationHeaders,
    this.traceIdHeaderName,
    this.spanIdHeaderName,
    this.origin,
  });

  /// Request URLs that get a `traceparent` header: whole-URL matches in
  /// which only `*` is a wildcard.
  final List<String>? propagationUrls;

  /// Header names that carry the W3C trace context on traced requests. When
  /// set, they replace `traceparent`: list it too to keep it.
  final List<String>? propagationHeaders;

  /// A header that also carries the trace id.
  final String? traceIdHeaderName;

  /// A header that also carries the span id.
  final String? spanIdHeaderName;

  final TracingOrigin? origin;
}

/// Batching and delivery of outgoing batches.
final class TransportOptions {
  const TransportOptions({this.batchSize, this.batchTimeout, this.compression});

  /// Events buffered before a batch is sent. Defaults to 10; 0 sends every
  /// event on its own.
  final int? batchSize;

  /// Longest a batch waits before it is sent anyway. Defaults to 10 s.
  final Duration? batchTimeout;

  /// Gzip outgoing batches. Defaults to true.
  final bool? compression;
}

/// A user identity, stamped on every batch once set.
final class RumUser {
  const RumUser({
    this.id,
    this.email,
    this.name,
    this.role,
    this.organization,
    this.properties,
  });

  final String? id;
  final String? email;
  final String? name;
  final String? role;
  final String? organization;
  final Map<String, Object?>? properties;

  /// The identity as the session envelope carries it: only the fields set.
  Map<String, Object?> toJson() => {
    if (id != null) 'id': id,
    if (email != null) 'email': email,
    if (name != null) 'name': name,
    if (role != null) 'role': role,
    if (organization != null) 'organization': organization,
    if (properties != null) 'properties': properties,
  };
}

/// The options `GroundcoverRum.updateConfig` can change after init, which
/// both [GroundcoverOptions] and [GroundcoverOptionsUpdate] carry. Null
/// means the default at init, and "unchanged" in an update. Sealed: adding
/// one later breaks no app.
sealed class RuntimeOptions {
  /// The target longest session. Enforced lazily, on the next activity, so
  /// an idle session keeps its id past the cap. Defaults to 4 hours; must be
  /// between 1 minute and 8 hours, or the default applies at init and the
  /// current value is kept in an update. Sessions also end after 30 minutes
  /// without user input.
  Duration? get sessionMaxDuration;

  bool? get debug;

  /// Requests the network capture skips, as in the other SDKs: a [RegExp]
  /// matches anywhere in the URL; a [String] with `*` or `?` is a glob that
  /// also matches anywhere, where `*` is any run of characters and `?`, for
  /// now, only a literal `.` (so a URL with a query string needs a [RegExp]
  /// or a `*` in place of its `?`); and any other [String] must equal the
  /// whole URL. The SDK's own ingest requests are always skipped.
  List<Pattern>? get excludedUrls;

  /// Receives each event with dot-flattened attributes; see [RumEvent].
  BeforeSend? get beforeSend;

  /// Receives each event with dot-flattened attributes; see [RumEvent].
  EnrichEvent? get enrichEvent;

  PrivacyOptions? get privacy;
  TracingOptions? get tracing;
  TransportOptions? get transport;
}

/// Options for [GroundcoverConfig]: the [RuntimeOptions], plus what is
/// chosen once, at init. Every field is optional; null means the default.
final class GroundcoverOptions implements RuntimeOptions {
  const GroundcoverOptions({
    this.enabledEvents,
    this.sessionSampleRate,
    this.sessionMaxDuration,
    this.debug,
    this.excludedUrls,
    this.beforeSend,
    this.enrichEvent,
    this.privacy,
    this.tracing,
    this.transport,
    this.appVersion,
    this.appBuild,
    this.native,
  });

  /// Which listeners to enable. Empty means all. Listeners are installed at
  /// init and never again, so this is fixed then.
  final List<RumEventName>? enabledEvents;

  /// The share of sessions to record, from 0 to 1. Defaults to 1. Decided
  /// once per session, at init.
  final double? sessionSampleRate;

  @override
  final Duration? sessionMaxDuration;
  @override
  final bool? debug;
  @override
  final List<Pattern>? excludedUrls;
  @override
  final BeforeSend? beforeSend;
  @override
  final EnrichEvent? enrichEvent;
  @override
  final PrivacyOptions? privacy;
  @override
  final TracingOptions? tracing;
  @override
  final TransportOptions? transport;

  /// The app version on the session envelope, when the bundle's own should
  /// not be used. Fixed at init.
  final String? appVersion;

  /// The app build on the session envelope, when the bundle's own should not
  /// be used. Fixed at init.
  final String? appBuild;

  /// Tuning for the native features. Fixed at init.
  final NativeOptions? native;
}

/// Tuning for the native features: hangs, frame vitals and time to
/// interactive. Mirrors RN's `options.native`. Tuning only:
/// [GroundcoverOptions.enabledEvents] is the one way to turn a feature off,
/// so none of these gates capture.
final class NativeOptions {
  const NativeOptions({this.hangThreshold, this.vitalsMaxSegment, this.tti});

  /// How long the main thread must be blocked before a hang is reported.
  /// Dart runs on that thread (from Flutter 3.29), so a long Dart stall
  /// counts too. Defaults to 2 s on iOS and 5 s on Android, deliberately:
  /// iOS has no system hang bar, and Android's own ANR threshold is 5 s. A
  /// value outside 250 ms to 60 s falls back to the default.
  final HangThreshold? hangThreshold;

  /// Longest a frame-vitals segment may run before it is closed anyway.
  /// Defaults to 60 s; a value outside 1 s to 5 minutes falls back to it.
  /// Segments normally end on a screen change or on backgrounding, so this
  /// is a safety valve, not a cadence: lowering it splits one screen's stats
  /// into partial segments.
  final Duration? vitalsMaxSegment;

  /// Which moment counts as interactive for time to interactive. Defaults
  /// to [TtiMode.auto].
  final TtiMode? tti;
}

/// [NativeOptions.hangThreshold]: one threshold for both platforms, or one
/// per platform, as RN's `number | {ios, android}`.
final class HangThreshold {
  /// The same threshold on both platforms. Prefer
  /// [HangThreshold.perPlatform] when tuning: the defaults differ for a
  /// reason.
  const HangThreshold(Duration threshold)
    : ios = threshold,
      android = threshold;

  /// A threshold per platform. A platform left out keeps its own default,
  /// never the other platform's value.
  const HangThreshold.perPlatform({this.ios, this.android});

  final Duration? ios;
  final Duration? android;
}

/// Which moment counts as interactive for time to interactive (TTI).
enum TtiMode {
  /// The first screen landing: the navigator observer's first route, or the
  /// first manual navigation. A floor, not a promise: it comes before that
  /// screen's own data loads.
  auto,

  /// When the app calls `GroundcoverRum.markAppInteractive()`. The honest
  /// measure: call it once the first screen is genuinely usable.
  manual,
}

/// What `updateConfig` may change in the options: the [RuntimeOptions]. What
/// is fixed at init (`enabledEvents`, `sessionSampleRate`, `appVersion`,
/// `appBuild`) isn't here, so an update can't look as if it changed it. Null
/// fields stay as they are.
final class GroundcoverOptionsUpdate implements RuntimeOptions {
  const GroundcoverOptionsUpdate({
    this.sessionMaxDuration,
    this.debug,
    this.excludedUrls,
    this.beforeSend,
    this.enrichEvent,
    this.privacy,
    this.tracing,
    this.transport,
  });

  @override
  final Duration? sessionMaxDuration;
  @override
  final bool? debug;
  @override
  final List<Pattern>? excludedUrls;
  @override
  final BeforeSend? beforeSend;
  @override
  final EnrichEvent? enrichEvent;
  @override
  final PrivacyOptions? privacy;
  @override
  final TracingOptions? tracing;
  @override
  final TransportOptions? transport;
}

/// What `GroundcoverRum.init` takes.
final class GroundcoverConfig {
  const GroundcoverConfig({
    required this.apiKey,
    required this.dsn,
    required this.cluster,
    required this.environment,
    required this.appId,
    this.namespace,
    this.releaseId,
    this.user,
    this.sessionId,
    this.options,
  });

  final String apiKey;

  /// The ingest host, with or without a scheme; batches go to
  /// `{dsn}/json/rum`.
  final String dsn;

  final String cluster;
  final String environment;

  /// The application's identity. Must not be blank.
  final String appId;

  final String? namespace;
  final String? releaseId;
  final RumUser? user;

  /// Start with this session id instead of a generated or persisted one.
  final String? sessionId;

  final GroundcoverOptions? options;
}

/// What `GroundcoverRum.updateConfig` takes: [GroundcoverConfig] minus what
/// is fixed at init (`appId`, `sessionId`, and the init-only options).
final class GroundcoverConfigUpdate {
  const GroundcoverConfigUpdate({
    this.apiKey,
    this.dsn,
    this.cluster,
    this.environment,
    this.namespace,
    this.releaseId,
    this.user,
    this.clearUser = false,
    this.options,
  });

  final String? apiKey;
  final String? dsn;
  final String? cluster;
  final String? environment;
  final String? namespace;
  final String? releaseId;

  /// A new identity. To remove the current one, set [clearUser] instead;
  /// this is RN's `updateConfig({ user: null })`.
  final RumUser? user;

  final bool clearUser;

  /// Options to change; null fields stay as they are.
  final GroundcoverOptionsUpdate? options;
}
