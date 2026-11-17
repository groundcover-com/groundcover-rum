import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/common/json.dart';
import 'package:groundcover_rum/src/core/common/logger.dart';
import 'package:groundcover_rum/src/core/config/config_manager.dart';
import 'package:groundcover_rum/src/core/transport/transporter.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/platform/device_attributes.dart';
import 'package:groundcover_rum/src/platform/flutter_platform.dart';
import 'package:groundcover_rum/src/platform/hydrated_storage.dart';
import 'package:groundcover_rum/src/platform/rum_api.g.dart';
import 'package:groundcover_rum/src/platform/transport.dart';
import 'package:groundcover_rum/src/version.dart';

final class FakeHostApi implements RumHostApi {
  FakeHostApi([Map<String, String>? stored]) : stored = stored ?? {};

  final Map<String, String> stored;
  final writes = <Map<String, String?>>[];
  bool failLoad = false;

  /// How many writeStorage calls fail, as a failed native commit does.
  int writeFailures = 0;

  /// How many deviceInfo calls fail before one answers.
  int deviceFailures = 0;

  /// Holds deviceInfo until completed, as a slow main thread would.
  Completer<void>? deviceGate;

  @override
  Future<Map<String, String>> loadStorage() async {
    if (failLoad) throw StateError('channel down');
    return Map.of(stored);
  }

  @override
  Future<void> writeStorage(Map<String, String?> changes) async {
    if (writeFailures > 0) {
      writeFailures--;
      throw PlatformException(code: 'storage-write-failed');
    }
    writes.add(Map.of(changes));
    for (final MapEntry(:key, :value) in changes.entries) {
      value == null ? stored.remove(key) : stored[key] = value;
    }
  }

  @override
  Future<NativeDeviceInfo> deviceInfo() async {
    await deviceGate?.future;
    if (deviceFailures > 0) {
      deviceFailures--;
      throw StateError('channel down');
    }
    return NativeDeviceInfo(
      osVersion: '18.2',
      model: 'iPhone17,1',
      brand: 'Apple',
    );
  }

  // The engine calls, which these tests don't drive.
  @override
  Future<String> startEngine(String configJson) async => '{}';
  @override
  Future<void> updateSessionSnapshot(String? json) async {}
  @override
  Future<String> pendingCrashReports() async => '[]';
  @override
  Future<void> clearPendingCrashReports(List<String> ids) async {}
  @override
  Future<void> stopEngine() async {}
  @override
  Future<void> triggerTestCrash(String kind) async {}
  @override
  Future<void> blockMainThread(int ms) async {}

  @override
  // ignore: non_constant_identifier_names
  String get pigeonVar_messageChannelSuffix => '';

  @override
  // ignore: non_constant_identifier_names
  BinaryMessenger? get pigeonVar_binaryMessenger => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('flutterPlatform', () {
    const config = GroundcoverConfig(
      apiKey: 'k',
      dsn: 'd',
      cluster: 'c',
      environment: 'e',
      appId: 'shop',
      options: GroundcoverOptions(appVersion: '9.9'),
    );

    test('hydrates storage and reads the device for the envelope', () async {
      final services = await flutterPlatform(
        config,
        api: FakeHostApi({'gcId': 'kept'}),
      );
      expect(services.storage.getItem('gcId'), 'kept');
      final envelope = services.deviceAttributes();
      expect((envelope['device'] as Map)['model'], 'iPhone17,1');
      expect((envelope['app'] as Map)['version'], '9.9');
    });

    test('waits for the device, so the first batch carries it', () async {
      // Read behind init instead, it can answer after the first frame, so an
      // early batch would go out with no device.
      final api = FakeHostApi()..deviceGate = Completer();
      var ready = false;
      final starting = flutterPlatform(config, api: api)
        ..then((_) => ready = true);
      await pumpEventQueue();
      expect(ready, isFalse);
      api.deviceGate!.complete();
      final services = await starting;
      expect(
        (services.deviceAttributes()['device'] as Map)['model'],
        'iPhone17,1',
      );
    });

    test('goes on without the device when native cannot answer', () async {
      final services = await flutterPlatform(
        config,
        api: FakeHostApi()..deviceFailures = 2,
      );
      final envelope = services.deviceAttributes();
      expect(envelope['source'], 'mobile-rum');
      expect((envelope['app'] as Map)['id'], 'shop');
    });

    test(
      'reads the device again after a miss, as RN caches only a hit',
      () async {
        final services = await flutterPlatform(
          config,
          api: FakeHostApi()..deviceFailures = 1,
        );
        expect(
          (services.deviceAttributes()['device'] as Map)['model'],
          'unknown',
        );
        await pumpEventQueue();
        expect(
          (services.deviceAttributes()['device'] as Map)['model'],
          'iPhone17,1',
        );
      },
    );
  });

