// Generate ids, pick the headers a traced request carries, decide whether a
// request is traced, and read the ids back off a captured request. Setting a
// header stays with the caller.
import '../../common/ids.dart';
import '../../config/sdk_config.dart';

typedef TraceIds = ({
  String traceId,
  String spanId,

  /// W3C `00-<32 hex>-<16 hex>-01`.
  String traceparent,

  /// The ids in base 10, for `traceIdHeaderName` / `spanIdHeaderName`.
  String decimalTraceId,
  String decimalSpanId,
});

TraceIds generateTraceIds(IdGenerator ids) {
  final spanId = ids.generateSpanId();
  final traceId = ids.generateTraceId();
  String decimal(String hex) =>
      BigInt.tryParse(hex, radix: 16)?.toString() ?? hex;
  return (
    traceparent: '00-$traceId-$spanId-01',
    traceId: traceId,
    spanId: spanId,
    decimalTraceId: decimal(traceId),
    decimalSpanId: decimal(spanId),
  );
}

final _token = RegExp(r"^[a-zA-Z0-9!#$&'*+\-.^_`|~]+$");

/// RFC 9110 token: a name a host would refuse never reaches a setter.
bool isValidHeaderName(String name) => _token.hasMatch(name);

/// The headers a traced request carries, by name. Invalid names are
/// dropped; a name configured twice is set once (last wins).
Map<String, String> buildTraceHeaders(ResolvedTracing tracing, TraceIds ids) {
  final out = <String, String>{};
  void set(String name, String value) {
    if (isValidHeaderName(name)) out[name] = value;
  }

  if (tracing.origin.name.isNotEmpty) {
    set(tracing.origin.name, tracing.origin.value);
  }
  if (tracing.traceIdHeaderName.isNotEmpty) {
    set(tracing.traceIdHeaderName, ids.decimalTraceId);
  }
  if (tracing.spanIdHeaderName.isNotEmpty) {
    set(tracing.spanIdHeaderName, ids.decimalSpanId);
  }
  final names = tracing.propagationHeaders.isNotEmpty
      ? tracing.propagationHeaders
      : const ['traceparent'];
  for (final name in names) {
    set(name, ids.traceparent);
  }
  return out;
}

final _regexMeta = RegExp(r'[.+?^${}()|[\]\\]');

/// Whether a request is traced: any pattern matches any candidate in full.
/// Only `*` is a wildcard; every other metacharacter is escaped, or a `.`
/// would send trace headers to `api-example.com`.
bool matchesPropagationUrl(List<String> candidates, List<String> patterns) {
  if (patterns.isEmpty) return false;
  return patterns.any((pattern) {
    try {
      final escaped = pattern
          .replaceAllMapped(_regexMeta, (m) => '\\${m[0]}')
          .replaceAll('*', '.*');
      final regex = RegExp('^$escaped\$');
      return candidates.any(regex.hasMatch);
    } catch (_) {
      return false;
    }
  });
}

/// The trace and span ids a captured request was sent with, or "" for each
/// it lacks. Configured id headers win; otherwise the first propagation
/// header (or `traceparent`) is parsed as W3C. Names match case-insensitively.
({String traceId, String spanId}) extractTraceIds(
  Map<String, String> headers,
  ResolvedTracing tracing,
) {
  final lower = {
    for (final MapEntry(:key, :value) in headers.entries)
      key.toLowerCase(): value,
  };
  String read(String name) =>
      name.isEmpty ? '' : (lower[name.toLowerCase()] ?? '');

  var traceId = read(tracing.traceIdHeaderName);
  var spanId = read(tracing.spanIdHeaderName);
  if (traceId.isEmpty || spanId.isEmpty) {
    var traceparent = '';
    for (final name in tracing.propagationHeaders) {
      traceparent = read(name);
      if (traceparent.isNotEmpty) break;
    }
    if (traceparent.isEmpty) traceparent = read('traceparent');
    final parts = traceparent.split('-');
    if (parts.length == 4 && parts[0] == '00') {
      if (traceId.isEmpty && parts[1].length == 32) traceId = parts[1];
      if (spanId.isEmpty && parts[2].length == 16) spanId = parts[2];
    }
  }
  return (traceId: traceId, spanId: spanId);
}
