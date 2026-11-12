// The network shaping port. The shape cases repeat the RN SDK's
// characterization snapshots (packages/react-native/src/events/listeners/
// network-event-shape.characterization.test.ts) key for key, minus their
// `"error": undefined`, which JSON drops on the wire: a diff here is a wire
// change between the SDKs.
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/common/ids.dart';
import 'package:groundcover_rum/src/core/config/sdk_config.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/events/event_enricher.dart';
import 'package:groundcover_rum/src/core/events/network/body.dart';
import 'package:groundcover_rum/src/core/events/network/shape.dart';
import 'package:groundcover_rum/src/core/events/network/trace.dart';
import 'package:groundcover_rum/src/core/events/network/url_filter.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/core/privacy/privacy_config.dart';

NetworkCapture raw({
  String method = 'GET',
  String url = 'https://api.example.com/v1/users?token=abc&page=2',
  int? status = 200,
  Map<String, String> requestHeaders = const {},
  String requestBody = '',
  Map<String, String> responseHeaders = const {},
  String responseBody = '',
  NetworkErrorType? errorType,
}) => NetworkCapture(
  method: method,
  url: url,
  startMs: 1700000000000,
  endMs: 1700000000250,
  status: status,
  requestHeaders: requestHeaders,
  requestBody: requestBody,
  responseHeaders: responseHeaders,
  responseBody: responseBody,
  errorType: errorType,
);

({Map<String, Object?> attributes, EnrichInput shaped}) shape(
  NetworkCapture capture, {
  PrivacyOptions? privacy,
  ResolvedTracing tracing = const ResolvedTracing(),
}) {
  final shaped = shapeNetworkEvent(
    capture,
    privacy: resolvePrivacy(privacy),
    tracing: tracing,
  );
  return (attributes: flattenAttributes(shaped.attributes), shaped: shaped);
}

final class FixedIds implements IdGenerator {
  @override
  String generateId() => 'event-id';
  @override
  String generateSpanId() => '00f067aa0ba902b7';
  @override
  String generateTraceId() => '00000000000000004bf92f3577b34da6';
}

