// App start and time to interactive: the engine's app_start signal (RN's
// normalizeSignal), the tracker that holds launch metrics for the first
// screen and measures TTI from the cold start's origin (RN's app-start
// listener tests, ported), the event, and markAppInteractive.
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/testing.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/instrumentation/app_start.dart';
import 'package:groundcover_rum/src/instrumentation/interactive_mark.dart';
import 'package:groundcover_rum/src/instrumentation/native_signals.dart';
import 'package:groundcover_rum/src/platform/rum_api.g.dart';

import '../support/fake_native_engine.dart';
import '../support/fake_platform.dart';
import '../support/recording_pipeline.dart';

const _start = 1800000000000;

AppStartSignal _cold({
  num startMs = _start,
  num after = 850,
  String type = 'cold',
}) => (type: type, startMs: startMs, firstFrameMs: startMs + after);

List<AppStartCapture> _starts(List<Capture> captures) =>
    captures.whereType<AppStartCapture>().toList();

void main() {
  setUp(resetInteractiveMarks);

  group('the signal', () {
    NativeSignal signal(Map<String, Object?> payload) =>
        NativeSignal(kind: 'app_start', payloadJson: jsonEncode(payload));

    test('carries the type and the two anchors', () {
      final start = appStartOfSignal(
        signal({
          'type': 'hot',
          'startMs': _start,
          'firstFrameMs': _start + 120,
        }),
      )!;
      expect(start.type, 'hot');
      expect(start.firstFrameMs - start.startMs, 120);
    });

    test('one that breaks the contract is dropped', () {
      for (final payload in [
        <String, Object?>{'startMs': _start, 'firstFrameMs': _start},
        {'type': 'cold', 'startMs': '$_start', 'firstFrameMs': _start},
        {'type': 'cold', 'startMs': _start},
      ]) {
        expect(appStartOfSignal(signal(payload)), isNull, reason: '$payload');
      }
      expect(
        appStartOfSignal(NativeSignal(kind: 'hang', payloadJson: '{}')),
        isNull,
      );
    });
  });

  group('the tracker', () {
    late List<Capture> submitted;
    AppStartTracker tracker({bool manual = false}) =>
        AppStartTracker(submit: submitted.add, manualTti: manual);

    setUp(() => submitted = []);

    test('holds a launch metric for the screen it landed on', () {
      final t = tracker();
      t.onAppStart(_cold());
      expect(submitted, isEmpty);
      t.screenKnown();
      final cold = _starts(submitted).single;
      expect(cold.metric, AppStartMetric.cold);
      expect(cold.valueMs, 850);
      expect(cold.navigationType, 'cold');
      t.dispose();
    });

    test("sends it anyway after 5 s when no screen lands", () {
      fakeAsync((async) {
        final t = tracker();
        t.onAppStart(_cold());
        async.elapse(const Duration(milliseconds: 4999));
        expect(submitted, isEmpty);
        async.elapse(const Duration(milliseconds: 1));
        expect(_starts(submitted).single.metric, AppStartMetric.cold);
        t.dispose();
      });
    });

    test('maps each start type onto its metric, and rejects one it does not '
        'know rather than guess the series', () {
      final t = tracker()..screenKnown();
      t.onAppStart(_cold(type: 'cold_prewarmed'));
      t.onAppStart(_cold(type: 'warm'));
      t.onAppStart(_cold(type: 'hot'));
      t.onAppStart(_cold(type: 'constructor'));
      expect(_starts(submitted).map((s) => (s.metric, s.navigationType)), [
        (AppStartMetric.cold, 'cold_prewarmed'),
        (AppStartMetric.warm, 'warm'),
        (AppStartMetric.hot, 'hot'),
      ]);
      t.dispose();
    });

    test('drops a start whose first frame comes before it', () {
      final t = tracker()..screenKnown();
      t.onAppStart(_cold(after: -5));
      expect(submitted, isEmpty);
      t.dispose();
    });

    test('reports TTI once, from the cold start\'s origin, at the first '
        'screen', () {
      final t = tracker();
      t.onAppStart(_cold());
      markAutoInteractive(_start + 2400);
      t.screenKnown();
      markAutoInteractive(_start + 9000); // set once: ignored
      final starts = _starts(submitted);
      expect(starts.map((s) => (s.metric, s.valueMs, s.navigationType)), [
        (AppStartMetric.cold, 850, 'cold'),
        (AppStartMetric.tti, 2400, 'cold'),
      ]);
      t.dispose();
    });

    test('clamps TTI to the first frame: interactive before visible is '
        'impossible', () {
      final t = tracker()..screenKnown();
      markAutoInteractive(_start + 100);
      t.onAppStart(_cold());
      expect(_starts(submitted).last, isA<AppStartCapture>());
      expect(_starts(submitted).last.metric, AppStartMetric.tti);
      expect(_starts(submitted).last.valueMs, 850);
      t.dispose();
    });

    test('a hot or warm start anchors no TTI', () {
      final t = tracker()..screenKnown();
      markAutoInteractive(_start + 2000);
      t.onAppStart(_cold(type: 'hot'));
      t.onAppStart(_cold(type: 'warm'));
      expect(
        _starts(submitted).where((s) => s.metric == AppStartMetric.tti),
        isEmpty,
      );
      t.dispose();
    });

    test(
      'in manual mode TTI waits for markAppInteractive, never the screen',
      () {
        final t = tracker(manual: true)..screenKnown();
        markAutoInteractive(_start + 2000);
        t.onAppStart(_cold());
        expect(
          _starts(submitted).where((s) => s.metric == AppStartMetric.tti),
          isEmpty,
        );
        markManualInteractive(_start + 12000);
        expect(_starts(submitted).last.metric, AppStartMetric.tti);
        expect(_starts(submitted).last.valueMs, 12000);
        t.dispose();
      },
    );
  });

  group('the event', () {
    test(
      'is a performance metric with a fresh id, under the appStart gate',
      () async {
        final platform = FakePlatform();
        final pipeline = DartRumPipeline();
        await pipeline.start(
          const GroundcoverConfig(
            apiKey: 'k',
            dsn: 'ingest.example',
            cluster: 'c',
            environment: 'e',
            appId: 'a',
            options: GroundcoverOptions(
              transport: TransportOptions(batchSize: 0, compression: false),
            ),
          ),
          platform,
        );
        pipeline.presence();
        pipeline.submit(
          const AppStartCapture(
            metric: AppStartMetric.cold,
            valueMs: 850,
            navigationType: 'cold_prewarmed',
          ),
        );
        pipeline.flush();
        await drain();
        final event = platform.requests.single.events.single;
        expect(event['type'], 'performance');
        final attributes = event['attributes']! as Map;
        expect(attributes['performance_metric_name'], 'app_start_cold');
        expect(attributes['performance_metric_value'], 850);
        expect(attributes['performance_metric_id'], isA<String>());
        expect(
          attributes['performance_metric_navigation_type'],
          'cold_prewarmed',
        );
        pipeline.stop();
      },
    );
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

    const config = GroundcoverConfig(
      apiKey: 'k',
      dsn: 'd',
      cluster: 'c',
      environment: 'e',
      appId: 'a',
    );

    test('routes the engine\'s app start, released by the first screen, '
        'which is the automatic TTI mark', () async {
      await GroundcoverRum.init(config);
      engine.controller.add(
        NativeSignal(
          kind: 'app_start',
          payloadJson: jsonEncode({
            'type': 'cold',
            'startMs': 1000,
            'firstFrameMs': 1850,
          }),
        ),
      );
      await pumpEventQueue();
      expect(_starts(pipeline.captures), isEmpty);
      RumRuntime.instance.navigate(const ScreenCapture('Home', 'Home-1'));
      final starts = _starts(pipeline.captures);
      expect(starts.map((s) => s.metric), [
        AppStartMetric.cold,
        AppStartMetric.tti,
      ]);
      expect(starts.last.valueMs, greaterThan(starts.first.valueMs));
    });

    test(
      'markAppInteractive counts before init, with when it was called',
      () async {
        GroundcoverRum.markAppInteractive();
        final mark = interactiveMark(manual: true);
        expect(mark, isNotNull);
        await GroundcoverRum.init(config);
        GroundcoverRum.markAppInteractive(); // set once
        expect(interactiveMark(manual: true), mark);
      },
    );

    test('the testing reset clears the marks: a re-init starts afresh, as its '
        'doc promises', () async {
      await GroundcoverRum.init(config);
      GroundcoverRum.markAppInteractive();
      expect(interactiveMark(manual: true), isNotNull);
      await GroundcoverRumTesting.reset();
      expect(interactiveMark(manual: true), isNull);
      expect(interactiveMark(manual: false), isNull);
    });

    test('markAppInteractive after init reads the clock the automatic mark '
        'does', () async {
      RumRuntime.instance.debugReset(
        pipeline: () => pipeline,
        platform: (_) async => FakePlatform(nowMs: 1234),
        engine: () => engine,
      );
      await GroundcoverRum.init(config);
      GroundcoverRum.markAppInteractive();
      expect(interactiveMark(manual: true), 1234);
    });
  });

  // The launch metrics held for the first screen ship under it: it is
  // current before they are released, as in RN, where the screen holder
  // moves before its listeners run.
  group('the landing screen', () {
    late FakePlatform platform;
    late FakeNativeEngine engine;

    setUp(() {
      platform = FakePlatform();
      engine = FakeNativeEngine();
      RumRuntime.instance.debugReset(
        pipeline: DartRumPipeline.new,
        platform: (_) async => platform,
        engine: () => engine,
      );
    });

    tearDown(() => RumRuntime.instance.debugReset());

    Future<Map<String, Object?>> screenOf(String metric) async {
      RumRuntime.instance.pipeline!
        ..presence()
        ..flush();
      await drain();
      final event = platform.requests
          .expand((r) => r.events)
          .firstWhere(
            (e) =>
                (e['attributes']! as Map)['performance_metric_name'] == metric,
          );
      return ((event['attributes']! as Map)['screen']! as Map)
          .cast<String, Object?>();
    }

    for (final (label, land) in [
      (
        'an observed route',
        () =>
            RumRuntime.instance.navigate(const ScreenCapture('Home', 'Home-1')),
      ),
      (
        'a manual navigation',
        () => GroundcoverRum.startNavigation('Home', key: 'Home-1'),
      ),
    ]) {
      test('stamps the cold start and TTI it releases, by $label', () async {
        await GroundcoverRum.init(
          const GroundcoverConfig(
            apiKey: 'k',
            dsn: 'ingest.example',
            cluster: 'c',
            environment: 'e',
            appId: 'a',
            options: GroundcoverOptions(
              transport: TransportOptions(batchSize: 0, compression: false),
            ),
          ),
        );
        engine.controller.add(
          NativeSignal(
            kind: 'app_start',
            payloadJson: jsonEncode({
              'type': 'cold',
              'startMs': platform.nowMs - 2000,
              'firstFrameMs': platform.nowMs - 1150,
            }),
          ),
        );
        await pumpEventQueue();
        land();
        expect(await screenOf('app_start_cold'), {
          'name': 'Home',
          'key': 'Home-1',
        });
        expect(await screenOf('app_start_tti'), {
          'name': 'Home',
          'key': 'Home-1',
        });
      });
    }
  });

  // Screens are tracked whether or not navigation EVENTS are enabled: every
  // other event is stamped with the screen it happened on, and only the
  // navigation events themselves are left out.
  test('with navigation events off, the screen still stamps every event, and '
      'launch metrics wait for it', () async {
    final platform = FakePlatform();
    final engine = FakeNativeEngine();
    RumRuntime.instance.debugReset(
      pipeline: DartRumPipeline.new,
      platform: (_) async => platform,
      engine: () => engine,
    );
    addTearDown(() => RumRuntime.instance.debugReset());
    await GroundcoverRum.init(
      const GroundcoverConfig(
        apiKey: 'k',
        dsn: 'ingest.example',
        cluster: 'c',
        environment: 'e',
        appId: 'a',
        options: GroundcoverOptions(
          enabledEvents: [RumEventName.logs, RumEventName.appStart],
          transport: TransportOptions(batchSize: 0, compression: false),
        ),
      ),
    );
    engine.controller.add(
      NativeSignal(
        kind: 'app_start',
        payloadJson: jsonEncode({
          'type': 'cold',
          'startMs': platform.nowMs - 2000,
          'firstFrameMs': platform.nowMs - 1150,
        }),
      ),
    );
    await pumpEventQueue();
    RumRuntime.instance.navigate(const ScreenCapture('Home', 'Home-1'));
    GroundcoverRum.logger.info('after landing');
    RumRuntime.instance.pipeline!
      ..presence()
      ..flush();
    await drain();
    final events = [for (final r in platform.requests) ...r.events];
    expect(events.where((e) => e['type'] == 'navigation'), isEmpty);
    final screens = {
      for (final e in events)
        '${e['type']}:${(e['attributes']! as Map)['performance_metric_name'] ?? ''}':
            ((e['attributes']! as Map)['screen']! as Map)['name'],
    };
    expect(screens, {
      'performance:app_start_cold': 'Home',
      'performance:app_start_tti': 'Home',
      'log:': 'Home',
    });
  });

  test("the marks' reset drops their subscribers too", () {
    var notified = 0;
    onInteractiveMark(() => notified++);
    resetInteractiveMarks();
    markAutoInteractive(1);
    expect(notified, 0);
  });
}
