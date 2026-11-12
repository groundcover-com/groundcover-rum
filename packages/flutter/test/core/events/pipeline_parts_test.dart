// Port of packages/core/ts/src/events/{events-pool,event-enricher}.test.ts and
// transporter/transporter.test.ts: the behaviour that holds for typed Dart
// input. Untyped-JS cases (an enrichEvent returning garbage, hostile getters,
// non-numeric batch sizes) have no Dart counterpart.
import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/common/ids.dart';
import 'package:groundcover_rum/src/core/common/json.dart';
import 'package:groundcover_rum/src/core/common/logger.dart';
import 'package:groundcover_rum/src/core/common/storage.dart';
import 'package:groundcover_rum/src/core/common/time.dart';
import 'package:groundcover_rum/src/core/config/config_manager.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/events/event_enricher.dart';
import 'package:groundcover_rum/src/core/events/events_pool.dart';
import 'package:groundcover_rum/src/core/events/rum_event.dart';
import 'package:groundcover_rum/src/core/session/session_state.dart';
import 'package:groundcover_rum/src/core/transport/transporter.dart';

import '../../support/fake_platform.dart';

const t0 = 1800000000000;

/// A compressor that counts which path built each body: [encode] stands for
/// the platform's off-isolate build, [compressSync] for the inline gzip.
final class Gzip implements Compressor {
  var encodeCalls = 0;
  var syncCalls = 0;
  bool fail = false;

  List<int> _gzip(List<int> bytes) {
    if (fail) throw StateError('encoder broke');
    return [31, 139, ...bytes];
  }

  @override
  Future<List<int>> encode(
    Map<String, Object?> payload, {
    required bool compress,
  }) async {
    encodeCalls++;
    if (fail) throw StateError('encoder broke');
    final bytes = utf8.encode(encodeJson(payload));
    return compress ? _gzip(bytes) : bytes;
  }

  @override
  List<int> compressSync(List<int> bytes) {
    syncCalls++;
    return _gzip(bytes);
  }
}

ConfigManager configWith({
  String cluster = 'c',
  String apiKey = 'k',
  int? batchSize,
  Duration? batchTimeout,
  bool? compression = false,
  bool debug = false,
  BeforeSend? beforeSend,
  EnrichEvent? enrichEvent,
}) => ConfigManager(
  GroundcoverConfig(
    apiKey: apiKey,
    dsn: 'ingest.example',
    cluster: cluster,
    environment: 'e',
    appId: 'a',
    options: GroundcoverOptions(
      debug: debug,
      beforeSend: beforeSend,
      enrichEvent: enrichEvent,
      transport: TransportOptions(
        batchSize: batchSize,
        batchTimeout: batchTimeout,
        compression: compression,
      ),
    ),
  ),
);

final class PoolHarness {
  PoolHarness(
    this.config, {
    Set<String> skip = const {},
    DeviceAttributesProvider? device,
    Compressor? compressor,
  }) {
    session = SessionState(storage: SafeStorage(platform.mapStorage))
      ..setSessionId('s1')
      ..setSessionStartTime(msToNs(t0));
    pool = EventsPool(
      config: config,
      session: session,
      transporter: Transporter(
        config: config,
        sendBatch: platform.sendBatch,
        compressor: compressor,
      ),
      deviceAttributes: device ?? () => {'source': 'mobile-rum'},
      eventsToSkipFlush: skip,
    )..initialize();
  }

  final ConfigManager config;
  final FakePlatform platform = FakePlatform(nowMs: t0);
  late final SessionState session;
  late final EventsPool pool;
  final enricher = EventEnricher(
    idGenerator: RandomIdGenerator(),
    clock: () => t0,
  );

  RumEvent event(String type, [Map<String, Object?>? attributes]) => enricher
      .enrich(EnrichInput(type: type, attributes: attributes ?? const {}));
}

