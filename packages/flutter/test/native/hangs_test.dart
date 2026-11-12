// Hangs from the native engine: the option resolvers and engine config (RN's
// config/constants.ts and initNative), signal validation (RN's
// normalizeSignal), the event (RN's hangs-listener tests, ported), and the
// runtime that starts the engine and routes its signals.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/src/core/common/logger.dart';
import 'package:groundcover_rum/src/core/config/native_options.dart';
import 'package:groundcover_rum/src/core/events/native/shape_hang.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/core/events/native/stack_frames.dart';
import 'package:groundcover_rum/src/instrumentation/native_signals.dart';
import 'package:groundcover_rum/src/platform/native_engine.dart';
import 'package:groundcover_rum/src/platform/rum_api.g.dart';
import 'package:groundcover_rum/testing.dart';

import '../support/fake_native_engine.dart';
import '../support/fake_platform.dart';
import '../support/recording_pipeline.dart';

const _config = GroundcoverConfig(
  apiKey: 'k',
  dsn: 'ingest.example',
  cluster: 'c',
  environment: 'e',
  appId: 'a',
);

NativeSignal _hangSignal(Map<String, Object?> payload) =>
    NativeSignal(kind: 'hang', payloadJson: jsonEncode(payload));

HangCapture _hang({
  HangKind kind = HangKind.anr,
  num startedAtMs = 1700000000000,
  num durationMs = 5210,
  List<ErrorFrame> frames = const [],
}) => HangCapture(
  kind: kind,
  startedAtMs: startedAtMs,
  durationMs: durationMs,
  frames: frames,
);

