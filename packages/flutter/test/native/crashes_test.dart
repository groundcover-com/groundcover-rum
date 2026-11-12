// Native crashes: records off the engine's disk (RN's toCrashRecord), the
// drain that delivers each under the session it crashed in (RN's
// native-crash-drain), the snapshot the pipeline keeps current for the engine
// to file a crash under, and the runtime that drains once the engine started.
import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/testing.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/src/core/events/native/crash_drain.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/core/transport/transporter.dart';

import '../support/fake_native_engine.dart';
import '../support/fake_platform.dart';
import '../support/recording_pipeline.dart';

/// The engine's crash store, in memory.
final class FakeCrashStore implements NativeCrashStore {
  FakeCrashStore([List<Map<String, Object?>>? records])
    : records = records ?? [];

  final List<Map<String, Object?>> records;
  final snapshots = <String?>[];
  final cleared = <String>[];

  /// A log shared with other fakes, to order the pushes across them.
  List<String>? log;

  /// Holds [pendingCrashReports] until completed.
  Completer<void>? readGate;
  int reads = 0;

  @override
  void updateSessionSnapshot(String? json) {
    log?.add('snapshot');
    snapshots.add(json);
  }

  @override
  Future<String> pendingCrashReports() async {
    reads++;
    await readGate?.future;
    return jsonEncode(records);
  }

  @override
  Future<void> clearPendingCrashReports(List<String> ids) async {
    cleared.addAll(ids);
    records.removeWhere((r) => ids.contains(r['id']));
  }
}

const _crashedSession = {
  'source': 'mobile-rum',
  'session_id': 'crashed-session',
  'session_start_time': 1690000000000000000,
  'user': {'id': 'user-123'},
  'screen': {'name': 'Native', 'key': 'Native-1'},
};

Map<String, Object?> _record({
  String id = 'r1',
  Object? crashEpochMs = 1700000000000,
  Object? errorType = 'java.lang.IllegalStateException',
  Object? errorMessage = 'groundcover test crash (native)',
  Object? stacktrace = const [
    {'filename': 'Crash.kt', 'function': 'boom', 'lineno': 7, 'colno': 0},
  ],
  Object? metadata = const {'crash_source': 'jvm_handler'},
  Object? snapshot = _crashedSession,
  Object? screen,
}) => {
  'id': id,
  'crashEpochMs': crashEpochMs,
  'errorType': errorType,
  'errorMessage': errorMessage,
  'stacktrace': stacktrace,
  'metadata': metadata,
  'sessionSnapshotJson': snapshot == null ? null : jsonEncode(snapshot),
  'screen': ?screen,
};

GroundcoverConfig _config([GroundcoverOptions? options]) => GroundcoverConfig(
  apiKey: 'k',
  dsn: 'ingest.example',
  cluster: 'c',
  environment: 'e',
  appId: 'a',
  options:
      options ??
      const GroundcoverOptions(
        transport: TransportOptions(batchSize: 0, compression: false),
      ),
);

/// A started pipeline over [store], sampled unless [sampled] is false.
Future<(DartRumPipeline, FakePlatform)> _started(
  FakeCrashStore store, {
  GroundcoverOptions? options,
  bool sampled = true,
}) async {
  final platform = FakePlatform()..crashStore = store;
  final pipeline = DartRumPipeline();
  await pipeline.start(
    _config(
      options ??
          GroundcoverOptions(
            sessionSampleRate: sampled ? 1 : 0,
            transport: const TransportOptions(batchSize: 0, compression: false),
          ),
    ),
    platform,
  );
  return (pipeline, platform);
}