void main() {
  group('shapeNetworkEvent, as the RN snapshots', () {
    test('absolute URL, default privacy: query, headers and bodies', () {
      final out = shape(
        raw(
          method: 'post',
          requestHeaders: {
            'authorization': 'Bearer s3cret',
            'content-type': 'application/json',
            'x-plain': 'v',
          },
          requestBody: '{"password":"hunter2","name":"ada"}',
          responseHeaders: {
            'set-cookie': 'sid=1',
            'content-type': 'application/json',
          },
          responseBody: '{"ok":true}',
        ),
      );
      expect(out.attributes, {
        'gc.request.body': '{"password":"[REDACTED]","name":"ada"}',
        'gc.response.body': '{"ok":true}',
        'http.method': 'post',
        'http.path': '/v1/users',
        'http.request.headers.authorization': '[REDACTED]',
        'http.request.headers.content-type': 'application/json',
        'http.request.headers.x-plain': 'v',
        'http.request.method': 'post',
        'http.response.headers.content-type': 'application/json',
        'http.response.headers.set-cookie': '[REDACTED]',
        'http.response.status_code': '200',
        'http.route': '/v1/users',
        'http.status': '200',
        'operation.name': 'POST',
        'resource_name': '/v1/users',
        'status': '200',
        'subType': 'POST',
        'type': 'HTTP',
        'url.full':
            'https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2',
      });
      expect(out.shaped.spanName, 'POST /v1/users');
      expect(out.shaped.timestamp, 1700000000000000000);
      expect(out.shaped.endTimestamp, 1700000000250000000);
      // None on the request: the enricher draws its own.
      expect(out.shaped.traceId, '');
      expect(out.shaped.spanId, '');
    });

    test('a URL that is not absolute is kept whole', () {
      final out = shape(raw(url: '/api/items?secret=1&q=x'));
      const kept = '/api/items?secret=%5BREDACTED%5D&q=x';
      expect(out.attributes, {
        'gc.request.body': '',
        'gc.response.body': '',
        'http.method': 'GET',
        'http.path': kept,
        'http.request.method': 'GET',
        'http.response.status_code': '200',
        'http.route': kept,
        'http.status': '200',
        'operation.name': 'GET',
        'resource_name': kept,
        'status': '200',
        'subType': 'GET',
        'type': 'HTTP',
        'url.full': kept,
      });
      expect(out.shaped.spanName, 'GET $kept');
    });

    test('a failed request carries status 0 and the error type', () {
      final out = shape(
        raw(status: 0, errorType: NetworkErrorType.networkFailure),
      );
      expect(out.attributes, {
        'error.type': 'ERR_NETWORK_FAILURE',
        'gc.request.body': '',
        'gc.response.body': '',
        'http.method': 'GET',
        'http.path': '/v1/users',
        'http.request.method': 'GET',
        'http.response.status_code': '0',
        'http.route': '/v1/users',
        'http.status': '0',
        'operation.name': 'GET',
        'resource_name': '/v1/users',
        'status': '0',
        'subType': 'GET',
        'type': 'HTTP',
        'url.full':
            'https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2',
      });
    });

    test('privacy level allow skips redaction, but not built-in headers', () {
      final out = shape(
        raw(
          requestHeaders: {'authorization': 'Bearer s3cret'},
          requestBody: '{"password":"hunter2"}',
        ),
        privacy: const PrivacyOptions(level: PrivacyLevel.allow),
      );
      expect(out.attributes, {
        'gc.request.body': '{"password":"hunter2"}',
        'gc.response.body': '',
        'http.method': 'GET',
        'http.path': '/v1/users',
        'http.request.headers.authorization': '[REDACTED]',
        'http.request.method': 'GET',
        'http.response.status_code': '200',
        'http.route': '/v1/users',
        'http.status': '200',
        'operation.name': 'GET',
        'resource_name': '/v1/users',
        'status': '200',
        'subType': 'GET',
        'type': 'HTTP',
        'url.full': 'https://api.example.com/v1/users?token=abc&page=2',
      });
    });

    test('trace ids come from traceparent', () {
      const traceparent =
          '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      final out = shape(raw(requestHeaders: {'traceparent': traceparent}));
      expect(out.attributes['http.request.headers.traceparent'], traceparent);
      expect(out.shaped.traceId, '0af7651916cd43dd8448eb211c80319c');
      expect(out.shaped.spanId, 'b7ad6b7169203331');
    });

    test('trace ids from configured id headers and propagation headers', () {
      final out = shape(
        raw(
          requestHeaders: {
            'x-trace-id': '123',
            'x-custom-trace':
                '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
          },
        ),
        tracing: const ResolvedTracing(
          traceIdHeaderName: 'X-Trace-Id',
          spanIdHeaderName: 'X-Span-Id',
          propagationHeaders: ['X-Custom-Trace'],
        ),
      );
      expect(out.attributes['http.request.headers.x-trace-id'], '123');
      expect(out.shaped.traceId, '123');
      expect(out.shaped.spanId, 'b7ad6b7169203331');
    });

    test('a root URL and a missing method', () {
      final out = shape(raw(url: 'https://api.example.com', method: ''));
      expect(out.attributes, {
        'gc.request.body': '',
        'gc.response.body': '',
        'http.method': 'UNKNOWN',
        'http.path': '/',
        'http.request.method': 'UNKNOWN',
        'http.response.status_code': '200',
        'http.route': '/',
        'http.status': '200',
        'operation.name': 'UNKNOWN',
        'resource_name': '/',
        'status': '200',
        'subType': 'UNKNOWN',
        'type': 'HTTP',
        'url.full': 'https://api.example.com',
      });
      expect(out.shaped.spanName, 'UNKNOWN /');
    });
  });

  test('a body over the cap is truncated after redaction', () {
    final out = shapeNetworkEvent(
      raw(responseBody: 'x' * 30),
      privacy: resolvePrivacy(null),
      tracing: const ResolvedTracing(),
      maxBodyLength: 10,
    );
    expect(flattenAttributes(out.attributes)['gc.response.body'], 'x' * 10);
  });

  group('body', () {
    test('text by precise MIME rules, never by substring', () {
      for (final ct in [
        'application/json',
        'application/JSON; charset=utf-8',
        'text/plain',
        'application/problem+json',
        'application/atom+xml',
        'application/x-www-form-urlencoded',
        'application/graphql',
      ]) {
        expect(isTextualContentType(ct), isTrue, reason: ct);
      }
      for (final ct in [
        '',
        'application/octet-stream',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/jsonx',
        'image/png',
      ]) {
        expect(isTextualContentType(ct), isFalse, reason: ct);
      }
    });

    test('non-text bodies get a label, multipart its own', () {
      expect(classifyBody('multipart/form-data; boundary=x'), '[form data]');
      expect(classifyBody('image/png'), '[image data]');
      expect(classifyBody('application/pdf'), '[pdf data]');
      expect(classifyBody('application/x-protobuf'), '[protobuf data]');
      expect(classifyBody('application/zip'), '[archive data]');
      expect(classifyBody(''), '[binary data]');
      expect(classifyBody('application/json'), isNull);
    });

    test('known-empty responses and event streams', () {
      bool empty(String method, int status, [Map<String, String>? h]) =>
          isKnownEmptyResponse(
            method: method,
            status: status,
            headers: h ?? const {},
          );
      expect(empty('head', 200), isTrue);
      expect(empty('GET', 204), isTrue);
      expect(empty('GET', 304), isTrue);
      expect(empty('GET', 200, {'content-length': ' 0'}), isTrue);
      expect(empty('GET', 200), isFalse);
      expect(isEventStream('text/event-stream; charset=utf-8'), isTrue);
    });

    test('the cap counts UTF-8 bytes, and is inclusive', () {
      expect(capBody('', 4, 'big'), '');
      expect(capBody('abc', 4, 'big'), 'abc');
      expect(capBody('abcd', 4, 'big'), 'big');
      // Two characters, four bytes.
      expect(capBody('éé', 4, 'big'), 'big');
    });
  });

  group('trace', () {
    test('ids make a well-formed traceparent and decimal forms', () {
      final ids = generateTraceIds(FixedIds());
      expect(
        ids.traceparent,
        '00-00000000000000004bf92f3577b34da6-00f067aa0ba902b7-01',
      );
      expect(ids.decimalTraceId, '5474458728733560230');
      expect(ids.decimalSpanId, '67667974448284343');
    });

    test('headers: traceparent by default, configured ones otherwise', () {
      final ids = generateTraceIds(FixedIds());
      expect(buildTraceHeaders(const ResolvedTracing(), ids), {
        'traceparent': ids.traceparent,
      });
      expect(
        buildTraceHeaders(
          const ResolvedTracing(
            propagationHeaders: ['x-a', 'bad name', 'x-a'],
            traceIdHeaderName: 'x-trace',
            spanIdHeaderName: 'x-span',
            origin: TracingOrigin(name: 'x-origin', value: 'rum'),
          ),
          ids,
        ),
        {
          'x-origin': 'rum',
          'x-trace': ids.decimalTraceId,
          'x-span': ids.decimalSpanId,
          'x-a': ids.traceparent,
        },
      );
    });

    test('propagation URLs match in full, with only * as a wildcard', () {
      const patterns = ['https://api.example.com/*'];
      expect(
        matchesPropagationUrl(['https://api.example.com/v1'], patterns),
        isTrue,
      );
      expect(
        matchesPropagationUrl(['https://api-example.com/v1'], patterns),
        isFalse,
      );
      expect(
        matchesPropagationUrl([
          'https://evil.com/?https://api.example.com/x',
        ], patterns),
        isFalse,
      );
      expect(matchesPropagationUrl(['https://a.com'], const []), isFalse);
    });
  });

  group('shouldIgnoreUrl', () {
    test("ignores the SDK's own endpoint", () {
      expect(
        shouldIgnoreUrl(
          'https://ingest.example/json/rum',
          endpoint: 'https://ingest.example',
        ),
        isTrue,
      );
      expect(
        shouldIgnoreUrl('https://api.example/x', endpoint: 'https://ingest.x'),
        isFalse,
      );
    });

    test('exact strings, RegExps and unanchored * globs', () {
      final excluded = <Pattern>[
        '/api/health',
        RegExp(r'\.(jpg|png)$', caseSensitive: false),
        'https://cdn.example.com/*',
      ];
      bool ignored(String url) => shouldIgnoreUrl(url, excludedUrls: excluded);
      expect(ignored('/api/health'), isTrue);
      expect(ignored('/api/health/details'), isFalse);
      expect(ignored('https://example.com/image.PNG'), isTrue);
      expect(ignored('https://cdn.example.com/a.js'), isTrue);
      expect(ignored('https://cdn-example.com/a.js'), isFalse);
    });

    test('a glob opening or closing on * still matches anywhere', () {
      bool ignored(String url, String glob) =>
          shouldIgnoreUrl(url, excludedUrls: [glob]);
      expect(ignored('https://api.example/v1/health?x=1', '*/health*'), isTrue);
      expect(ignored('https://api.example/v1/healthy', '*/health'), isTrue);
      expect(ignored('https://api.example/v1/ok', '*/health*'), isFalse);
      expect(ignored('https://anything.example/', '*'), isTrue);
      expect(ignored('https://img.example/a.PNG', '*.png'), isFalse);
      expect(ignored('https://img.example/a.png', '*.png'), isTrue);
    });

    test('a ? makes a String a glob, where it matches only a dot', () {
      // As excludedUrls documents, and as the TS core does it.
      const url = 'https://auth.example.com/token?grant=refresh';
      expect(shouldIgnoreUrl(url, excludedUrls: [url]), isFalse);
      expect(
        shouldIgnoreUrl(
          'https://auth.example.com/token.grant=refresh',
          excludedUrls: [url],
        ),
        isTrue,
      );
      expect(
        shouldIgnoreUrl(url, excludedUrls: ['https://auth.example.com/token*']),
        isTrue,
      );
    });
  });
}
