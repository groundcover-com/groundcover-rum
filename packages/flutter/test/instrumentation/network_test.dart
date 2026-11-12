// HTTP capture through the dart:io override, against a loopback server: what
// the caller gets is untouched, and what the pipeline gets is the request as
// sent and the response as received.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/common/patch.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/instrumentation/network.dart';
import 'package:http/http.dart' as http;

import '../support/recording_pipeline.dart';

late HttpServer server;
late String base;

/// Under the 5,000-byte cap as text, over it as gzip stored without
/// compression (level 0), which only adds its framing.
final storedText = 'x' * 4980;
List<int> storedGzip() => GZipCodec(level: 0).encode(utf8.encode(storedText));
final received = <String, HttpHeaders>{};

Future<void> serve(HttpRequest request) async {
  if (request.uri.path == '/ws') {
    // Upgraded before anything reads the request.
    final socket = await WebSocketTransformer.upgrade(request);
    await socket.close();
    return;
  }
  final bytes = await request.fold<List<int>>(
    [],
    (all, chunk) => all..addAll(chunk),
  );
  received[request.uri.path] = request.headers;
  final response = request.response;
  switch (request.uri.path) {
    case '/echo':
      response.headers.contentType = ContentType.json;
      response.write(
        jsonEncode({'method': request.method, 'bytes': bytes.length}),
      );
    case '/large':
      response.headers.contentType = ContentType.json;
      response.write(jsonEncode({'filler': 'x' * 6000}));
    case '/sized':
      response.headers.contentType = ContentType.text;
      response.write('x' * int.parse(request.uri.queryParameters['n']!));
    case '/png':
      response.headers.contentType = ContentType('image', 'png');
      response.add(List.filled(64, 7));
    case '/empty':
      response.statusCode = HttpStatus.noContent;
    case '/chunks':
      response.headers.contentType = ContentType.text;
      response.bufferOutput = false;
      response.write('first');
      await response.flush();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      response.write('second');
    case '/slow':
      await Future<void>.delayed(const Duration(seconds: 2));
      response.write('late');
    case '/cut':
      // Promises 100 bytes, sends 7, and hangs up.
      response.headers.contentType = ContentType.text;
      response.contentLength = 100;
      final socket = await response.detachSocket();
      socket.write('partial');
      await socket.flush();
      socket.destroy();
      return;
    case '/gzip':
      response.headers
        ..contentType = ContentType.json
        ..set(HttpHeaders.contentEncodingHeader, 'gzip');
      response.add(gzip.encode(utf8.encode('{"secret":"s3cr3t"}')));
    case '/gzip-tiny':
      // A real server's gzip: Content-Length is the compressed size, which
      // gzip's own overhead makes larger than the 2 bytes decoded.
      final body = gzip.encode(utf8.encode('{}'));
      response.headers
        ..contentType = ContentType.json
        ..set(HttpHeaders.contentEncodingHeader, 'gzip')
        ..contentLength = body.length;
      response.add(body);
    case '/gzip-stored':
      final body = storedGzip();
      response.headers
        ..contentType = ContentType.text
        ..set(HttpHeaders.contentEncodingHeader, 'gzip')
        ..contentLength = body.length;
      response.add(body);
    case '/gzip-large':
      // Small gzipped, over the cap decoded.
      final body = gzip.encode(utf8.encode('x' * 100000));
      response.headers
        ..contentType = ContentType.text
        ..set(HttpHeaders.contentEncodingHeader, 'gzip')
        ..contentLength = body.length;
      response.add(body);
    case '/redirect':
      // With a body, as Express and nginx send one.
      response
        ..statusCode = HttpStatus.found
        ..headers.set(HttpHeaders.locationHeader, '/echo')
        ..headers.contentType = ContentType.text
        ..write('Found. Redirecting to /echo');
    case '/brotli':
      // dart:io never decodes brotli, whatever autoUncompress says.
      response.headers
        ..contentType = ContentType.json
        ..set(HttpHeaders.contentEncodingHeader, 'br');
      response.add([0x8b, 0x05, 0x80, 0x7b, 0x7d, 0x03]);
  }
  await response.close();
}