  group('HydratedStorage', () {
    test('hydrates from native and reads from memory', () async {
      final storage = await HydratedStorage.hydrate(
        FakeHostApi({'gcId': 'kept'}),
      );
      expect(storage.getItem('gcId'), 'kept');
    });

    test('starts empty when native storage is unreachable', () async {
      final storage = await HydratedStorage.hydrate(
        FakeHostApi()..failLoad = true,
      );
      expect(storage.getItem('gcId'), isNull);
    });

    test(
      'writes made in one turn reach native together, and in order',
      () async {
        final api = FakeHostApi();
        final storage = await HydratedStorage.hydrate(api);
        storage
          ..setItem('a', '1')
          ..setItem('b', '2')
          ..removeItem('a');
        expect(storage.getItem('b'), '2');
        await storage.flushWrites();
        expect(api.writes, [
          {'a': null, 'b': '2'},
        ]);
        storage.setItem('c', '3');
        await storage.flushWrites();
        expect(api.stored, {'b': '2', 'c': '3'});
      },
    );

    test(
      'a write native rejects is reported, and the next still goes',
      () async {
        final lines = <String>[];
        final sink = RumDiagnostics.instance.sink;
        RumDiagnostics.instance
          ..sink = lines.add
          ..configure(debug: true);
        addTearDown(() {
          RumDiagnostics.instance
            ..sink = sink
            ..configure(debug: false);
        });
        final api = FakeHostApi()..writeFailures = 1;
        final storage = await HydratedStorage.hydrate(api);
        storage.setItem('a', '1');
        await storage.flushWrites();
        expect(api.stored, isEmpty);
        expect(lines.single, contains('storage-write-failed'));
        storage.setItem('b', '2');
        await storage.flushWrites();
        expect(api.stored, {'b': '2'});
      },
    );
  });

  test('device attributes have the RN envelope shape, plus sdk', () {
    final attrs = deviceAttributesFor(
      native: () => NativeDeviceInfo(
        osVersion: '34',
        model: 'Pixel 6',
        brand: 'google',
        codename: 'oriole',
        appVersion: '1.2.3',
        appBuild: '7',
      ),
      appId: 'my-app',
      appBuild: '8',
    )();
    expect(attrs['source'], 'mobile-rum');
    expect((attrs['os'] as Map)['version'], '34');
    final device = attrs['device'] as Map;
    expect(device['model'], 'Pixel 6');
    expect(device['codename'], 'oriole');
    expect(
      (device['screen'] as Map).keys,
      containsAll(['width', 'height', 'scale', 'fontScale']),
    );
    expect(attrs['app'], {'version': '1.2.3', 'build': '8', 'id': 'my-app'});
    expect(attrs['sdk'], {'name': sdkName, 'version': sdkVersion});
  });

  test('a blank app version or build is left out, as RN omits it', () {
    final attrs = deviceAttributesFor(
      native: () => NativeDeviceInfo(
        osVersion: '34',
        model: 'Pixel 6',
        brand: 'google',
        appVersion: '',
        appBuild: ' ',
      ),
      appId: 'my-app',
    )();
    expect(attrs['app'], {'id': 'my-app'});
  });

