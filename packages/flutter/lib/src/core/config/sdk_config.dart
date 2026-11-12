// The configuration the pipeline runs on: which groups merge one level deep on
// an update, how sessionMaxDuration is validated, how the identity merges or
// clears, and which fields an update may change. An out-of-range
// sessionMaxDuration in an update keeps the current cap.
import '../common/json.dart';
import '../common/logger.dart';
import 'constants.dart';
import 'types.dart';

/// The options with every default applied, as the pipeline reads them.
final class ResolvedOptions {
  ResolvedOptions._({
    required this.enabledEvents,
    required this.sessionSampleRate,
    required this.sessionMaxDuration,
    required this.debug,
    required this.excludedUrls,
    required this.beforeSend,
    required this.enrichEvent,
    required this.privacy,
    required this.tracing,
    required this.transport,
  });

  /// Every default, under what init fixes, before its other options apply.
  ResolvedOptions._defaults(this.enabledEvents, double? sessionSampleRate)
    : sessionSampleRate = sessionSampleRate ?? defaultSessionSampleRate,
      sessionMaxDuration = defaultSessionMaxDuration,
      debug = false,
      excludedUrls = const [],
      beforeSend = null,
      enrichEvent = null,
      privacy = const PrivacyOptions(),
      tracing = const ResolvedTracing(),
      transport = const TransportOptions();

  /// Empty means every listener.
  final List<RumEventName> enabledEvents;
  final double sessionSampleRate;
  final Duration sessionMaxDuration;
  final bool debug;
  final List<Pattern> excludedUrls;
  final BeforeSend? beforeSend;
  final EnrichEvent? enrichEvent;

  /// The privacy options as provided, merged across updates. Defaults are
  /// resolved by `resolvePrivacy`, which needs to tell an explicit level from
  /// an omitted one.
  final PrivacyOptions privacy;

  final ResolvedTracing tracing;

  /// As provided, merged across updates. The batch size and timeout are
  /// validated where they are used, in the events pool.
  final TransportOptions transport;

  bool isEnabled(RumEventName name) => isEventEnabled(enabledEvents, name);
}

/// Whether [enabled], an `enabledEvents` list, turns on [name]: an empty or
/// absent list turns on everything.
bool isEventEnabled(List<RumEventName>? enabled, RumEventName name) =>
    enabled == null || enabled.isEmpty || enabled.contains(name);

/// Tracing options with their defaults applied.
final class ResolvedTracing {
  const ResolvedTracing({
    this.propagationUrls = const [],
    this.propagationHeaders = const [],
    this.traceIdHeaderName = '',
    this.spanIdHeaderName = '',
    this.origin = const TracingOrigin(name: '', value: ''),
  });

  final List<String> propagationUrls;
  final List<String> propagationHeaders;
  final String traceIdHeaderName;
  final String spanIdHeaderName;
  final TracingOrigin origin;

  ResolvedTracing merge(TracingOptions? update) {
    if (update == null) return this;
    return ResolvedTracing(
      propagationUrls: update.propagationUrls ?? propagationUrls,
      propagationHeaders: update.propagationHeaders ?? propagationHeaders,
      traceIdHeaderName: update.traceIdHeaderName ?? traceIdHeaderName,
      spanIdHeaderName: update.spanIdHeaderName ?? spanIdHeaderName,
      origin: update.origin ?? origin,
    );
  }
}

PrivacyOptions _mergePrivacy(PrivacyOptions base, PrivacyOptions? update) {
  if (update == null) return base;
  return PrivacyOptions(
    level: update.level ?? base.level,
    maskNetworkBodies: update.maskNetworkBodies ?? base.maskNetworkBodies,
    maskNetworkQueryParams:
        update.maskNetworkQueryParams ?? base.maskNetworkQueryParams,
    maskLogs: update.maskLogs ?? base.maskLogs,
    maskErrors: update.maskErrors ?? base.maskErrors,
    sensitiveKeys: update.sensitiveKeys ?? base.sensitiveKeys,
    redact: update.redact ?? base.redact,
    maskInteractionLabels:
        update.maskInteractionLabels ?? base.maskInteractionLabels,
  );
}