void main() {
  late RecordingPipeline pipeline;
  late PatchSet capture;
  // A short wait for an unread body, so the tests that leave one unread
  // finish quickly; still longer than the async work they do before reading.
  void install() => installHttpCapture(
    capture,
    () => pipeline,
    unreadGrace: const Duration(milliseconds: 500),
  );

  List<NetworkCapture> captured() =>
      pipeline.captures.whereType<NetworkCapture>().toList();

  // A capture is submitted when its body ends, a moment after the caller's
  // read completes: give the event loop a turn.
  Future<NetworkCapture> single() async {
    await pumpEventQueue();
    return captured().single;
  }

  setUpAll(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen(serve);
    base = 'http://127.0.0.1:${server.port}';
  });

  tearDownAll(() => server.close(force: true));

  setUp(() {
    // The test binding answers every request with a 400 through its own
    // override; these talk to a real server.
    final binding = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = binding);
    received.clear();
    pipeline = RecordingPipeline();
    capture = PatchSet();
    install();
    addTearDown(capture.restore);
  });

  test('a GET carries the trace headers, and is captured whole', () async {
    pipeline.traceHeaders = (url) => {'traceparent': 'tp-for-$url'};
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.getUrl(Uri.parse('$base/echo?q=1'));
    final body = await utf8.decodeStream(await request.close());
    expect(jsonDecode(body), {'method': 'GET', 'bytes': 0});
    expect(received['/echo']!.value('traceparent'), 'tp-for-$base/echo?q=1');

    final net = await single();
    expect(net.method, 'GET');
    expect(net.url, '$base/echo?q=1');
    expect(net.status, 200);
    expect(net.requestHeaders['traceparent'], 'tp-for-$base/echo?q=1');
    expect(net.responseHeaders['content-type'], startsWith('application/json'));
    expect(net.responseBody, body);
    expect(net.requestBody, '');
    expect(net.errorType, isNull);
    expect(net.endMs, greaterThanOrEqualTo(net.startMs));
  });

  test('open(host, port, path) reports the URL dart:io sends', () async {
    final client = HttpClient();
    addTearDown(client.close);
    for (final path in ['/echo?q=1', '//users/1', '/a#b']) {
      pipeline.captures.clear();
      final request = await client.get('127.0.0.1', server.port, path);
      await (await request.close()).drain<void>();
      expect((await single()).url, '${request.uri}', reason: path);
    }
  });

  test(
    "the request headers are the caller's and the SDK's, not dart:io's",
    () async {
      pipeline.traceHeaders = (_) => {'traceparent': 'tp-sdk'};
      await http.post(
        Uri.parse('$base/echo'),
        headers: {
          'content-type': 'application/json',
          'x-custom': 'yes',
          // A caller's trace header loses to the SDK's, as in RN's fetch path.
          'traceparent': 'tp-caller',
        },
        body: '{}',
      );
      final net = await single();
      expect(net.requestHeaders, {
        'content-type': 'application/json',
        'x-custom': 'yes',
        'traceparent': 'tp-sdk',
      });
      expect(received['/echo']!.value('traceparent'), 'tp-sdk');
    },
  );

  test('a request that fails to connect keeps its trace headers', () async {
    pipeline.traceHeaders = (_) => {'traceparent': 'tp-sdk'};
    final closed = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = closed.port;
    await closed.close();
    await expectLater(
      http.get(Uri.parse('http://127.0.0.1:$port/x')),
      throwsA(isA<http.ClientException>()),
    );
    expect((await single()).requestHeaders, {'traceparent': 'tp-sdk'});
  });

  test('package:http POST: the body goes out intact and is captured', () async {
    final response = await http.post(
      Uri.parse('$base/echo'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'hello': 'mobile'}),
    );
    expect(jsonDecode(response.body), {'method': 'POST', 'bytes': 18});
    final net = await single();
    expect(net.method, 'POST');
    expect(net.requestBody, '{"hello":"mobile"}');
    expect(net.responseBody, response.body);
  });

  test('a body written with write() is captured', () async {
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.postUrl(Uri.parse('$base/echo'));
    request.headers.contentType = ContentType.text;
    request
      ..write('one ')
      ..writeAll(['two', 'three'], ',')
      ..writeln('!');
    await (await request.close()).drain<void>();
    expect((await single()).requestBody, 'one two,three!\n');
  });

  test('writeAll iterates what it is given once, as dart:io does', () async {
    // A stateful source, read once: a copy that iterated it first would
    // leave dart:io an empty body to send.
    final source = ['a', 'b', 'c'].iterator;
    Iterable<String> rows() sync* {
      while (source.moveNext()) {
        yield source.current;
      }
    }

    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.postUrl(Uri.parse('$base/echo'));
    request.headers.contentType = ContentType.text;
    request.writeAll(rows(), ',');
    final response = await request.close();
    // What the server received: all five bytes of 'a,b,c'.
    expect(jsonDecode(await utf8.decodeStream(response)), {
      'method': 'POST',
      'bytes': 5,
    });
    expect((await single()).requestBody, 'a,b,c');
  });

  test('text written past the cap is too large, however it arrives', () async {
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.postUrl(Uri.parse('$base/echo'));
    request.headers.contentType = ContentType.text;
    request
      ..write('z' * 4000)
      ..write('z' * 4000)
      ..write('after the cap');
    await (await request.close()).drain<void>();
    expect((await single()).requestBody, '[request body too large]');
  });

  test('a non-text request body is labelled, never decoded', () async {
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.postUrl(Uri.parse('$base/echo'));
    request.headers.contentType = ContentType.binary;
    request.add([0, 1, 2, 255]);
    await (await request.close()).drain<void>();
    expect((await single()).requestBody, '[binary data]');
  });

  test(
    'a response past the cap is the placeholder; the caller gets it all',
    () async {
      final response = await http.get(Uri.parse('$base/large'));
      expect(response.body.length, greaterThan(6000));
      expect((await single()).responseBody, '[response body too large]');
    },
  );

  for (final n in [4999, 5000, 5001]) {
    final whole = n < 5000;
    test(
      'a $n-byte body each way is ${whole ? 'kept' : 'too large'}',
      () async {
        final client = HttpClient();
        addTearDown(client.close);
        final request = await client.postUrl(Uri.parse('$base/sized?n=$n'));
        request.headers.contentType = ContentType.text;
        request.add(utf8.encode('y' * n));
        final body = await utf8.decodeStream(await request.close());
        expect(body, hasLength(n));
        final net = await single();
        expect(net.requestBody, whole ? 'y' * n : '[request body too large]');
        expect(net.responseBody, whole ? body : '[response body too large]');
      },
    );
  }

  test('a binary response is labelled, and still reaches the caller', () async {
    final response = await http.get(Uri.parse('$base/png'));
    expect(response.bodyBytes, List.filled(64, 7));
    expect((await single()).responseBody, '[image data]');
  });

  test('a 204 is an empty body', () async {
    final response = await http.get(Uri.parse('$base/empty'));
    expect(response.statusCode, 204);
    final net = await single();
    expect(net.status, 204);
    expect(net.responseBody, '');
  });

  test('a body consumed by drain() is still reported', () async {
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.getUrl(Uri.parse('$base/echo'));
    await (await request.close()).drain<void>();
    expect((await single()).responseBody, contains('GET'));
  });

  test('a body cancelled before its end is unavailable', () async {
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.getUrl(Uri.parse('$base/chunks'));
    final response = await request.close();
    await response.first;
    expect((await single()).responseBody, '[response body unavailable]');
  });

  test(
    'a refused connection is status 0 and the caller still sees the error',
    () async {
      final closed = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final port = closed.port;
      await closed.close();
      await expectLater(
        http.get(Uri.parse('http://127.0.0.1:$port/x')),
        throwsA(isA<http.ClientException>()),
      );
      final net = await single();
      expect(net.status, 0);
      expect(net.errorType, NetworkErrorType.networkFailure);
      expect(net.method, 'GET');
    },
  );

  test('an aborted request is not reported', () async {
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    final request = await client.getUrl(Uri.parse('$base/slow'));
    Timer(const Duration(milliseconds: 100), request.abort);
    await expectLater(request.close(), throwsA(anything));
    await pumpEventQueue();
    expect(captured(), isEmpty);
  });

  test('an abort after the response arrived changes nothing', () async {
    // dart:io ignores it once the response is in, and the body streams on.
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    final request = await client.getUrl(Uri.parse('$base/chunks'));
    final response = await request.close();
    request.abort();
    expect(await utf8.decodeStream(response), 'firstsecond');
    final net = await single();
    expect(net.status, 200);
    expect(net.responseBody, 'firstsecond');
  });

  test('an abort for a timeout is reported as one', () async {
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    final request = await client.getUrl(Uri.parse('$base/slow'));
    Timer(
      const Duration(milliseconds: 100),
      () => request.abort(TimeoutException('gave up')),
    );
    await expectLater(request.close(), throwsA(isA<TimeoutException>()));
    final net = await single();
    expect(net.status, 0);
    expect(net.errorType, NetworkErrorType.timeout);
  });

  test('a body that fails part way ends as dart:io ends it', () async {
    final uncaught = <Object>[];
    late NetworkCapture net;
    await runZonedGuarded(() async {
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      final request = await client.getUrl(Uri.parse('$base/cut'));
      final response = await request.close();
      // No onError: dart:io then ends the body with a done, never an error.
      final done = Completer<void>();
      response.listen((_) {}, onDone: done.complete);
      await done.future;
      net = await single();
    }, (error, _) => uncaught.add(error));
    expect(uncaught, isEmpty);
    expect(net.responseBody, '[response body unavailable]');
  });

  test('a second listen throws to its caller, as dart:io does', () async {
    final uncaught = <Object>[];
    Object? thrown;
    await runZonedGuarded(() async {
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      final request = await client.getUrl(Uri.parse('$base/echo'));
      final response = await request.close();
      response.listen((_) {});
      try {
        response.listen((_) {});
      } catch (error) {
        thrown = error;
      }
      await pumpEventQueue();
    }, (error, _) => uncaught.add(error));
    expect(thrown, isStateError);
    expect(uncaught, isEmpty);
  });

  test('a response read after other async work keeps its body', () async {
    // The app opens a file, or awaits a platform call, before it reads.
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.getUrl(Uri.parse('$base/echo'));
    final response = await request.close();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(await utf8.decodeStream(response), '{"method":"GET","bytes":0}');
    expect((await single()).responseBody, '{"method":"GET","bytes":0}');
  });

  test('a response nobody reads is still reported', () async {
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    final request = await client.getUrl(Uri.parse('$base/echo'));
    final response = await request.close();
    expect(response.statusCode, 200);
    // Not yet: the caller may still start reading.
    await pumpEventQueue();
    expect(captured(), isEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 600));
    final net = await single();
    expect(net.status, 200);
    expect(net.responseBody, '[response body unavailable]');
  });

  test(
    'a decoded gzip body is complete, whatever its compressed size',
    () async {
      // dart:io decodes it, but keeps Content-Length at the compressed size:
      // 2 bytes read against 22 promised read as a body cut short.
      final response = await http.get(Uri.parse('$base/gzip-tiny'));
      expect(response.body, '{}');
      expect((await single()).responseBody, '{}');
    },
  );

  test(
    'a decoded gzip body under the cap is read, whatever its encoded size',
    () async {
      expect(storedGzip().length, greaterThanOrEqualTo(5000));
      final response = await http.get(Uri.parse('$base/gzip-stored'));
      expect(response.body, storedText);
      expect((await single()).responseBody, storedText);
    },
  );

  test('a decoded gzip body over the cap is still capped', () async {
    final response = await http.get(Uri.parse('$base/gzip-large'));
    expect(response.body, hasLength(100000));
    expect((await single()).responseBody, '[response body too large]');
  });

  test('a WebSocket handshake is not reported', () async {
    // RN's and the browser's capture never see one: fetch and XHR carry no
    // WebSockets. Its 101 has no body, and its socket leaves HTTP. dart:io's
    // own WebSocket client is made at its first connect, after init in an
    // app; one made under capture here stands in for it.
    final socket = await WebSocket.connect(
      'ws://127.0.0.1:${server.port}/ws',
      customClient: HttpClient(),
    );
    await socket.close();
    await Future<void>.delayed(const Duration(milliseconds: 600));
    expect(captured(), isEmpty);
  });

  test('a redirect the caller follows itself is reported at once', () async {
    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.getUrl(Uri.parse('$base/redirect'))
      ..followRedirects = false;
    final response = await request.close();
    expect(response.statusCode, HttpStatus.found);
    final next = await response.redirect();
    await next.drain<void>();
    final net = await single();
    expect(net.status, HttpStatus.found);
    expect(net.responseBody, '[response body unavailable]');
  });

  test('a body still compressed is labelled, never decoded', () async {
    final client = HttpClient()..autoUncompress = false;
    addTearDown(client.close);
    final request = await client.getUrl(Uri.parse('$base/gzip'));
    await (await request.close()).drain<void>();
    expect((await single()).responseBody, '[binary data]');

    pipeline.captures.clear();
    final brotli = await http.get(Uri.parse('$base/brotli'));
    expect(brotli.bodyBytes, hasLength(6));
    expect((await single()).responseBody, '[binary data]');

    pipeline.captures.clear();
    final upload = await client.postUrl(Uri.parse('$base/echo'));
    upload.headers
      ..contentType = ContentType.json
      ..set(HttpHeaders.contentEncodingHeader, 'gzip');
    upload.add(gzip.encode(utf8.encode('{"secret":"s3cr3t"}')));
    await (await upload.close()).drain<void>();
    expect((await single()).requestBody, '[binary data]');
  });

  test('installed inside a zone override, it wraps the global one', () async {
    capture.restore();
    final zoned = _CountingOverrides();
    HttpOverrides.runWithHttpOverrides(install, zoned);
    await http.get(Uri.parse('$base/echo'));
    expect(zoned.created, 0, reason: 'the zone override is not global');
    expect(await single(), isNotNull);
    capture.restore();
    expect(HttpOverrides.current, isNull);
  });

  test('a URL the pipeline skips is neither captured nor traced', () async {
    pipeline
      ..capturedUrls = ((url) => !url.contains('/echo'))
      ..traceHeaders = ((_) => {'traceparent': 'tp'});
    await http.get(Uri.parse('$base/echo'));
    await pumpEventQueue();
    expect(captured(), isEmpty);
    expect(received['/echo']!.value('traceparent'), isNull);
  });

  test('wraps the override that was there, and puts it back', () async {
    capture.restore();
    final previous = _CountingOverrides();
    HttpOverrides.global = previous;
    install();
    await http.get(Uri.parse('$base/echo'));
    expect(previous.created, 1);
    expect(await single(), isNotNull);

    capture.restore();
    expect(HttpOverrides.current, previous);
    await http.get(Uri.parse('$base/echo'));
    await pumpEventQueue();
    expect(captured(), hasLength(1));
  });
}

final class _CountingOverrides extends HttpOverrides {
  int created = 0;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    created++;
    return super.createHttpClient(context);
  }
}
