// A captured request as the `network` event the backend ingests. Everything
// after interception: route derivation, query/header/body redaction, body
// truncation, trace ids and the span name.
import '../../common/text.dart';
import '../../common/time.dart';
import '../../config/sdk_config.dart';
import '../../config/types.dart';
import '../../privacy/privacy_config.dart';
import '../../privacy/redaction.dart';
import '../captures.dart';
import '../event_enricher.dart';
import 'body.dart';
import 'trace.dart';

/// Request/response headers as sent on the wire: sensitive values redacted,
/// each value truncated. Built-in sensitive headers are always stripped;
/// `allow` only opts out of the user's sensitiveKeys and redactor.
Map<String, String> formatNetworkHeaders(
  Map<String, String> headers,
  EffectivePrivacy privacy,
) {
  final redacted = redactHeaders(
    headers,
    privacy.level == PrivacyLevel.allow
        ? const RedactOptions()
        : privacy.redactOptions(),
  );
  return {
    for (final MapEntry(:key, :value) in redacted.entries) key: truncate(value),
  };
}

// RN's absolute-URL path extractor: scheme://authority(/path)?(?#...).
final _urlPath = RegExp(
  r'^[a-z][a-z0-9+.-]*://[^/?#]*([^?#]*)',
  caseSensitive: false,
);

/// The route of [url]: its path, without the query; `/` for a root URL. A
/// URL that isn't absolute is kept whole.
String networkPath(String url) {
  final match = _urlPath.firstMatch(url);
  if (match == null) return url;
  final path = match[1] ?? '';
  return path.isEmpty ? '/' : path;
}

EnrichInput shapeNetworkEvent(
  NetworkCapture raw, {
  required EffectivePrivacy privacy,
  required ResolvedTracing tracing,
  int maxBodyLength = maxNetworkBodyBytes,
}) {
  final queryOpts = privacy.redactOptions(RedactKind.query);
  var path = networkPath(raw.url);
  var fullUrl = raw.url;
  if (privacy.shouldMaskNetworkQueryParams) {
    // A parsed route has no query (a no-op); an unparseable URL kept whole does.
    path = redactUrl(path, queryOpts);
    fullUrl = redactUrl(fullUrl, queryOpts);
  }

  final method = raw.method.isEmpty ? 'UNKNOWN' : raw.method.toUpperCase();
  // As sent (the caller's case), or UNKNOWN like every other method field.
  final sentMethod = raw.method.isEmpty ? 'UNKNOWN' : raw.method;
  final status = raw.status?.toString();
  final ids = extractTraceIds(raw.requestHeaders, tracing);

  // Redacted BEFORE truncating, so the body stays parseable JSON for
  // key-based redaction.
  String body(String text, RedactKind kind) => truncate(
    privacy.shouldMaskNetworkBodies
        ? redactBody(text, privacy.redactOptions(kind))
        : text,
    maxLength: maxBodyLength,
  );

  return EnrichInput(
    type: 'network',
    timestamp: _observedAt(raw.startMs),
    endTimestamp: _observedAt(raw.endMs),
    // The normalized method, like operation.name: `post` and `POST` are one
    // span.
    spanName: '$method $path',
    traceId: ids.traceId,
    spanId: ids.spanId,
    attributes: {
      'type': 'HTTP',
      'operation': {'name': method},
      'resource_name': path,
      'status': ?status,
      'subType': method,
      'url': {'full': fullUrl},
      'http': {
        'route': path,
        'path': path,
        'method': sentMethod,
        'status': ?status,
        'request': {
          'headers': formatNetworkHeaders(raw.requestHeaders, privacy),
          'method': sentMethod,
        },
        'response': {
          'headers': formatNetworkHeaders(raw.responseHeaders, privacy),
          'status_code': ?status,
        },
      },
      if (raw.errorType case final type?) 'error': {'type': type.wireName},
      'gc': {
        'request': {'body': body(raw.requestBody, RedactKind.requestBody)},
        'response': {'body': body(raw.responseBody, RedactKind.responseBody)},
      },
    },
  );
}

// An interceptor's clock reading in ns, or null when it isn't a usable time,
// so the enricher stamps the event instead.
int? _observedAt(int ms) => ms > 0 ? msToNs(ms) : null;