void main() {
  group('EventsPool', () {
    test('flushes once the batch size is reached', () async {
      final h = PoolHarness(configWith(batchSize: 2));
      h.pool.addEvent(h.event('custom'));
      await drain();
      expect(h.platform.requests, isEmpty);
      h.pool.addEvent(h.event('custom'));
      await drain();
      expect(h.platform.requests.single.events, hasLength(2));
      h.pool.destroy();
    });

    test(
      'an explicit batch size of 0 sends every event; a negative one is ignored',
      () async {
        final zero = PoolHarness(configWith(batchSize: 0));
        zero.pool.addEvent(zero.event('custom'));
        await drain();
        expect(zero.platform.requests, hasLength(1));
        zero.pool.destroy();

        final negative = PoolHarness(configWith(batchSize: -1));
        negative.pool.addEvent(negative.event('custom'));
        await drain();
        expect(negative.platform.requests, isEmpty, reason: 'falls back to 10');
        negative.pool.destroy();
      },
    );

    test('skip-flush types ride along with the next flushing event', () async {
      final h = PoolHarness(configWith(batchSize: 1), skip: {'interaction'});
      h.pool.addEvent(h.event('interaction'));
      await drain();
      expect(h.platform.requests, isEmpty);
      h.pool.addEvent(h.event('custom'));
      await drain();
      expect(h.platform.requests.single.events.map((e) => e['type']), [
        'interaction',
        'custom',
      ]);
      h.pool.destroy();
    });

    test('the timer flushes, and stays armed through an empty window', () {
      fakeAsync((async) {
        final h = PoolHarness(
          configWith(batchTimeout: const Duration(seconds: 2)),
        );
        async.elapse(const Duration(seconds: 2));
        h.pool.addEvent(h.event('custom'));
        async.elapse(const Duration(seconds: 2));
        expect(h.platform.requests, hasLength(1));
        h.pool.destroy();
      });
    });

    test('a zero batch timeout falls back to the 10 s default', () {
      fakeAsync((async) {
        final h = PoolHarness(configWith(batchTimeout: Duration.zero));
        h.pool.addEvent(h.event('custom'));
        async.elapse(const Duration(seconds: 9));
        expect(h.platform.requests, isEmpty);
        async.elapse(const Duration(seconds: 1));
        expect(h.platform.requests, hasLength(1));
        h.pool.destroy();
      });
    });

    test(
      'holds the buffer without a cluster, and sends once one is set',
      () async {
        final h = PoolHarness(configWith(cluster: ''));
        h.pool.addEvent(h.event('custom'));
        h.pool.flush();
        await drain();
        expect(h.platform.requests, isEmpty);
        h.config.update(const GroundcoverConfigUpdate(cluster: 'later'));
        h.pool.flush();
        await drain();
        expect(
          h.platform.requests.single.sessionAttributes['cluster'],
          'later',
        );
        h.pool.destroy();
      },
    );

    test('while gated, holds up to 500 events and drops the newest', () async {
      final h = PoolHarness(configWith());
      h.pool.setFlushGate(() => false);
      for (var i = 0; i < maxGatedBufferEvents + 5; i++) {
        h.pool.addEvent(h.event('custom', {'i': i}));
      }
      h.pool.setFlushGate(null);
      h.pool.flush();
      await drain();
      final sent = h.platform.requests.single.events;
      expect(sent, hasLength(maxGatedBufferEvents));
      expect((sent.last['attributes'] as Map)['i'], maxGatedBufferEvents - 1);
      h.pool.destroy();
    });

    test(
      'without a cluster, holds up to 500 events and drops the newest',
      () async {
        // A missing --dart-define leaves the cluster empty: events wait for
        // one to arrive by updateConfig, and must not grow without bound.
        final h = PoolHarness(configWith(cluster: ''));
        for (var i = 0; i < maxGatedBufferEvents + 5; i++) {
          h.pool.addEvent(h.event('custom', {'i': i}));
        }
        await drain();
        expect(h.platform.requests, isEmpty);
        h.config.update(const GroundcoverConfigUpdate(cluster: 'later'));
        h.pool.flush();
        await drain();
        final sent = h.platform.requests.single.events;
        expect(sent, hasLength(maxGatedBufferEvents));
        expect((sent.last['attributes'] as Map)['i'], maxGatedBufferEvents - 1);
        h.pool.destroy();
      },
    );

    test('a throwing gate fails open', () async {
      final h = PoolHarness(configWith());
      h.pool.setFlushGate(() => throw StateError('gate'));
      h.pool.addEvent(h.event('custom'));
      h.pool.flush();
      await drain();
      expect(h.platform.requests, hasLength(1));
      h.pool.destroy();
    });

    test(
      'beforeSend drops what it rejects; a throwing hook drops the event',
      () async {
        final h = PoolHarness(
          configWith(
            beforeSend: (e) {
              if (e.attributes['boom'] == true) throw StateError('hook');
              return e.attributes['drop'] != true;
            },
          ),
        );
        h.pool.addEvent(h.event('custom', {'drop': true}));
        h.pool.addEvent(h.event('custom', {'boom': true}));
        h.pool.addEvent(h.event('custom', {'keep': true}));
        h.pool.flush();
        await drain();
        expect(h.platform.requests.single.events, hasLength(1));
        h.pool.destroy();
      },
    );

    test(
      'enrichEvent sees dot-flattened attributes and its result ships',
      () async {
        final h = PoolHarness(
          configWith(
            enrichEvent: (e) {
              expect(e.attributes['nested.key'], 'v');
              return e..attributes['added'] = 1;
            },
          ),
        );
        h.pool.addEvent(
          h.event('custom', {
            'nested': {'key': 'v'},
          }),
        );
        h.pool.flush();
        await drain();
        expect(
          (h.platform.requests.single.events.single['attributes']
              as Map)['added'],
          1,
        );
        h.pool.destroy();
      },
    );

    test("what a hook puts in ships as JSON: an object as its string, a cycle "
        'marked, and the batch kept', () async {
      final loop = <String, Object?>{'a': 1};
      loop['self'] = loop;
      final h = PoolHarness(
        configWith(
          enrichEvent: (e) => e
            ..attributes['profile'] = _Profile()
            ..attributes['loop'] = loop,
        ),
      );
      h.pool.addEvent(h.event('custom', {'keep': true}));
      h.pool.flush();
      await drain();
      final attributes =
          h.platform.requests.single.events.single['attributes'] as Map;
      expect(attributes['keep'], true);
      expect(attributes['profile'], 'profile #7');
      expect((attributes['loop'] as Map)['self'], '[Circular]');
      h.pool.destroy();
    });

    test(
      'flushSync discards a gated buffer instead of carrying it across an id change',
      () async {
        final h = PoolHarness(configWith());
        h.pool.setFlushGate(() => false);
        h.pool.addEvent(h.event('custom'));
        await h.pool.flushSync();
        h.pool.setFlushGate(null);
        h.pool.flush();
        await drain();
        expect(h.platform.requests, isEmpty);
        h.pool.destroy();
      },
    );

    test(
      'the envelope puts session identity over anything the device provides',
      () {
        final h = PoolHarness(
          configWith(),
          device: () => {
            'source': 'mobile-rum',
            'session_id': 'spoofed',
            'cluster': 'spoofed',
          },
        );
        final attrs = h.pool.getSessionAttributes();
        expect(attrs['session_id'], 's1');
        expect(attrs['cluster'], 'c');
        expect(attrs['source'], 'mobile-rum');
        expect(attrs['session_start_time'], msToNs(t0));
        expect(attrs['user'], isEmpty);
        expect(attrs['service.name'], 'a');
        h.pool.destroy();
      },
    );

    test('a throwing device provider costs only the device part', () {
      final h = PoolHarness(
        configWith(),
        device: () => throw StateError('device'),
      );
      final attrs = h.pool.getSessionAttributes();
      expect(attrs['session_id'], 's1');
      expect(attrs.containsKey('source'), isFalse);
      h.pool.destroy();
    });
  });

  group('EventEnricher', () {
    final enricher = EventEnricher(
      idGenerator: RandomIdGenerator(),
      clock: () => t0,
      platformAttributes: () => {
        'screen': {'name': 'Home', 'key': 'k1'},
      },
    );

    test('stamps ids, the timestamp in ns and an empty parentSpanId', () {
      final e = enricher.enrich(EnrichInput(type: 'custom'));
      expect(e.timestamp, msToNs(t0));
      expect(e.startTimestamp, isNull);
      expect(e.parentSpanId, '');
      expect(e.id, hasLength(32));
      expect(e.spanId, hasLength(16));
      expect(e.traceId, startsWith('0' * 16));
    });

    test('a network event gets start/end timestamps instead', () {
      final e = enricher.enrich(
        EnrichInput(
          type: 'network',
          timestamp: 5,
          endTimestamp: 9,
          spanName: 'GET /x',
        ),
      );
      expect(e.timestamp, isNull);
      expect(e.startTimestamp, 5);
      expect(e.endTimestamp, 9);
      expect(e.toJson()['span_name'], 'GET /x');
    });

    test('keeps a supplied time, 0 included, and replaces a negative one', () {
      expect(
        enricher.enrich(EnrichInput(type: 'log', timestamp: 0)).timestamp,
        0,
      );
      expect(
        enricher.enrich(EnrichInput(type: 'log', timestamp: -1)).timestamp,
        msToNs(t0),
      );
    });

    test('keeps supplied span and trace ids', () {
      final e = enricher.enrich(
        EnrichInput(type: 'network', spanId: 'a' * 16, traceId: 'b' * 32),
      );
      expect(e.spanId, 'a' * 16);
      expect(e.traceId, 'b' * 32);
    });

    test('platform attributes win over a user attribute of the same name', () {
      final e = enricher.enrich(
        EnrichInput(type: 'log', attributes: {'screen': 'user'}),
      );
      expect(e.attributes['screen'], {'name': 'Home', 'key': 'k1'});
    });

    test('a throwing contributor yields no platform attributes', () {
      final throwing = EventEnricher(
        idGenerator: RandomIdGenerator(),
        clock: () => t0,
        platformAttributes: () => throw StateError('x'),
      );
      expect(
        throwing
            .enrich(EnrichInput(type: 'log', attributes: {'a': 1}))
            .attributes,
        {'a': 1},
      );
    });
  });

  group('flattenAttributes', () {
    test('dot-flattens maps and flattens maps in lists under key[index]', () {
      expect(
        flattenAttributes({
          'a': {
            'b': 1,
            'c': {'d': 'x'},
          },
          'frames': [
            {'function': 'f'},
            7,
          ],
        }),
        {
          'a.b': 1,
          'a.c.d': 'x',
          'frames': [
            {'frames[0].function': 'f'},
            7,
          ],
        },
      );
    });

    test('bounds depth and marks a cycle', () {
      Map<String, Object?> deep = {'leaf': 1};
      for (var i = 0; i < 12; i++) {
        deep = {'n': deep};
      }
      expect(flattenAttributes(deep).values, contains('[Depth Limit]'));
      final cyclic = <String, Object?>{'a': 1};
      cyclic['self'] = cyclic;
      expect(flattenAttributes(cyclic), {'a': 1, 'self': '[Circular]'});
    });

    test('marks a list that contains itself, without walking it again', () {
      final list = <Object?>[];
      list
        ..add(list)
        ..add(list);
      expect(flattenAttributes({'a': list}), {
        'a': ['[Circular]', '[Circular]'],
      });
    });

    test('makes every value JSON-safe', () {
      final out = flattenAttributes({
        'nan': double.nan,
        'when': DateTime.utc(2027),
      });
      expect(out['nan'], isNull);
      expect(out['when'], '2027-01-01 00:00:00.000Z');
      expect(() => jsonEncode(out), returnsNormally);
      // Any iterable is a list, as the transport writes one a hook put back.
      expect(
        flattenAttributes({
          'tags': {'a', 'b'},
        }),
        {
          'tags': ['a', 'b'],
        },
      );
    });
  });

  group('Transporter', () {
    Batch batch() => (
      sessionAttributes: {'session_id': 's'},
      events: [
        <String, Object?>{'type': 'custom'},
      ],
    );

    test('POSTs JSON to {endpoint}/json/rum with the apikey header', () async {
      final platform = FakePlatform();
      await Transporter(
        config: configWith(),
        sendBatch: platform.sendBatch,
      ).send(batch());
      await drain();
      final r = platform.requests.single;
      expect(r.url, 'https://ingest.example/json/rum');
      expect(r.headers, {
        'Content-Type': 'application/json',
        'apikey': 'k',
        'Content-Encoding': '',
      });
      expect(r.batch['events'], [
        {'type': 'custom'},
      ]);
    });

    test(
      'builds the body off the UI isolate, and inline for a lifecycle send',
      () async {
        final platform = FakePlatform();
        final gzip = Gzip();
        final transporter = Transporter(
          config: configWith(compression: true),
          sendBatch: platform.sendBatch,
          compressor: gzip,
        );
        await transporter.send(batch());
        await transporter.send(batch(), lifecycle: true);
        await drain();
        expect(platform.requests.map((r) => r.headers['Content-Encoding']), [
          'gzip',
          'gzip',
        ]);
        expect((gzip.encodeCalls, gzip.syncCalls), (1, 1));
      },
    );

    test('with compression off, still builds the body off the UI isolate, '
        'and a lifecycle send inline', () async {
      final platform = FakePlatform();
      final gzip = Gzip();
      final transporter = Transporter(
        config: configWith(compression: false),
        sendBatch: platform.sendBatch,
        compressor: gzip,
      );
      await transporter.send(batch());
      await transporter.send(batch(), lifecycle: true);
      await drain();
      expect(platform.requests.map((r) => r.headers['Content-Encoding']), [
        '',
        '',
      ]);
      expect(platform.requests.map((r) => r.batch), [
        for (var i = 0; i < 2; i++)
          {
            'sessionAttributes': {'session_id': 's'},
            'events': [
              {'type': 'custom'},
            ],
          },
      ]);
      expect((gzip.encodeCalls, gzip.syncCalls), (1, 0));
    });

    test('a delivery builds its body off the UI isolate: nothing is being '
        'suspended, and a crash record can be large', () async {
      final platform = FakePlatform();
      final gzip = Gzip();
      final delivered = await Transporter(
        config: configWith(compression: true),
        sendBatch: platform.sendBatch,
        compressor: gzip,
      ).deliver(batch());
      expect(delivered, isTrue);
      expect(platform.requests.single.headers['Content-Encoding'], 'gzip');
      expect((gzip.encodeCalls, gzip.syncCalls), (1, 0));
    });

    test('an encoder failure sends the batch uncompressed', () async {
      for (final lifecycle in [false, true]) {
        final platform = FakePlatform();
        final gzip = Gzip()..fail = true;
        await Transporter(
          config: configWith(compression: true),
          sendBatch: platform.sendBatch,
          compressor: gzip,
        ).send(batch(), lifecycle: lifecycle);
        await drain();
        final request = platform.requests.single;
        expect(request.headers['Content-Encoding'], '', reason: '$lifecycle');
        expect(request.batch['events'], [
          {'type': 'custom'},
        ]);
        expect((gzip.encodeCalls, gzip.syncCalls), lifecycle ? (0, 1) : (1, 0));
      }
    });

    test('in debug, builds the body inline, to log its JSON', () async {
      final lines = <String>[];
      final sink = RumDiagnostics.instance.sink;
      RumDiagnostics.instance
        ..sink = lines.add
        ..configure(debug: true);
      addTearDown(
        () => RumDiagnostics.instance
          ..sink = sink
          ..configure(debug: false),
      );
      final platform = FakePlatform();
      final gzip = Gzip();
      await Transporter(
        config: configWith(compression: true, debug: true),
        sendBatch: platform.sendBatch,
        compressor: gzip,
      ).send(batch());
      await drain();
      expect(platform.requests.single.headers['Content-Encoding'], 'gzip');
      expect((gzip.encodeCalls, gzip.syncCalls), (0, 1));
      expect(
        lines,
        contains(
          allOf(
            contains('Sending batch:'),
            contains('"events":[{"type":"custom"}]'),
          ),
        ),
      );
    });

    test('sends nothing without an API key', () async {
      final platform = FakePlatform();
      await Transporter(
        config: configWith(apiKey: ''),
        sendBatch: platform.sendBatch,
      ).send(batch());
      await drain();
      expect(platform.requests, isEmpty);
    });

    test('sends what JSON has no form for, as JSON.stringify would', () async {
      final platform = FakePlatform();
      await Transporter(
        config: configWith(),
        sendBatch: platform.sendBatch,
      ).send((
        sessionAttributes: {
          'user': {
            'id': 'u',
            'properties': {'since': DateTime.utc(2020), 7: 'seven'},
          },
        },
        events: [
          // What an enrichEvent or beforeSend hook can put back.
          <String, Object?>{
            'type': 'custom',
            'attributes': {
              'ratio': double.infinity,
              'kind': Duration.zero,
              'tags': {'a'},
            },
          },
        ],
      ));
      await drain();
      final batch = platform.requests.single.batch;
      expect((batch['sessionAttributes'] as Map)['user'], {
        'id': 'u',
        'properties': {'since': '2020-01-01 00:00:00.000Z', '7': 'seven'},
      });
      expect((batch['events'] as List).single, {
        'type': 'custom',
        'attributes': {
          'ratio': null,
          'kind': '0:00:00.000000',
          'tags': ['a'],
        },
      });
    });

    test('contains a failing sender', () async {
      final errors = <Object>[];
      await runZonedGuarded(() async {
        await Transporter(
          config: configWith(),
          sendBatch: (_, _) async => throw StateError('offline'),
        ).send(batch());
        await drain();
      }, (error, _) => errors.add(error));
      expect(errors, isEmpty);
    });
  });
}

final class _Profile {
  @override
  String toString() => 'profile #7';
}