void main() {
  setUp(debugResetCrashDrain);

  group('records off disk', () {
    test('one without an id is dropped: it could never be acked', () {
      final records = parseCrashRecords(
        jsonEncode([
          _record(id: 'kept'),
          {'errorType': 'NoId'},
          {'id': ''},
          'not a record',
        ]),
      );
      expect(records.map((r) => r.id), ['kept']);
    });

    test('a malformed field costs what a missing one does', () {
      final record = parseCrashRecords(
        jsonEncode([
          _record(
            crashEpochMs: 'yesterday',
            errorType: 7,
            errorMessage: {'a': 1},
            stacktrace: 'frames',
            metadata: 'meta',
            screen: {'name': '', 'key': ''},
          ),
        ]),
      ).single;
      expect(record.crashEpochMs, isNull);
      expect(record.errorType, '');
      expect(record.errorMessage, '');
      expect(record.frames, isEmpty);
      expect(record.metadata, isEmpty);
      // The engines' "couldn't read one" sentinel: the snapshot's applies.
      expect(record.screen, isNull);
    });

    test('a corrupt cause chain is capped at its head', () {
      final record = parseCrashRecords(
        jsonEncode([
          _record(
            metadata: {
              'causes': [
                for (var i = 0; i < 40; i++) {'type': 'E$i', 'message': '$i'},
              ],
            },
          ),
        ]),
      ).single;
      final causes = record.metadata['causes']! as List;
      expect(causes, hasLength(20));
      expect((causes.first as Map)['type'], 'E0');
    });

    test('unreadable JSON is no records', () {
      expect(parseCrashRecords('not json'), isEmpty);
      expect(parseCrashRecords('{"id": "r1"}'), isEmpty);
    });
  });

  group('the drain', () {
    test('sends each record as its own batch under the session it crashed '
        'in, at crash time, then acks it', () async {
      final store = FakeCrashStore([_record(), _record(id: 'r2')]);
      final (pipeline, platform) = await _started(store);
      await pipeline.nativeStarted();

      expect(platform.requests, hasLength(2));
      final request = platform.requests.first;
      // Verbatim, screen aside: never the current session's envelope.
      expect(request.sessionAttributes, {
        'source': 'mobile-rum',
        'session_id': 'crashed-session',
        'session_start_time': 1690000000000000000,
        'user': {'id': 'user-123'},
      });
      final event = request.events.single;
      expect(event['type'], 'exception');
      expect(event['timestamp'], 1700000000000000000);
      final attributes = event['attributes']! as Map;
      expect(attributes['screen'], {'name': 'Native', 'key': 'Native-1'});
      expect(attributes['error_type'], 'java.lang.IllegalStateException');
      expect(attributes['error_message'], 'groundcover test crash (native)');
      expect(
        attributes['error_fingerprint'],
        'java.lang.IllegalStateException:groundcover test crash (native)',
      );
      expect(attributes['error_handled'], false);
      expect(attributes['error_metadata.native'], true);
      expect(attributes['error_metadata.fatal'], true);
      expect(attributes['error_metadata.crash_report_id'], 'r1');
      expect(attributes['error_metadata.crash_source'], 'jvm_handler');
      expect(store.cleared, ['r1', 'r2']);
      pipeline.stop();
    });

    test("the record's own screen wins over the snapshot's", () async {
      final store = FakeCrashStore([
        _record(screen: {'name': 'Checkout', 'key': 'Checkout-2'}),
      ]);
      final (pipeline, platform) = await _started(store);
      await pipeline.nativeStarted();
      expect(
        (platform.requests.single.events.single['attributes']!
            as Map)['screen'],
        {'name': 'Checkout', 'key': 'Checkout-2'},
      );
      pipeline.stop();
    });

    test('a record that lost its type and message gets the defaults', () async {
      final store = FakeCrashStore([_record(errorType: '', errorMessage: '')]);
      final (pipeline, platform) = await _started(store);
      await pipeline.nativeStarted();
      final attributes =
          platform.requests.single.events.single['attributes']! as Map;
      expect(attributes['error_type'], 'NativeCrash');
      expect(attributes['error_message'], 'Native crash');
      pipeline.stop();
    });

    test('an undelivered record stays for the next launch', () async {
      final store = FakeCrashStore([_record()]);
      final platform = FakePlatform()..crashStore = store;
      final failing = _FailingSendPlatform(platform);
      final pipeline = DartRumPipeline();
      await pipeline.start(_config(), failing);
      await pipeline.nativeStarted();
      expect(failing.attempts, 1);
      expect(store.cleared, isEmpty);
      pipeline.stop();
    });

    test('a record with no session to file it under is acked and dropped, '
        "never sent under this one", () async {
      final store = FakeCrashStore([
        _record(id: 'none', snapshot: null),
        _record(id: 'blank', snapshot: {'session_id': ''}),
      ]);
      final (pipeline, platform) = await _started(store);
      await pipeline.nativeStarted();
      expect(platform.requests, isEmpty);
      expect(store.cleared, ['none', 'blank']);
      pipeline.stop();
    });

    test(
      "beforeSend decides, and a broken hook can't wedge the store",
      () async {
        for (final (beforeSend, sent) in [
          ((RumEvent _) => false, 0),
          ((RumEvent _) => throw StateError('hook'), 0),
          ((RumEvent _) => true, 1),
        ]) {
          debugResetCrashDrain();
          final store = FakeCrashStore([_record()]);
          final (pipeline, platform) = await _started(
            store,
            options: GroundcoverOptions(
              beforeSend: beforeSend,
              transport: const TransportOptions(
                batchSize: 0,
                compression: false,
              ),
            ),
          );
          await pipeline.nativeStarted();
          expect(platform.requests, hasLength(sent));
          // Dropped or sent, it is acked: retried, a broken hook stays broken.
          expect(store.cleared, ['r1']);
          pipeline.stop();
        }
      },
    );

    test(
      "a throwing enrichEvent costs only what it would have added",
      () async {
        final store = FakeCrashStore([_record()]);
        final (pipeline, platform) = await _started(
          store,
          options: GroundcoverOptions(
            enrichEvent: (_) => throw StateError('hook'),
            transport: const TransportOptions(batchSize: 0, compression: false),
          ),
        );
        await pipeline.nativeStarted();
        expect(
          (platform.requests.single.events.single['attributes']!
              as Map)['error_type'],
          'java.lang.IllegalStateException',
        );
        expect(store.cleared, ['r1']);
        pipeline.stop();
      },
    );

    test("an enrichEvent that changes the report and then throws leaves it as "
        "built", () async {
      final store = FakeCrashStore([_record()]);
      final (pipeline, platform) = await _started(
        store,
        options: GroundcoverOptions(
          enrichEvent: (event) {
            event.timestamp = 1;
            event.attributes['error_message'] = 'unfinished enrichment';
            event.attributes.remove('error_metadata.crash_report_id');
            (event.attributes['error_stacktrace']! as List).clear();
            throw StateError('hook');
          },
          transport: const TransportOptions(batchSize: 0, compression: false),
        ),
      );
      await pipeline.nativeStarted();
      final event = platform.requests.single.events.single;
      expect(event['timestamp'], 1700000000000000000);
      final attributes = event['attributes']! as Map;
      expect(attributes['error_message'], 'groundcover test crash (native)');
      expect(attributes['error_metadata.crash_report_id'], 'r1');
      expect(attributes['error_stacktrace'], hasLength(1));
      expect(store.cleared, ['r1']);
      pipeline.stop();
    });

    test(
      "masks the message and the causes' messages, never the markers",
      () async {
        final store = FakeCrashStore([
          _record(
            errorMessage: 'request failed: password=secret',
            metadata: {
              'password': 'hunter2',
              'causes': [
                {'type': 'E', 'message': 'token: abc123'},
              ],
            },
          ),
        ]);
        final (pipeline, platform) = await _started(store);
        await pipeline.nativeStarted();
        final attributes =
            platform.requests.single.events.single['attributes']! as Map;
        expect(attributes['error_message'], isNot(contains('secret')));
        expect(attributes['error_metadata.password'], isNot('hunter2'));
        expect(
          attributes['error_metadata.causes[0].message'],
          isNot(contains('abc123')),
        );
        expect(attributes['error_metadata.crash_report_id'], 'r1');
        pipeline.stop();
      },
    );

    test('delivers a sampled session\'s crash on a launch that is not '
        'sampled', () async {
      final store = FakeCrashStore([_record()]);
      final (pipeline, platform) = await _started(store, sampled: false);
      expect(pipeline.sessionId, '');
      await pipeline.nativeStarted();
      expect(
        platform.requests.single.sessionAttributes['session_id'],
        'crashed-session',
      );
      expect(store.cleared, ['r1']);
    });

    test('one pass at a time: a second drain joins the first', () async {
      final store = FakeCrashStore([_record()])..readGate = Completer();
      final (pipeline, platform) = await _started(store);
      final first = pipeline.nativeStarted();
      final second = pipeline.nativeStarted();
      store.readGate!.complete();
      await Future.wait([first, second]);
      expect(store.reads, 1);
      expect(platform.requests, hasLength(1));
      pipeline.stop();
    });
  });

  group('the snapshot', () {
    Map<String, Object?> decode(String? json) =>
        jsonDecode(json!) as Map<String, Object?>;

    test("is this session's envelope plus the screen, pushed once the engine "
        'started and whenever either changes', () async {
      final store = FakeCrashStore();
      final (pipeline, _) = await _started(store);
      await pipeline.nativeStarted();
      expect(store.snapshots, hasLength(1));
      final first = decode(store.snapshots.single);
      expect(first['session_id'], pipeline.sessionId);
      expect(first['screen'], {'name': '', 'key': ''});

      pipeline.submit(const ScreenCapture('Native', 'Native-1'));
      expect(decode(store.snapshots.last)['screen'], {
        'name': 'Native',
        'key': 'Native-1',
      });

      pipeline.identifyUser(const RumUser(id: 'user-123'));
      expect(decode(store.snapshots.last)['user'], {'id': 'user-123'});

      await pipeline.setSessionId('fixed');
      expect(decode(store.snapshots.last)['session_id'], 'fixed');
      pipeline.stop();
    });

    test('is not pushed again when nothing in it changed', () async {
      final store = FakeCrashStore();
      final (pipeline, _) = await _started(store);
      await pipeline.nativeStarted();
      pipeline.presence();
      pipeline.submit(const LogCapture('a', LogLevel.info));
      pipeline.submit(const LogCapture('b', LogLevel.info));
      expect(store.snapshots, hasLength(1));
      pipeline.stop();
    });

    // The engine's start pairs the previous run's crashes with the snapshot
    // it holds, so nothing of this run may reach it first: the engine starts
    // with [sessionSnapshot] in its config instead.
    test(
      'is held until the engine has started, then the latest goes out',
      () async {
        final store = FakeCrashStore();
        final (pipeline, _) = await _started(store);
        pipeline.submit(const ScreenCapture('Native', 'Native-1'));
        expect(store.snapshots, isEmpty);
        expect(decode(pipeline.sessionSnapshot)['screen'], {
          'name': 'Native',
          'key': 'Native-1',
        });
        await pipeline.nativeStarted();
        expect(store.snapshots, hasLength(1));
        expect(decode(store.snapshots.single)['screen'], {
          'name': 'Native',
          'key': 'Native-1',
        });
        pipeline.stop();
      },
    );

    test('carries a user property JSON has no form for, as batches do, and '
        'keeps following changes after it', () async {
      final store = FakeCrashStore();
      final (pipeline, _) = await _started(store);
      await pipeline.nativeStarted();
      pipeline.identifyUser(
        RumUser(id: 'u2', properties: {'since': DateTime.utc(2024)}),
      );
      final user = decode(store.snapshots.last)['user']! as Map;
      expect(user['id'], 'u2');
      expect((user['properties']! as Map)['since'], '2024-01-01 00:00:00.000Z');

      pipeline.submit(const ScreenCapture('Native', 'Native-1'));
      expect(decode(store.snapshots.last)['screen'], {
        'name': 'Native',
        'key': 'Native-1',
      });
      pipeline.stop();
    });

    test('is cleared when the pipeline stops', () async {
      final store = FakeCrashStore();
      final (pipeline, _) = await _started(store);
      await pipeline.nativeStarted();
      pipeline.stop();
      expect(store.snapshots.last, isNull);
    });

    test('is not cleared before the engine started: that would erase the '
        "envelope the previous run's crash is filed under", () async {
      final store = FakeCrashStore();
      final (pipeline, _) = await _started(store);
      pipeline.stop();
      expect(store.snapshots, isEmpty);
    });

    test('is never pushed for a session not sampled', () async {
      final store = FakeCrashStore();
      final (pipeline, _) = await _started(store, sampled: false);
      expect(pipeline.sessionSnapshot, isNull);
      await pipeline.nativeStarted();
      expect(store.snapshots, isEmpty);
    });
  });

  group('a stopped pipeline', () {
    test('drains nothing when the engine replies late', () async {
      final store = FakeCrashStore([_record()]);
      final (pipeline, platform) = await _started(store);
      pipeline.stop();
      await pipeline.nativeStarted();
      expect(store.reads, 0);
      expect(platform.requests, isEmpty);
    });

    test('drains nothing for a session not sampled either', () async {
      final store = FakeCrashStore([_record()]);
      final (pipeline, _) = await _started(store, sampled: false);
      pipeline.stop();
      await pipeline.nativeStarted();
      expect(store.reads, 0);
    });
  });

  group('the runtime', () {
    late RecordingPipeline pipeline;
    late FakeNativeEngine engine;

    setUp(() {
      pipeline = RecordingPipeline();
      engine = FakeNativeEngine();
      RumRuntime.instance.debugReset(
        pipeline: () => pipeline,
        platform: (_) async => FakePlatform(),
        engine: () => engine,
      );
    });

    tearDown(() => RumRuntime.instance.debugReset());

    test(
      'drains once the engine has started: its start is the harvest',
      () async {
        final started = Completer<void>();
        engine.startGate = started;
        await GroundcoverRum.init(_config());
        await pumpEventQueue();
        expect(pipeline.nativeStarts, 0);
        started.complete();
        await pumpEventQueue();
        expect(pipeline.nativeStarts, 1);
      },
    );

    test('drains for a session not sampled too', () async {
      pipeline.sampled = false;
      await GroundcoverRum.init(_config());
      await pumpEventQueue();
      expect(pipeline.nativeStarts, 1);
    });

    test('a reset before the engine replied drains nothing', () async {
      final started = Completer<void>();
      engine.startGate = started;
      await GroundcoverRum.init(_config());
      await pumpEventQueue();
      await GroundcoverRumTesting.reset();
      started.complete();
      await pumpEventQueue();
      expect(pipeline.nativeStarts, 0);
    });

    test("the engine starts with this session's snapshot, and nothing of "
        'this run reaches native before the start replied', () async {
      final log = <String>[];
      final store = FakeCrashStore()..log = log;
      final real = FakeNativeEngine(calls: log);
      final started = Completer<void>();
      real.startGate = started;
      RumRuntime.instance.debugReset(
        pipeline: DartRumPipeline.new,
        platform: (_) async => FakePlatform()..crashStore = store,
        engine: () => real,
      );
      await GroundcoverRum.init(_config());
      await pumpEventQueue();
      final config = jsonDecode(real.configJson!) as Map<String, Object?>;
      final configured =
          jsonDecode(config['snapshotJson']! as String) as Map<String, Object?>;
      expect(configured['session_id'], GroundcoverRum.getSessionId());

      // A change while the engine is still starting waits for it too.
      RumRuntime.instance.navigate(const ScreenCapture('Home', 'Home-1'));
      expect(store.snapshots, isEmpty);

      started.complete();
      await pumpEventQueue();
      expect(log.indexOf('start'), lessThan(log.indexOf('snapshot')));
      final latest = jsonDecode(store.snapshots.last!) as Map<String, Object?>;
      expect(latest['screen'], {'name': 'Home', 'key': 'Home-1'});
    });
  });
}

/// A host whose sends fail, as a dropped network does; the rest is a
/// [FakePlatform]'s.
final class _FailingSendPlatform implements PlatformServices {
  _FailingSendPlatform(this._fake);

  final FakePlatform _fake;
  int attempts = 0;

  @override
  get storage => _fake.storage;

  @override
  get clock => _fake.clock;

  @override
  BatchSender get sendBatch => (endpoint, request) async {
    attempts++;
    throw StateError('offline');
  };

  @override
  get compressor => _fake.compressor;

  @override
  get deviceAttributes => _fake.deviceAttributes;

  @override
  get crashStore => _fake.crashStore;
}