  group('HttpBatchSender', () {
    /// A loopback ingest that answers each request after [delay], counting
    /// the requests it receives and how many are open at once.
    Future<({List<int> ports, int Function() peak, String url})> ingest(
      Duration delay,
    ) async {
      final testOverrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = testOverrides);
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final ports = <int>[];
      var open = 0;
      var peak = 0;
      server.listen((request) async {
        ports.add(request.connectionInfo!.remotePort);
        peak = max(peak, ++open);
        await request.drain<void>();
        await Future<void>.delayed(delay);
        open--;
        await request.response.close();
      });
      return (
        ports: ports,
        peak: () => peak,
        url: 'http://127.0.0.1:${server.port}/json/rum',
      );
    }

    BatchRequest batch() => BatchRequest(headers: const {}, body: Uint8List(1));

    test('a non-2xx answer fails the send, so the crash drain keeps its '
        'record', () async {
      final testOverrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = testOverrides);
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      var status = 503;
      server.listen((request) async {
        await request.drain<void>();
        request.response.statusCode = status;
        await request.response.close();
      });
      final url = 'http://127.0.0.1:${server.port}/json/rum';
      await expectLater(
        HttpBatchSender().call(url, batch()),
        throwsA(isA<HttpException>()),
      );
      status = 202;
      await HttpBatchSender().call(url, batch());
    });