void main() {
  group('native options', () {
    test('each platform has its own default hang threshold', () {
      expect(resolveHangThresholdMs(null, android: false), 2000);
      expect(resolveHangThresholdMs(null, android: true), 5000);
    });

    test('one threshold applies to both platforms', () {
      const both = HangThreshold(Duration(milliseconds: 1500));
      expect(resolveHangThresholdMs(both, android: false), 1500);
      expect(resolveHangThresholdMs(both, android: true), 1500);
    });

    test("a platform left out keeps its default, never the other's value", () {
      const iosOnly = HangThreshold.perPlatform(ios: Duration(seconds: 1));
      expect(resolveHangThresholdMs(iosOnly, android: false), 1000);
      expect(resolveHangThresholdMs(iosOnly, android: true), 5000);
    });

    test('out of range falls back to the default rather than reaching '
        'native', () {
      expect(
        resolveHangThresholdMs(
          const HangThreshold(Duration(milliseconds: 100)),
          android: false,
        ),
        2000,
      );
      expect(
        resolveHangThresholdMs(
          const HangThreshold(Duration(minutes: 2)),
          android: true,
        ),
        5000,
      );
      expect(resolveVitalsMaxSegmentMs(null), 60000);
      expect(resolveVitalsMaxSegmentMs(const Duration(seconds: 2)), 2000);
      expect(
        resolveVitalsMaxSegmentMs(const Duration(milliseconds: 500)),
        60000,
      );
      expect(resolveVitalsMaxSegmentMs(const Duration(minutes: 6)), 60000);
    });

    test('whole milliseconds, rounded, so both engines read one value', () {
      expect(
        resolveHangThresholdMs(
          const HangThreshold(Duration(microseconds: 1500600)),
          android: false,
        ),
        1501,
      );
    });
  });

  group('engine config', () {
    Map<String, Object?> decode(String json) =>
        jsonDecode(json) as Map<String, Object?>;

    test('a recorded session arms crashes, hangs and app start; never '
        "native vitals or gestures, which Dart owns", () {
      final json = decode(
        engineConfigJson(_config, recording: true, android: false),
      );
      expect(json['features'], {
        'crashes': true,
        'hangs': true,
        'appStart': true,
        'vitals': false,
        'gestures': false,
      });
      expect(json['thresholds'], {
        'hangThresholdMs': 2000,
        'vitalsMaxSegmentMs': 60000,
      });
      expect(json['clearSnapshotAfterHarvest'], false);
    });

    test('a session not sampled still arms crashes, and clears the '
        "previous run's envelope after the harvest", () {
      final json = decode(
        engineConfigJson(_config, recording: false, android: true),
      );
      expect(json['features'], {
        'crashes': true,
        'hangs': false,
        'appStart': false,
        'vitals': false,
        'gestures': false,
      });
      expect(json['clearSnapshotAfterHarvest'], true);
      expect(json.containsKey('snapshotJson'), isFalse);
    });

    test("carries this session's snapshot, which the engine installs right "
        'after its harvest', () {
      final json = decode(
        engineConfigJson(
          _config,
          recording: true,
          android: false,
          snapshotJson: '{"session_id":"s1"}',
        ),
      );
      expect(json['snapshotJson'], '{"session_id":"s1"}');
    });

    test('enabledEvents switches each feature off', () {
      const config = GroundcoverConfig(
        apiKey: 'k',
        dsn: 'd',
        cluster: 'c',
        environment: 'e',
        appId: 'a',
        options: GroundcoverOptions(
          enabledEvents: [RumEventName.hangs],
          native: NativeOptions(
            hangThreshold: HangThreshold.perPlatform(
              android: Duration(seconds: 1),
            ),
          ),
        ),
      );
      final json = decode(
        engineConfigJson(config, recording: true, android: true),
      );
      expect(json['features'], {
        'crashes': false,
        'hangs': true,
        'appStart': false,
        'vitals': false,
        'gestures': false,
      });
      expect((json['thresholds'] as Map)['hangThresholdMs'], 1000);
    });
  });

  group('signals', () {
    test('a hang signal is a hang capture, with its stack', () {
      final capture = captureOfSignal(
        _hangSignal({
          'kind': 'anr',
          'startedAtMs': 1700000000000,
          'durationMs': 3010,
          'mainThreadStack': [
            {
              'filename': 'com.acme.Checkout',
              'function': 'computeTotals',
              'lineno': 142,
              'colno': 0,
            },
          ],
        }),
      );
      expect(capture, isA<HangCapture>());
      final hang = capture! as HangCapture;
      expect(hang.kind, HangKind.anr);
      expect(hang.durationMs, 3010);
      expect(hang.frames.single.function, 'computeTotals');
    });

    test("iOS's app hang carries no stack", () {
      final hang =
          captureOfSignal(
                _hangSignal({
                  'kind': 'app_hang',
                  'startedAtMs': 1700000000000.25,
                  'durationMs': 2500.5,
                }),
              )!
              as HangCapture;
      expect(hang.kind, HangKind.appHang);
      expect(hang.frames, isEmpty);
    });

    test('a signal that breaks the contract is dropped, not repaired', () {
      for (final payload in [
        <String, Object?>{'kind': 'anr', 'durationMs': 3000},
        {'kind': 'anr', 'startedAtMs': '1700000000000', 'durationMs': 3000},
        {'kind': 'anr', 'startedAtMs': 1700000000000, 'durationMs': null},
      ]) {
        expect(
          captureOfSignal(_hangSignal(payload)),
          isNull,
          reason: '$payload',
        );
      }
      expect(
        captureOfSignal(NativeSignal(kind: 'hang', payloadJson: '[1, 2]')),
        isNull,
      );
      expect(
        captureOfSignal(NativeSignal(kind: 'hang', payloadJson: 'not json')),
        isNull,
      );
    });

    test('kinds with nothing to capture yield nothing', () {
      expect(
        captureOfSignal(NativeSignal(kind: 'ping', payloadJson: '{}')),
        isNull,
      );
      expect(
        captureOfSignal(NativeSignal(kind: 'gesture', payloadJson: '{}')),
        isNull,
      );
    });

    test('a frame without a filename is dropped; the rest fall back', () {
      expect(
        stackFramesOf([
          {'function': 'lost'},
          {'filename': 'a.kt', 'function': 7, 'lineno': double.nan},
        ]).map((f) => f.toJson()),
        [
          {'filename': 'a.kt', 'function': '', 'lineno': 0, 'colno': 0},
        ],
      );
      expect(stackFramesOf('nope'), isEmpty);
    });
  });

  group('the hang event', () {
    Map<String, Object?> shaped(HangCapture hang) =>
        shapeHangEvent(hang).attributes;

    test('is an exception, the shape a crash or a Dart error uses', () {
      final attributes = shaped(_hang());
      expect(attributes['error_type'], 'ANR');
      expect(attributes['error_message'], 'Main thread blocked for 5210ms');
      // Nobody handled it: the user watched a frozen app.
      expect(attributes['error_handled'], false);
      expect(attributes['error_metadata'], {
        'native': true,
        'hang_duration_ms': 5210,
        'hang_started_at': 1700000000000,
        // Tells it apart from the post-mortem ANR, which never came back.
        'recovered': true,
      });
    });

    test("is placed at the stall's onset, not when its recovery arrived", () {
      final event = shapeHangEvent(_hang(startedAtMs: 1699000000000.5));
      expect(event.timestamp, 1699000000000500000);
    });

    test("uses each platform's own name for the stall", () {
      expect(shaped(_hang(kind: HangKind.appHang))['error_type'], 'AppHang');
    });

    test(
      'fingerprints by duration bucket, so repeats group into one issue',
      () {
        expect(shaped(_hang(durationMs: 5210))['error_fingerprint'], 'ANR:5s');
        expect(shaped(_hang(durationMs: 5940))['error_fingerprint'], 'ANR:5s');
        expect(shaped(_hang(durationMs: 700))['error_fingerprint'], 'ANR:<1s');
        expect(
          shaped(_hang(durationMs: 120000))['error_fingerprint'],
          'ANR:30s+',
        );
      },
    );

    test('carries the main-thread stack when there is one', () {
      final attributes = shaped(
        _hang(
          frames: const [
            ErrorFrame(
              filename: 'com.acme.Checkout',
              function: 'computeTotals',
              lineno: 142,
              colno: 0,
            ),
          ],
        ),
      );
      expect((attributes['error_stacktrace'] as List).single, {
        'filename': 'com.acme.Checkout',
        'function': 'computeTotals',
        'lineno': 142,
        'colno': 0,
      });
    });
  });

  group('the pipeline', () {
    Future<(DartRumPipeline, FakePlatform)> started(
      GroundcoverOptions options,
    ) async {
      final platform = FakePlatform();
      final pipeline = DartRumPipeline();
      await pipeline.start(
        GroundcoverConfig(
          apiKey: 'k',
          dsn: 'ingest.example',
          cluster: 'c',
          environment: 'e',
          appId: 'a',
          options: options,
        ),
        platform,
      );
      // Past the presence gate.
      pipeline.presence();
      return (pipeline, platform);
    }

    test('sends a hang at once, whatever the batch settings: a hang often '
        'comes just before a kill', () async {
      final (pipeline, platform) = await started(
        const GroundcoverOptions(
          transport: TransportOptions(
            batchSize: 100,
            batchTimeout: Duration(minutes: 5),
            compression: false,
          ),
        ),
      );
      pipeline.submit(_hang());
      await drain();
      final events = [for (final r in platform.requests) ...r.events];
      expect(events.map((e) => e['type']), ['exception']);
      expect(events.single['attributes'], containsPair('error_type', 'ANR'));
      pipeline.stop();
    });

    test('drops hangs that enabledEvents leaves out', () async {
      final (pipeline, platform) = await started(
        const GroundcoverOptions(
          enabledEvents: [RumEventName.logs],
          transport: TransportOptions(batchSize: 0, compression: false),
        ),
      );
      pipeline.submit(_hang());
      pipeline.flush();
      await drain();
      expect(platform.requests, isEmpty);
      pipeline.stop();
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
      'listens to the engine before starting it, and routes its hangs',
      () async {
        await GroundcoverRum.init(_config);
        await pumpEventQueue();
        expect(engine.calls, ['signals', 'start']);
        engine.controller.add(
          _hangSignal({
            'kind': 'app_hang',
            'startedAtMs': 1700000000000,
            'durationMs': 3000,
          }),
        );
        engine.controller.add(NativeSignal(kind: 'ping', payloadJson: '{}'));
        await pumpEventQueue();
        expect(pipeline.calls.where((c) => c.startsWith('submit')), [
          'submit:HangCapture',
        ]);
      },
    );

    test(
      'starts the engine for a session not sampled too, crashes only',
      () async {
        pipeline.sampled = false;
        await GroundcoverRum.init(_config);
        await pumpEventQueue();
        expect(engine.calls, ['signals', 'start']);
        final json = jsonDecode(engine.configJson!) as Map<String, Object?>;
        expect((json['features'] as Map)['crashes'], true);
        expect((json['features'] as Map)['hangs'], false);
        expect(json['clearSnapshotAfterHarvest'], true);
      },
    );

    test('warns when crash capture was asked for and is unavailable', () async {
      final lines = <String>[];
      final sink = RumDiagnostics.instance.sink;
      RumDiagnostics.instance.sink = lines.add;
      addTearDown(() => RumDiagnostics.instance.sink = sink);
      engine.status = const NativeEngineStatus(
        crashesUnavailable: 'KSCrash is already installed',
      );
      await GroundcoverRum.init(_config);
      await pumpEventQueue();
      expect(
        lines.where((l) => l.contains('native crash capture is unavailable')),
        hasLength(1),
      );
      expect(lines.single, contains('KSCrash is already installed'));
    });

    test("doesn't warn for a session not sampled, which reports nothing "
        'anyway, as RN', () async {
      final lines = <String>[];
      final sink = RumDiagnostics.instance.sink;
      RumDiagnostics.instance.sink = lines.add;
      addTearDown(() => RumDiagnostics.instance.sink = sink);
      pipeline.sampled = false;
      engine.status = const NativeEngineStatus(
        crashesUnavailable: 'KSCrash is already installed',
      );
      await GroundcoverRum.init(_config);
      await pumpEventQueue();
      expect(
        lines.where((l) => l.contains('native crash capture is unavailable')),
        isEmpty,
      );
    });

    test('the testing reset stops the engine and its signals, and init '
        'starts afresh', () async {
      await GroundcoverRum.init(_config);
      await pumpEventQueue();
      await GroundcoverRumTesting.reset();
      await pumpEventQueue();
      expect(engine.calls, ['signals', 'start', 'stop']);
      expect(RumRuntime.instance.pipeline, isNull);
      expect(engine.controller.hasListener, isFalse);
      expect(pipeline.calls, contains('stop'));

      await GroundcoverRum.init(_config);
      expect(RumRuntime.instance.pipeline, isNotNull);
    });
  });
}
