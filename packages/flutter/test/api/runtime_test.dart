// The public API over the runtime: awaited init, its failures and retries,
// calls dropped before it completes, presence, the lifecycle, and hooks that
// call the SDK. A fake pipeline records what reaches it.
import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/src/core/common/logger.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/instrumentation/network.dart';

import '../support/fake_platform.dart';
import '../support/recording_pipeline.dart';
import '../support/rum_widgets.dart';

const config = GroundcoverConfig(
  apiKey: 'k',
  dsn: 'd',
  cluster: 'c',
  environment: 'e',
  appId: 'app',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late RecordingPipeline pipeline;

  setUp(() {
    pipeline = RecordingPipeline();
    RumRuntime.instance.debugReset(
      pipeline: () => pipeline,
      platform: (_) async => FakePlatform(),
    );
  });

  tearDown(() => RumRuntime.instance.debugReset());

  test(
    'init completes once the SDK runs; calls before then are dropped',
    () async {
      final lines = <String>[];
      final sink = RumDiagnostics.instance.sink;
      RumDiagnostics.instance.sink = lines.add;
      addTearDown(() => RumDiagnostics.instance.sink = sink);
      pipeline.startGate = Completer();
      final starting = GroundcoverRum.init(config);
      GroundcoverRum.logger.info('dropped');
      GroundcoverRum.sendCustomEvent('dropped');
      expect(GroundcoverRum.getSessionId(), '');
      await GroundcoverRum.setSessionId('dropped'); // completes, dropped
      expect(lines, [
        for (final name in [
          'logger.info',
          'sendCustomEvent',
          'getSessionId',
          'setSessionId',
        ])
          "[groundcover] $name: init() hasn't finished; await it before using "
              'the SDK (groundcoverIgnore)',
      ]);
      pipeline.startGate!.complete();
      await starting;
      expect(RumRuntime.instance.pipeline, same(pipeline));
      expect(pipeline.calls, isEmpty);
      GroundcoverRum.logger.info('kept');
      expect(pipeline.calls, ['submit:LogCapture']);
    },
  );

  group('network capture', () {
    late HttpServer server;
    late Uri url;

    setUp(() async {
      // The test binding answers every request through its own override.
      final binding = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = binding);
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) => request.response.close());
      addTearDown(() => server.close(force: true));
      url = Uri.parse('http://127.0.0.1:${server.port}/');
    });

    Future<void> fetch(HttpClient client) async {
      final request = await client.getUrl(url);
      await (await request.close()).drain<void>();
      await pumpEventQueue();
    }

    test('an unread response waits the 15 s default for its read', () async {
      // README: a body not read within 15 s of its response is unavailable.
      expect(unreadResponseGrace, const Duration(seconds: 15));
      final withBody = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => withBody.close(force: true));
      withBody.listen(
        (request) => request.response
          ..write('hello')
          ..close(),
      );
      await GroundcoverRum.init(config);
      final client = HttpClient();
      addTearDown(() => client.close(force: true));
      final request = await client.getUrl(
        Uri.parse('http://127.0.0.1:${withBody.port}/'),
      );
      final response = await request.close();
      await Future<void>.delayed(const Duration(seconds: 1));
      expect(pipeline.captures.whereType<NetworkCapture>(), isEmpty);
      await response.drain<void>();
      await pumpEventQueue();
      final net = pipeline.captures.whereType<NetworkCapture>().single;
      expect(net.responseBody, 'hello');
    });

    test('sees a client created while init was still starting', () async {
      pipeline.startGate = Completer();
      final starting = GroundcoverRum.init(config);
      final client = HttpClient();
      addTearDown(client.close);
      // Before the pipeline runs, a request passes through unwatched.
      await fetch(client);
      expect(pipeline.captures, isEmpty);
      pipeline.startGate!.complete();
      await starting;
      await fetch(client);
      expect(pipeline.captures.whereType<NetworkCapture>(), hasLength(1));
    });

    test('goes away for an unsampled session, or a failed start', () async {
      pipeline.sampled = false;
      await GroundcoverRum.init(config);
      expect(HttpOverrides.current, isNull);

      RumRuntime.instance.debugReset(
        pipeline: () => RecordingPipeline()..failStart = true,
        platform: (_) async => FakePlatform(),
      );
      await expectLater(
        GroundcoverRum.init(config),
        throwsA(isA<GroundcoverInitException>()),
      );
      expect(HttpOverrides.current, isNull);
    });
  });

  test('init completes for a session not sampled', () async {
    final lines = <String>[];
    final sink = RumDiagnostics.instance.sink;
    RumDiagnostics.instance.sink = lines.add;
    addTearDown(() => RumDiagnostics.instance.sink = sink);
    pipeline.sampled = false;
    await GroundcoverRum.init(config);
    expect(RumRuntime.instance.pipeline, same(pipeline));
    GroundcoverRum.logger.info('not recorded, and no warning');
    expect(lines, isEmpty);
  });

  test('init off the root isolate throws; the root one still works', () async {
    await expectLater(
      Isolate.run(() => GroundcoverRum.init(config)),
      throwsA(
        isA<GroundcoverInitException>().having(
          (e) => e.message,
          'message',
          'init must run on the root isolate',
        ),
      ),
    );
    await GroundcoverRum.init(config);
    expect(RumRuntime.instance.pipeline, same(pipeline));
  });

  test("a second init gets the first one's start", () async {
    const other = GroundcoverConfig(
      apiKey: 'k',
      dsn: 'd',
      cluster: 'c',
      environment: 'e',
      appId: 'other',
    );
    pipeline.startGate = Completer();
    final first = GroundcoverRum.init(config);
    var secondDone = false;
    final second = GroundcoverRum.init(other).then((_) => secondDone = true);
    await pumpEventQueue();
    expect(secondDone, isFalse, reason: 'it waits for the first start');
    pipeline.startGate!.complete();
    await Future.wait([first, second]);
    await GroundcoverRum.init(other);
    expect(pipeline.config?.appId, 'app');
  });

  test('a blank appId throws, and claims nothing', () async {
    await expectLater(
      GroundcoverRum.init(
        const GroundcoverConfig(
          apiKey: 'k',
          dsn: 'd',
          cluster: 'c',
          environment: 'e',
          appId: ' ',
        ),
      ),
      throwsA(isA<GroundcoverInitException>()),
    );
    await GroundcoverRum.init(config);
    expect(pipeline.config?.appId, 'app');
  });

  test('a failed init throws, and can be retried', () async {
    pipeline.failStart = true;
    await expectLater(
      GroundcoverRum.init(config),
      throwsA(isA<GroundcoverInitException>()),
    );
    expect(RumRuntime.instance.pipeline, isNull);

    pipeline.failStart = false;
    await GroundcoverRum.init(config);
    GroundcoverRum.logger.info('kept');
    expect(pipeline.calls, ['submit:LogCapture']);
  });

  test("a failed pipeline start carries the pipeline's error", () async {
    final corrupt = const FormatException('stored session');
    pipeline
      ..failStart = true
      ..startError = corrupt;
    await expectLater(
      GroundcoverRum.init(config),
      throwsA(
        isA<GroundcoverInitException>().having(
          (e) => e.cause,
          'cause',
          corrupt,
        ),
      ),
    );
  });

  test('after a failed init, calls warn once, with why', () async {
    final lines = <String>[];
    final sink = RumDiagnostics.instance.sink;
    RumDiagnostics.instance.sink = lines.add;
    addTearDown(() => RumDiagnostics.instance.sink = sink);
    pipeline
      ..failStart = true
      ..startError = StateError('channel down');
    await expectLater(GroundcoverRum.init(config), throwsA(anything));
    GroundcoverRum.logger.info('one');
    GroundcoverRum.sendCustomEvent('two');
    GroundcoverRum.stopNavigationTracking();
    expect(lines, [
      '[groundcover] init() failed (the pipeline failed to start: '
          'Bad state: channel down); the SDK is off until init succeeds '
          '(groundcoverIgnore)',
    ]);

    lines.clear();
    pipeline.failStart = false;
    await GroundcoverRum.init(config);
    GroundcoverRum.logger.info('kept');
    expect(lines, isEmpty);
    expect(pipeline.calls, ['submit:LogCapture']);
  });

  test('stopNavigationTracking before init completes is dropped too', () async {
    final lines = <String>[];
    final sink = RumDiagnostics.instance.sink;
    RumDiagnostics.instance.sink = lines.add;
    addTearDown(() => RumDiagnostics.instance.sink = sink);
    pipeline.startGate = Completer();
    final starting = GroundcoverRum.init(config);
    GroundcoverRum.stopNavigationTracking();
    expect(lines, [
      "[groundcover] stopNavigationTracking: init() hasn't finished; await it "
          'before using the SDK (groundcoverIgnore)',
    ]);
    pipeline.startGate!.complete();
    await starting;
    RumRuntime.instance.navigate(const ScreenCapture('Home', 'k'));
    expect(pipeline.calls, ['submit:ScreenCapture']);
  });

  test('an init whose start throws says what it threw', () async {
    final channelDown = StateError('channel down');
    RumRuntime.instance.debugReset(
      pipeline: () => pipeline,
      platform: (_) async => throw channelDown,
    );
    await expectLater(
      GroundcoverRum.init(config),
      throwsA(
        isA<GroundcoverInitException>().having(
          (e) => e.cause,
          'cause',
          channelDown,
        ),
      ),
    );
    expect(RumRuntime.instance.pipeline, isNull);
  });

  test('a reset while init is starting ends that start', () async {
    final print = debugPrint;
    addTearDown(() => debugPrint = print);
    final first = pipeline..startGate = Completer();
    final starting = GroundcoverRum.init(config);
    // Into the pipeline's own start, which waits on the gate.
    while (first.config == null) {
      await Future<void>.delayed(Duration.zero);
    }
    final second = RecordingPipeline();
    RumRuntime.instance.debugReset(
      pipeline: () => second,
      platform: (_) async => FakePlatform(),
    );
    first.startGate!.complete();
    await starting;
    // The stale start stopped its own pipeline and armed nothing.
    expect(first.calls, ['stop']);
    expect(debugPrint, print);
    expect(RumRuntime.instance.pipeline, isNull);

    await GroundcoverRum.init(config);
    expect(RumRuntime.instance.pipeline, same(second));
  });

  test('setSessionId completes when the pipeline throws at once', () async {
    pipeline.throwOnSetSessionId = StateError('channel down');
    await GroundcoverRum.init(config);
    await GroundcoverRum.setSessionId('x'); // completes rather than hanging
  });

  test('a path-only propagationUrls pattern warns, as in RN', () async {
    final lines = <String>[];
    final sink = RumDiagnostics.instance.sink;
    RumDiagnostics.instance.sink = lines.add;
    addTearDown(() => RumDiagnostics.instance.sink = sink);
    await GroundcoverRum.init(
      const GroundcoverConfig(
        apiKey: 'k',
        dsn: 'd',
        cluster: 'c',
        environment: 'e',
        appId: 'app',
        options: GroundcoverOptions(
          tracing: TracingOptions(propagationUrls: ['/api/*']),
        ),
      ),
    );
    expect(lines.single, contains('path-only pattern such as "/api/*"'));
  });

  group('an app zone that forwards print to the logger', () {
    // The SDK's diagnostics go to print. An app capturing print (which the
    // SDK doesn't) by forwarding it to GroundcoverRum.logger would feed each
    // diagnostic back in, and that call prints another: without a guard,
    // thousands of frames until the stack overflows, or, with debug on, a
    // single call that never returns.
    final forwarded = <String>[];
    R forwarding<R>(R Function() body) => runZoned(
      body,
      zoneSpecification: ZoneSpecification(
        print: (self, parent, zone, line) {
          forwarded.add(line);
          GroundcoverRum.logger.info(line);
        },
      ),
    );

    setUp(forwarded.clear);

    test('before init, each call prints its warning once', () {
      forwarding(() => GroundcoverRum.logger.info('early'));
      expect(forwarded, hasLength(1));
      expect(forwarded.single, contains('not initialized'));
    });

    test(
      'after init with debug on, a call returns, and only it is captured',
      () async {
        final platform = FakePlatform();
        RumRuntime.instance.debugReset(
          pipeline: DartRumPipeline.new,
          platform: (_) async => platform,
        );
        await GroundcoverRum.init(
          const GroundcoverConfig(
            apiKey: 'k',
            dsn: 'd',
            cluster: 'c',
            environment: 'e',
            appId: 'app',
            options: GroundcoverOptions(debug: true),
          ),
        );
        RumRuntime.instance.pipeline!.presence();
        await forwarding(() async {
          GroundcoverRum.logger.info('one line');
          RumRuntime.instance.pipeline!.flush();
          await drain();
        });
        final logs = [
          for (final request in platform.requests)
            for (final event in request.events)
              if (event['type'] == 'log') event,
        ];
        expect(logs, hasLength(1));
        expect(forwarded.length, lessThan(50));
      },
      timeout: const Timeout(Duration(seconds: 20)),
    );
  });

  group('a hook that calls the SDK', () {
    // Each hook calls back into the SDK, which would run the hook again, and
    // so on until the stack overflows: thousands of events and seconds of
    // blocked UI for one log line. The SDK drops calls made from a hook.
    final hooks = <String, GroundcoverOptions Function(void Function())>{
      'beforeSend': (onCall) => GroundcoverOptions(
        beforeSend: (event) {
          onCall();
          GroundcoverRum.logger.info('saw ${event.type}');
          return true;
        },
      ),
      'enrichEvent': (onCall) => GroundcoverOptions(
        enrichEvent: (event) {
          onCall();
          GroundcoverRum.sendCustomEvent('enriched');
          return event;
        },
      ),
      'redact': (onCall) => GroundcoverOptions(
        privacy: PrivacyOptions(
          redact: (field) {
            onCall();
            GroundcoverRum.logger.info('redacting');
            return null;
          },
        ),
      ),
    };
    for (final MapEntry(key: name, value: options) in hooks.entries) {
      test('$name runs once, and its call is dropped', () async {
        final platform = FakePlatform();
        RumRuntime.instance.debugReset(
          pipeline: DartRumPipeline.new,
          platform: (_) async => platform,
        );
        var calls = 0;
        await GroundcoverRum.init(
          GroundcoverConfig(
            apiKey: 'k',
            dsn: 'd',
            cluster: 'c',
            environment: 'e',
            appId: 'app',
            options: options(() => calls++),
          ),
        );
        RumRuntime.instance.pipeline!.presence();
        GroundcoverRum.logger.info('one line');
        RumRuntime.instance.pipeline!.flush();
        await drain();
        expect(calls, 1);
        expect([
          for (final request in platform.requests) ...request.events,
        ], hasLength(1));
      });
    }
  });

  test('calls before init is called are ignored, with a warning', () async {
    final lines = <String>[];
    final sink = RumDiagnostics.instance.sink;
    RumDiagnostics.instance.sink = lines.add;
    addTearDown(() => RumDiagnostics.instance.sink = sink);
    GroundcoverRum.logger.info('nobody listening');
    await GroundcoverRum.setSessionId('x');
    expect(GroundcoverRum.getSessionId(), '');
    GroundcoverRum.stopNavigationTracking();
    // As RN's warnNotInitialized: whatever debug says, never captured.
    expect(lines, [
      for (final name in [
        'logger.info',
        'setSessionId',
        'getSessionId',
        'stopNavigationTracking',
      ])
        '[groundcover] $name: not initialized, call init() first '
            '(groundcoverIgnore)',
    ]);
    await GroundcoverRum.init(config);
    expect(pipeline.calls, isEmpty);
  });

  test('once init has completed, the session id is the pipeline\'s', () async {
    await GroundcoverRum.init(config);
    await GroundcoverRum.setSessionId('fixed');
    expect(pipeline.calls, ['setSessionId:fixed']);
    expect(GroundcoverRum.getSessionId(), 'sid');
  });

  test('the API maps each call onto its capture', () async {
    await GroundcoverRum.init(config);
    GroundcoverRum.logger.warn('w', {'a': 1});
    GroundcoverRum.sendCustomEvent('c', {'b': 2});
    GroundcoverRum.captureException(StateError('boom'), metadata: {'m': 3});
    final [log, custom, error] = pipeline.captures;
    expect((log as LogCapture).level, LogLevel.warn);
    expect(log.attributes, {'a': 1});
    expect((custom as CustomEventCapture).attributes, {'b': 2});
    expect((error as ErrorCapture).type, 'StateError');
    expect(error.handled, isTrue);
    expect(error.metadata, {'m': 3});
  });

  testWidgetsWithRum('a pointer down in GroundcoverWidget is presence', (
    tester,
  ) async {
    await tester.runAsync(() => GroundcoverRum.init(config));
    await tester.pumpWidget(
      const GroundcoverWidget(
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: SizedBox.expand(),
        ),
      ),
    );
    await tester.tapAt(const Offset(10, 10));
    expect(pipeline.calls, contains('presence'));
  });

  /// A lifecycle message as the embedder sends it, through the framework's
  /// own handler, which fills in the states between.
  Future<void> platformSends(
    WidgetTester tester,
    AppLifecycleState state,
  ) async {
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      SystemChannels.lifecycle.name,
      const StringCodec().encodeMessage(state.toString()),
      (_) {},
    );
    await tester.pump();
  }

  /// Init finishing while the lifecycle is [seed]: the embedder's, or the
  /// last message before init finished.
  Future<void> initWhile(WidgetTester tester, AppLifecycleState seed) async {
    tester.binding.handleAppLifecycleStateChanged(seed);
    await tester.runAsync(() => GroundcoverRum.init(config));
  }

  group('the launch is no return to the foreground', () {
    // RN's startup 'unknown' -> 'active' is never presence. On a device,
    // Flutter's embedders seed the lifecycle as detached, and iOS passes
    // inactive on its way to the first resumed. Read as a return, the launch
    // would confirm a session nobody touched.

    testWidgetsWithRum('iOS: detached, then inactive and resumed', (
      tester,
    ) async {
      await initWhile(tester, AppLifecycleState.detached);
      await platformSends(tester, AppLifecycleState.inactive);
      await platformSends(tester, AppLifecycleState.resumed);
      expect(pipeline.calls, isNot(contains('lifecycle:foreground')));
    });

    testWidgetsWithRum('Android: detached, then resumed', (tester) async {
      await initWhile(tester, AppLifecycleState.detached);
      await platformSends(tester, AppLifecycleState.resumed);
      expect(pipeline.calls, isNot(contains('lifecycle:foreground')));
    });

    testWidgetsWithRum("iOS: init finishing between inactive and resumed", (
      tester,
    ) async {
      await initWhile(tester, AppLifecycleState.inactive);
      await platformSends(tester, AppLifecycleState.resumed);
      expect(pipeline.calls, isNot(contains('lifecycle:foreground')));
    });

    testWidgetsWithRum('a real departure and return after it still count', (
      tester,
    ) async {
      await initWhile(tester, AppLifecycleState.detached);
      await platformSends(tester, AppLifecycleState.resumed);
      pipeline.calls.clear();
      await platformSends(tester, AppLifecycleState.inactive);
      await platformSends(tester, AppLifecycleState.paused);
      await platformSends(tester, AppLifecycleState.resumed);
      expect(pipeline.calls, [
        'lifecycle:inactive',
        'lifecycle:background',
        'lifecycle:inactive',
        'lifecycle:foreground',
      ]);
    });

    testWidgetsWithRum('an overlay after the launch is a return', (
      tester,
    ) async {
      // Control Center, a permission prompt: inactive, then resumed, as
      // RN's inactive -> active is.
      await initWhile(tester, AppLifecycleState.detached);
      await platformSends(tester, AppLifecycleState.inactive);
      await platformSends(tester, AppLifecycleState.resumed);
      pipeline.calls.clear();
      await platformSends(tester, AppLifecycleState.inactive);
      await platformSends(tester, AppLifecycleState.resumed);
      expect(pipeline.calls, ['lifecycle:inactive', 'lifecycle:foreground']);
    });

    testWidgetsWithRum('with init finishing while shown, an overlay too', (
      tester,
    ) async {
      await initWhile(tester, AppLifecycleState.resumed);
      await platformSends(tester, AppLifecycleState.inactive);
      await platformSends(tester, AppLifecycleState.resumed);
      expect(pipeline.calls, ['lifecycle:inactive', 'lifecycle:foreground']);
    });

    testWidgetsWithRum('an app started hidden returns when it is shown', (
      tester,
    ) async {
      await initWhile(tester, AppLifecycleState.hidden);
      await platformSends(tester, AppLifecycleState.resumed);
      // No background on the way up: it was already away.
      expect(pipeline.calls, ['lifecycle:inactive', 'lifecycle:foreground']);
    });
  });

  // Frame vitals around the lifecycle: what the tracker is told, through the
  // frame timings the engine reports.
  group('frame vitals', () {
    /// One frame the engine reports, drawn at [vsyncUs] on its frame clock.
    void reportFrame(WidgetTester tester, int vsyncUs) =>
        tester.binding.platformDispatcher.onReportTimings!([
          FrameTiming(
            vsyncStart: vsyncUs,
            buildStart: vsyncUs,
            buildFinish: vsyncUs + 2000,
            rasterStart: vsyncUs + 2000,
            rasterFinish: vsyncUs + 4000,
            rasterFinishWallTime: vsyncUs + 4000,
          ),
        ]);

    List<FrameSegmentCapture> segments() =>
        pipeline.captures.whereType<FrameSegmentCapture>().toList();

    testWidgetsWithRum('an overlay keeps the frames drawn so far: only a '
        'return from the background starts the segment afresh', (tester) async {
      // A permission prompt, Control Center: the screen stays on display.
      await initWhile(tester, AppLifecycleState.resumed);
      reportFrame(tester, 1000);
      await platformSends(tester, AppLifecycleState.inactive);
      await platformSends(tester, AppLifecycleState.resumed);
      await platformSends(tester, AppLifecycleState.paused);
      expect(segments().single.total, 1);
    });

    testWidgetsWithRum('a return from the background starts afresh', (
      tester,
    ) async {
      await initWhile(tester, AppLifecycleState.resumed);
      reportFrame(tester, 1000);
      await platformSends(tester, AppLifecycleState.paused);
      expect(segments().single.reason, FrameSegmentReason.background);
      await platformSends(tester, AppLifecycleState.resumed);
      await platformSends(tester, AppLifecycleState.paused);
      // Nothing drawn since the return: nothing to report.
      expect(segments(), hasLength(1));
    });
  });

  testWidgetsWithRum('the app lifecycle reaches the pipeline', (tester) async {
    await tester.runAsync(() => GroundcoverRum.init(config));
    final binding = tester.binding;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    // One background per departure, as RN's AppState gives: Flutter passes
    // hidden and paused on the way back too, and that is no departure.
    expect(pipeline.calls, [
      'lifecycle:inactive',
      'lifecycle:background',
      'lifecycle:inactive',
      'lifecycle:foreground',
    ]);
  });
}
