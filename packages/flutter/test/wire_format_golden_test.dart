// The Dart golden over packages/core/wire: one plain test per request file,
// plus the behaviour every golden repeats (see that directory's README; the
// TS goldens hold the reference versions). It drives DartRumPipeline, the
// Dart core, directly: the fixtures pin what the core sends for a call, and
// the public API's own tests check that each call reaches the core as it
// should.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';

import 'support/fake_platform.dart';

const wireDir = '../core/wire';

/// 2027-01-15T08:00:00Z, the clock every fixture is written against.
const fixtureClockMs = 1800000000000;

final hex32 = RegExp(r'^[0-9a-f]{32}$');
final hex16 = RegExp(r'^[0-9a-f]{16}$');
final traceId = RegExp(r'^0{16}[0-9a-f]{16}$');

/// What only this platform sends, set aside before comparing.
const platformSessionKeys = ['app', 'device', 'os', 'source', 'sdk'];
const platformEventAttributes = ['screen', 'error_stacktrace'];

Map<String, Object?> fixture(String name) =>
    jsonDecode(File('$wireDir/$name').readAsStringSync())
        as Map<String, Object?>;

GroundcoverConfig goldenConfig({GroundcoverOptions? options}) {
  final c = fixture('config.json');
  final user = c['user'] as Map<String, Object?>;
  final transport = (c['options'] as Map)['transport'] as Map;
  return GroundcoverConfig(
    dsn: c['dsn'] as String,
    apiKey: c['apiKey'] as String,
    cluster: c['cluster'] as String,
    environment: c['environment'] as String,
    namespace: c['namespace'] as String,
    releaseId: c['releaseId'] as String,
    appId: c['appId'] as String,
    user: RumUser(id: user['id'] as String?, email: user['email'] as String?),
    options:
        options ??
        GroundcoverOptions(
          debug: (c['options'] as Map)['debug'] as bool,
          transport: TransportOptions(
            batchSize: transport['batchSize'] as int,
            compression: transport['compression'] as bool,
          ),
        ),
  );
}

GroundcoverOptions goldenOptions({
  Duration? sessionMaxDuration,
  double? sessionSampleRate,
  BeforeSend? beforeSend,
  EnrichEvent? enrichEvent,
}) => GroundcoverOptions(
  transport: const TransportOptions(batchSize: 0, compression: false),
  sessionMaxDuration: sessionMaxDuration,
  sessionSampleRate: sessionSampleRate,
  beforeSend: beforeSend,
  enrichEvent: enrichEvent,
);

/// Numbers compared as doubles: near 1.8e18 a double steps in 256 ns, which
/// is how the TS cores hold these values.
Object? asDoubles(Object? value) => switch (value) {
  final num n => n.toDouble(),
  final Map<Object?, Object?> m => {
    for (final e in m.entries) e.key: asDoubles(e.value),
  },
  final List<Object?> l => [for (final v in l) asDoubles(v)],
  _ => value,
};

Map<String, Object?> without(Map<String, Object?> map, List<String> keys) => {
  for (final e in map.entries)
    if (!keys.contains(e.key)) e.key: e.value,
};

/// The request with its random ids checked and removed, and this platform's
/// own keys set aside.
Map<String, Object?> sharedRequest(SentRequest request) {
  final batch = request.batch;
  final session = batch['sessionAttributes'] as Map<String, Object?>;
  expect(session['session_id'], matches(hex32));
  final events = [
    for (final event in (batch['events'] as List).cast<Map<String, Object?>>())
      () {
        expect(event['id'], matches(hex32));
        expect(event['spanId'], matches(hex16));
        expect(event['traceId'], matches(traceId));
        return {
          ...without(event, ['id', 'spanId', 'traceId']),
          'attributes': without(
            event['attributes'] as Map<String, Object?>,
            platformEventAttributes,
          ),
        };
      }(),
  ];
  return {
    'url': request.url,
    'headers': request.headers,
    'body': {
      ...batch,
      'sessionAttributes': without(session, [
        'session_id',
        ...platformSessionKeys,
      ]),
      'events': events,
    },
  };
}

Future<({DartRumPipeline pipeline, FakePlatform platform})> startPipeline({
  GroundcoverOptions? options,
}) async {
  final platform = FakePlatform(nowMs: fixtureClockMs);
  final pipeline = DartRumPipeline();
  await pipeline.start(goldenConfig(options: options), platform);
  return (pipeline: pipeline, platform: platform);
}

int earliestEventTime(SentRequest request) => request.events
    .map((e) => (e['timestamp'] ?? e['start_timestamp']) as int)
    .reduce((a, b) => a < b ? a : b);