TransportOptions _mergeTransport(
  TransportOptions base,
  TransportOptions? update,
) {
  if (update == null) return base;
  return TransportOptions(
    batchSize: update.batchSize ?? base.batchSize,
    batchTimeout: update.batchTimeout ?? base.batchTimeout,
    compression: update.compression ?? base.compression,
  );
}

/// [value] when it is within 1 minute to 8 hours, else [current]: the
/// default at init, and the cap the session already runs on in an update,
/// which the app chose and a bad update shouldn't undo.
Duration _normalizeSessionMaxDuration(Duration? value, Duration current) {
  if (value == null) return current;
  if (value < minSessionMaxDuration || value > maxSessionMaxDuration) {
    safeWarn(
      '[groundcover] sessionMaxDuration must be between '
      '${minSessionMaxDuration.inMilliseconds} ms (1 minute) and '
      '${maxSessionMaxDuration.inMilliseconds} ms (8 hours); using '
      '${current.inMinutes} minutes',
    );
    return current;
  }
  return value;
}

/// [base] with [update]'s non-null options applied. What init fixes is
/// [base]'s: listeners are installed then and never again, and the sampling
/// verdict is drawn then, so a later value would say one thing while the SDK
/// did another.
ResolvedOptions _merge(ResolvedOptions base, RuntimeOptions update) =>
    ResolvedOptions._(
      enabledEvents: base.enabledEvents,
      sessionSampleRate: base.sessionSampleRate,
      sessionMaxDuration: _normalizeSessionMaxDuration(
        update.sessionMaxDuration,
        base.sessionMaxDuration,
      ),
      debug: update.debug ?? base.debug,
      excludedUrls: update.excludedUrls ?? base.excludedUrls,
      beforeSend: update.beforeSend ?? base.beforeSend,
      enrichEvent: update.enrichEvent ?? base.enrichEvent,
      privacy: _mergePrivacy(base.privacy, update.privacy),
      tracing: base.tracing.merge(update.tracing),
      transport: _mergeTransport(base.transport, update.transport),
    );

/// [update] merged into [base]. New properties are made JSON data here,
/// once, rather than on every batch envelope that carries them.
RumUser _mergeUser(RumUser? base, RumUser update) => RumUser(
  id: update.id ?? base?.id,
  email: update.email ?? base?.email,
  name: update.name ?? base?.name,
  role: update.role ?? base?.role,
  organization: update.organization ?? base?.organization,
  properties: switch (update.properties) {
    final properties? => toJsonMap(properties),
    null => base?.properties,
  },
);

/// The configuration the pipeline runs on: the init config, with defaults
/// applied and updates merged in.
final class SdkConfig {
  SdkConfig(GroundcoverConfig input)
    : dsn = input.dsn,
      appId = input.appId,
      cluster = input.cluster,
      apiKey = input.apiKey,
      environment = input.environment,
      namespace = input.namespace ?? '',
      releaseId = input.releaseId,
      user = switch (input.user) {
        final user? => _mergeUser(null, user),
        null => null,
      },
      options = _merge(
        ResolvedOptions._defaults(
          input.options?.enabledEvents ?? const [],
          input.options?.sessionSampleRate,
        ),
        input.options ?? const GroundcoverOptions(),
      );

  String dsn;
  String appId;
  String cluster;
  String apiKey;
  String environment;
  String namespace;
  String? releaseId;
  RumUser? user;
  ResolvedOptions options;

  /// The ingest base URL: the DSN, with `https://` when it names no scheme.
  String get endpoint => dsn.startsWith('http') ? dsn : 'https://$dsn';

  void update(GroundcoverConfigUpdate update) {
    final options = update.options;
    if (options != null) this.options = _merge(this.options, options);

    // An explicit clear wins over a new identity in the same update; a new
    // identity merges into the current one.
    if (update.clearUser) {
      user = null;
    } else if (update.user != null) {
      user = _mergeUser(user, update.user!);
    }

    if (_present(update.dsn)) dsn = update.dsn!;
    if (_present(update.apiKey)) apiKey = update.apiKey!;
    if (_present(update.cluster)) cluster = update.cluster!;
    if (_present(update.environment)) environment = update.environment!;
    if (_present(update.namespace)) namespace = update.namespace!;
    if (_present(update.releaseId)) releaseId = update.releaseId;
  }

  static bool _present(String? value) => value != null && value.isNotEmpty;
}