    test('a 401 or 403 warns once, with debug off', () async {
      final testOverrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = testOverrides);
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      var status = 401;
      server.listen((request) async {
        await request.drain<void>();
        request.response.statusCode = status;
        await request.response.close();
      });
      final lines = <String>[];
      final sink = RumDiagnostics.instance.sink;
      RumDiagnostics.instance.sink = lines.add;
      addTearDown(() => RumDiagnostics.instance.sink = sink);
      final url = 'http://127.0.0.1:${server.port}/json/rum';
      final sender = HttpBatchSender();
      for (final answer in [401, 403, 401, 500]) {
        status = answer;
        await expectLater(
          sender.call(url, batch()),
          throwsA(isA<HttpException>()),
        );
      }
      expect(lines, [
        '[groundcover] $url rejected a batch with HTTP 401. Check the apiKey '
            'and dsn passed to GroundcoverRum.init(): no RUM data is recorded '
            'until they are accepted. (groundcoverIgnore)',
      ]);
    });

    test("builds its client outside the app's HttpOverrides", () {
      // An app's global override (a pinned CA, a badCertificateCallback)
      // is for its own traffic: through it, pinning fails every batch, and
      // an accept-all callback sends the ingest key unverified.
      final testOverrides = HttpOverrides.current;
      final overrides = _CountingOverrides();
      HttpOverrides.global = overrides;
      addTearDown(() => HttpOverrides.global = testOverrides);
      HttpBatchSender();
      expect(overrides.created, 0);
    });

    test('a burst of sends shares two connections', () async {
      // As OkHttp and NSURLSession queue RN's: unbounded, a burst of events
      // would open a socket and a TLS handshake per batch, all at once.
      final server = await ingest(const Duration(milliseconds: 100));
      final sender = HttpBatchSender();
      await Future.wait([
        for (var i = 0; i < 10; i++) sender.call(server.url, batch()),
      ]);
      expect(server.ports, hasLength(10));
      expect(server.peak(), lessThanOrEqualTo(2));
      expect(server.ports.toSet().length, lessThanOrEqualTo(2));
    });

    test(
      'a send still waiting for a connection at its deadline is never sent',
      () async {
        final server = await ingest(const Duration(seconds: 1));
        final sender = HttpBatchSender(
          timeout: const Duration(milliseconds: 300),
        );
        final sends = [
          for (var i = 0; i < 3; i++) sender.call(server.url, batch()),
        ];
        for (final send in sends) {
          await expectLater(send, throwsA(isA<TimeoutException>()));
        }
        // Its connection frees once the first two are stopped; the third must
        // not go out then, past its deadline, with nothing left to stop it.
        await Future<void>.delayed(const Duration(milliseconds: 1500));
        expect(server.ports, hasLength(2));
      },
    );

    test('a send past its deadline is stopped, its socket closed', () async {
      final testOverrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = testOverrides);
      // An ingest that takes the request and never answers.
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      final closed = Completer<void>();
      server.listen((socket) {
        socket.listen((_) {}, onDone: closed.complete, onError: (_) {});
      });
      final sender = HttpBatchSender(
        timeout: const Duration(milliseconds: 300),
      );
      final started = DateTime.now();
      await expectLater(
        sender.call(
          'http://127.0.0.1:${server.port}/json/rum',
          BatchRequest(headers: const {}, body: Uint8List(1)),
        ),
        throwsA(isA<TimeoutException>()),
      );
      expect(DateTime.now().difference(started).inSeconds, lessThan(5));
      // The socket goes too, so batches can't pile up against a hung ingest.
      await closed.future.timeout(const Duration(seconds: 5));
    });

    test(
      'POSTs the body with its headers, and drops an empty Content-Encoding',
      () async {
        // The test binding's own HttpOverrides answers every request with a 400.
        final testOverrides = HttpOverrides.current;
        HttpOverrides.global = null;
        addTearDown(() => HttpOverrides.global = testOverrides);
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final received = <(String, HttpHeaders, List<int>)>[];
        server.listen((request) async {
          final body = await request.fold<List<int>>(
            [],
            (a, b) => a..addAll(b),
          );
          received.add((request.method, request.headers, body));
          request.response.statusCode = 200;
          await request.response.close();
        });
        await HttpBatchSender().call(
          'http://127.0.0.1:${server.port}/json/rum',
          BatchRequest(
            headers: {
              'Content-Type': 'application/json',
              'apikey': 'k',
              'Content-Encoding': '',
            },
            body: Uint8List.fromList(utf8.encode('{"a":1}')),
          ),
        );
        await server.close();
        final (method, headers, body) = received.single;
        expect(method, 'POST');
        expect(headers.value('apikey'), 'k');
        expect(headers.value('content-encoding'), isNull);
        expect(utf8.decode(body), '{"a":1}');
      },
    );
  });

  group('GzipCompressor', () {
    // What a hook can put back too, so the isolate's encoder is the inline
    // one, fallbacks and all.
    Map<String, Object?> payload() => {
      'sessionAttributes': {
        'session_id': 's',
        'user': {
          'id': 'u',
          'properties': {'since': DateTime.utc(2020), 7: 'seven'},
        },
      },
      'events': [
        {
          'type': 'custom',
          'attributes': {
            'text': 'é ✓ 😀',
            'ratio': double.infinity,
            'tags': {'a'},
          },
        },
      ],
    };

    test(
      'builds a body off the UI isolate as the inline path does, gzipped or not',
      () async {
        final compressor = GzipCompressor();
        final inline = jsonDecode(encodeJson(payload()));
        final gzipped = await compressor.encode(payload(), compress: true);
        expect(jsonDecode(utf8.decode(gzip.decode(gzipped))), inline);
        final plain = await compressor.encode(payload(), compress: false);
        expect(jsonDecode(utf8.decode(plain)), inline);
      },
    );

    test('gzips inline', () {
      final bytes = utf8.encode('{"small":true}');
      expect(gzip.decode(GzipCompressor().compressSync(bytes)), bytes);
    });

    test('a payload no isolate can take still goes out, built inline and '
        'uncompressed', () async {
      final port = ReceivePort();
      addTearDown(port.close);
      final odd = payload();
      ((odd['events']! as List).single as Map)['attributes'] = {'port': port};
      await expectLater(
        () => GzipCompressor().encode(odd, compress: true),
        throwsArgumentError,
      );

      final sent = <BatchRequest>[];
      await Transporter(
        config: ConfigManager(
          const GroundcoverConfig(
            apiKey: 'k',
            dsn: 'ingest.example',
            cluster: 'c',
            environment: 'e',
            appId: 'a',
            options: GroundcoverOptions(
              transport: TransportOptions(compression: true),
            ),
          ),
        ),
        sendBatch: (_, request) async => sent.add(request),
        compressor: GzipCompressor(),
      ).send((
        sessionAttributes: odd['sessionAttributes']! as Map<String, Object?>,
        events: odd['events']! as List<Object?>,
      ));
      expect(sent.single.headers['Content-Encoding'], '');
      final body = jsonDecode(utf8.decode(sent.single.body)) as Map;
      expect(((body['events'] as List).single as Map)['attributes'], {
        'port': '$port',
      });
    });
  });
}

final class _CountingOverrides extends HttpOverrides {
  var created = 0;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    created++;
    return super.createHttpClient(context);
  }
}