void main() {
  group('shared wire fixtures', () {
    Future<Map<String, Object?>> onlyRequest(
      void Function(DartRumPipeline pipeline) send,
    ) async {
      final (:pipeline, :platform) = await startPipeline();
      pipeline.presence();
      send(pipeline);
      await drain();
      expect(platform.requests, hasLength(1));
      return sharedRequest(platform.requests.single);
    }

    test('custom-event.json', () async {
      final sent = await onlyRequest(
        (p) => p.submit(
          const CustomEventCapture('purchase', {
            'amount': 42,
            'nested': {'sku': 'abc'},
          }),
        ),
      );
      expect(asDoubles(sent), asDoubles(fixture('custom-event.json')));
    });

    test('log-event.json', () async {
      final sent = await onlyRequest(
        (p) => p.submit(
          const LogCapture(
            'golden log line',
            LogLevel.warn,
            attributes: {'context': 'checkout'},
          ),
        ),
      );
      expect(asDoubles(sent), asDoubles(fixture('log-event.json')));
    });

    test('exception-event.json', () async {
      final sent = await onlyRequest(
        (p) => p.submit(
          const ErrorCapture(
            type: 'Error',
            message: 'golden failure',
            handled: true,
            metadata: {'stage': 'test'},
          ),
        ),
      );
      expect(asDoubles(sent), asDoubles(fixture('exception-event.json')));
    });
  });

  test('does not transmit anything before genuine presence', () async {
    final (:pipeline, :platform) = await startPipeline(
      options: goldenOptions(),
    );
    pipeline.submit(const CustomEventCapture('pre-presence', {}));
    await drain();
    expect(platform.requests, isEmpty);

    pipeline.presence();
    pipeline.submit(const CustomEventCapture('post-presence', {}));
    await drain();
    final names = [
      for (final r in platform.requests)
        for (final e in r.events) (e['attributes'] as Map)['custom_event_name'],
    ];
    expect(names, containsAll(['pre-presence', 'post-presence']));
  });

  test('sends nothing when sessionSampleRate is 0', () async {
    final (:pipeline, :platform) = await startPipeline(
      options: goldenOptions(sessionSampleRate: 0),
    );
    pipeline.presence();
    pipeline.submit(const CustomEventCapture('e', {}));
    await drain();
    expect(platform.requests, isEmpty);
  });

  test(
    'keeps session identity stable across flushes within a session',
    () async {
      final (:pipeline, :platform) = await startPipeline(
        options: goldenOptions(),
      );
      pipeline.presence();
      pipeline.submit(const CustomEventCapture('first', {}));
      await drain();
      pipeline.submit(const CustomEventCapture('second', {}));
      await drain();

      expect(platform.requests.length, greaterThanOrEqualTo(2));
      final ids = {
        for (final r in platform.requests) r.sessionAttributes['session_id'],
      };
      expect(ids, hasLength(1));
      expect(pipeline.sessionId, ids.single);
    },
  );

  test(
    'never claims a session started after an event in the same batch',
    () async {
      final (:pipeline, :platform) = await startPipeline(
        options: goldenOptions(),
      );
      pipeline.presence();
      pipeline.submit(const CustomEventCapture('first', {}));
      await drain();
      pipeline.submit(const CustomEventCapture('second', {}));
      await drain();

      expect(platform.requests, isNotEmpty);
      for (final request in platform.requests) {
        expect(
          request.sessionAttributes['session_start_time'] as int,
          lessThanOrEqualTo(earliestEventTime(request)),
        );
      }
    },
  );

  group('a session rotated by sessionMaxDuration', () {
    const cap = Duration(minutes: 1);

    /// Opens a session, crosses the cap with one event (with [during] set
    /// while that trigger goes through the pipeline), then sends one more,
    /// and checks that no batch under the new session claims a start later
    /// than an event it carries.
    Future<void> rotateAcrossCap(
      GroundcoverOptions Function(FakePlatform platform, bool Function() during)
      options,
    ) async {
      var during = false;
      final platform = FakePlatform(nowMs: fixtureClockMs);
      final pipeline = DartRumPipeline();
      await pipeline.start(
        goldenConfig(options: options(platform, () => during)),
        platform,
      );
      pipeline.presence();
      pipeline.submit(const CustomEventCapture('before-cap', {}));
      await drain();
      final before = platform.requests.last.sessionAttributes['session_id'];

      platform.nowMs = fixtureClockMs + cap.inMilliseconds + 1000;
      during = true;
      pipeline.submit(const CustomEventCapture('after-cap', {}));
      during = false;
      await drain();

      pipeline.presence();
      pipeline.submit(const CustomEventCapture('post-rotation', {}));
      await drain();

      final rotated = [
        for (final r in platform.requests)
          if (r.sessionAttributes['session_id'] != before) r,
      ];
      expect(
        rotated,
        isNotEmpty,
        reason: 'the cap should have rotated the session',
      );
      for (final request in rotated) {
        expect(
          request.sessionAttributes['session_start_time'] as int,
          lessThanOrEqualTo(earliestEventTime(request)),
          reason: 'the rotated session started after an event it carries',
        );
      }
    }

    test(
      'never starts after its trigger, when time passes while it is sent',
      () async {
        await rotateAcrossCap(
          (platform, during) => goldenOptions(
            sessionMaxDuration: cap,
            beforeSend: (_) {
              if (during()) platform.nowMs += 5;
              return true;
            },
          ),
        );
      },
    );

    test('never starts after an enrichEvent-backdated trigger', () async {
      await rotateAcrossCap(
        (platform, during) => goldenOptions(
          sessionMaxDuration: cap,
          enrichEvent: (event) {
            final timestamp = event.timestamp;
            if (during() && timestamp != null) {
              event.timestamp = timestamp - 5 * 1000000;
            }
            return event;
          },
        ),
      );
    });
  });
}
