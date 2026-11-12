// Uncaught errors, handled ones and debugPrint lines: the shaping and stack
// parsing every error source shares, the two global hooks chaining whatever
// was installed before them, and the debugPrint wrapper.

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/src/core/common/patch.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/instrumentation/errors.dart';
import 'package:groundcover_rum/src/instrumentation/logs.dart';

import '../support/fake_platform.dart';
import '../support/recording_pipeline.dart';

const readableTrace = '''
#0      CheckoutScreen._pay (package:shop/checkout.dart:52:7)
#1      CheckoutScreen.build.<anonymous closure> (package:shop/checkout.dart:31:34)
#2      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1176:21)
#3      <asynchronous suspension>
#4      main (file:///app/lib/main.dart:9)
''';

const obfuscatedTrace = '''
*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
pid: 4211, tid: 4240, name 1.ui
os: android arch: arm64 comp: yes sim: no
build_id: '61f1b8d2c0a4e7b9'
isolate_dso_base: 7a3c1e2000, vm_dso_base: 7a3c1e2000
isolate_instructions: 7a3c2d4000, vm_instructions: 7a3c2c8000
    #00 abs 000000706e44fc27 virt 00000000001efc27 _kDartIsolateSnapshotInstructions+0x1e9e07
    #01 abs 000000706e44fb10 _kDartIsolateSnapshotInstructions+0x1e9cf0
''';

const config = GroundcoverConfig(
  apiKey: 'k',
  dsn: 'd',
  cluster: 'c',
  environment: 'e',
  appId: 'app',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('parseStackTrace', () {
    test('a readable trace gives function, file, line and column', () {
      final frames = parseStackTrace(StackTrace.fromString(readableTrace));
      expect(frames.map((f) => f.toJson()).toList(), [
        {
          'filename': 'package:shop/checkout.dart',
          'function': 'CheckoutScreen._pay',
          'lineno': 52,
          'colno': 7,
        },
        {
          'filename': 'package:shop/checkout.dart',
          'function': 'CheckoutScreen.build.<anonymous closure>',
          'lineno': 31,
          'colno': 34,
        },
        {
          'filename': 'package:flutter/src/material/ink_well.dart',
          'function': '_InkResponseState.handleTap',
          'lineno': 1176,
          'colno': 21,
        },
        // The suspension marker is no frame; a frame without a column is.
        {
          'filename': 'file:///app/lib/main.dart',
          'function': 'main',
          'lineno': 9,
          'colno': 0,
        },
      ]);
    });

    test('an obfuscated trace keeps raw addresses under its build id', () {
      final frames = parseStackTrace(StackTrace.fromString(obfuscatedTrace));
      expect(frames.map((f) => f.toJson()).toList(), [
        {
          'filename': 'build_id:61f1b8d2c0a4e7b9',
          'function':
              'abs 000000706e44fc27 virt 00000000001efc27 '
              '_kDartIsolateSnapshotInstructions+0x1e9e07',
          'lineno': 0,
          'colno': 0,
        },
        {
          'filename': 'build_id:61f1b8d2c0a4e7b9',
          'function':
              'abs 000000706e44fb10 _kDartIsolateSnapshotInstructions+0x1e9cf0',
          'lineno': 0,
          'colno': 0,
        },
      ]);
    });

    test('a live trace parses, innermost frame first', () {
      final frames = parseStackTrace(StackTrace.current);
      expect(frames, isNotEmpty);
      expect(frames.first.filename, endsWith('errors_logs_test.dart'));
      expect(frames.first.lineno, greaterThan(0));
    });

    test('no trace, or none parseable, gives no frames', () {
      expect(parseStackTrace(null), isEmpty);
      expect(parseStackTrace(StackTrace.fromString('garbage')), isEmpty);
    });
  });

  test('messages drop the prefix toString adds', () {
    expect(errorMessage(StateError('closed')), 'closed');
    expect(errorMessage(Exception('boom')), 'boom');
    expect(errorMessage(const FormatException('bad digit')), 'bad digit');
    expect(errorMessage(UnsupportedError('nope')), 'nope');
    expect(errorMessage(ArgumentError('too big')), 'too big');
    expect(errorMessage(FlutterError('overflowed')), 'overflowed');
    expect(errorMessage('thrown string'), 'thrown string');
    expect(errorMessage(_Custom()), 'custom says hi');
  });

  test("errorCapture falls back to an Error's own trace", () {
    late StateError error;
    try {
      throw StateError('closed');
    } on StateError catch (e) {
      error = e;
    }
    final capture = errorCapture(error, null, handled: false);
    expect(capture.type, 'StateError');
    expect(capture.message, 'closed');
    expect(capture.frames, isNotEmpty);
    expect(capture.handled, isFalse);
  });

  group('installErrorHooks', () {
    late List<ErrorCapture> captured;
    late PatchSet hooks;
    void install() => installErrorHooks(hooks, captured.add);

    setUp(() {
      captured = [];
      final flutter = FlutterError.onError;
      final platform = PlatformDispatcher.instance.onError;
      addTearDown(() {
        FlutterError.onError = flutter;
        PlatformDispatcher.instance.onError = platform;
      });
      hooks = PatchSet();
    });

    test(
      'a framework error is reported, then handed to the previous handler',
      () {
        final seen = <FlutterErrorDetails>[];
        FlutterError.onError = seen.add;
        install();
        final details = FlutterErrorDetails(
          exception: StateError('layout'),
          stack: StackTrace.fromString(readableTrace),
        );
        FlutterError.onError!(details);
        expect(seen, [details]);
        expect(captured.single.type, 'StateError');
        expect(captured.single.message, 'layout');
        expect(captured.single.frames, hasLength(4));
        expect(captured.single.handled, isFalse);
      },
    );

    test('a silent framework error is passed on, not reported', () {
      final seen = <FlutterErrorDetails>[];
      FlutterError.onError = seen.add;
      install();
      FlutterError.onError!(
        FlutterErrorDetails(exception: StateError('noise'), silent: true),
      );
      expect(seen, hasLength(1));
      expect(captured, isEmpty);
    });

    test("an async error returns the previous handler's verdict", () {
      PlatformDispatcher.instance.onError = (error, stack) => true;
      install();
      final handled = PlatformDispatcher.instance.onError!(
        Exception('async'),
        StackTrace.fromString(readableTrace),
      );
      expect(handled, isTrue);
      expect(captured.single.message, 'async');
    });

    test('with no previous handler, an async error stays unhandled', () {
      PlatformDispatcher.instance.onError = null;
      install();
      expect(
        PlatformDispatcher.instance.onError!(Exception('x'), StackTrace.empty),
        isFalse,
      );
    });

    test('a failing report never stops the previous handler', () {
      final seen = <FlutterErrorDetails>[];
      FlutterError.onError = seen.add;
      installErrorHooks(PatchSet(), (_) => throw StateError('pipeline down'));
      FlutterError.onError!(FlutterErrorDetails(exception: StateError('x')));
      expect(seen, hasLength(1));
    });

    test('restore puts the previous handler back, never one set later', () {
      void previous(FlutterErrorDetails _) {}
      FlutterError.onError = previous;
      install();
      hooks.restore();
      expect(FlutterError.onError, previous);

      install();
      void later(FlutterErrorDetails _) {}
      FlutterError.onError = later;
      hooks.restore();
      expect(FlutterError.onError, later);
    });
  });

  group('installDebugPrintCapture', () {
    late List<LogCapture> captured;
    late List<String?> printed;
    late PatchSet capture;

    setUp(() {
      captured = [];
      printed = [];
      final original = debugPrint;
      addTearDown(() => debugPrint = original);
      debugPrint = (message, {wrapWidth}) => printed.add(message);
      capture = PatchSet();
      installDebugPrintCapture(capture, captured.add);
    });

    test('every line still prints, and is sent as a log', () {
      debugPrint('cart loaded');
      expect(printed, ['cart loaded']);
      expect(captured.single.message, 'cart loaded');
      expect(captured.single.level, LogLevel.log);
    });

    test('empty lines and the ignore marker print but are not sent', () {
      debugPrint(null);
      debugPrint('');
      debugPrint('[groundcoverIgnore] internal');
      expect(printed, hasLength(3));
      expect(captured, isEmpty);
    });

    test("what the app's hooks print is printed, never sent", () async {
      capture.restore();
      final platform = FakePlatform();
      final pipeline = DartRumPipeline();
      addTearDown(pipeline.stop);
      await pipeline.start(
        GroundcoverConfig(
          apiKey: 'k',
          dsn: 'ingest.example',
          cluster: 'c',
          environment: 'e',
          appId: 'a',
          options: GroundcoverOptions(
            transport: const TransportOptions(batchSize: 0, compression: false),
            beforeSend: (event) {
              debugPrint('beforeSend saw ${event.type}');
              return true;
            },
            enrichEvent: (event) {
              debugPrint('enrichEvent saw ${event.type}');
              return event;
            },
          ),
        ),
        platform,
      );
      installDebugPrintCapture(PatchSet(), pipeline.submit);
      pipeline.presence();
      debugPrint('cart loaded');
      pipeline.submit(const CustomEventCapture('checkout', {}));
      await pumpEventQueue();
      final events = [for (final r in platform.requests) ...r.events];
      expect(events.map((e) => e['type']), ['log', 'custom']);
      expect(printed, [
        'cart loaded',
        'beforeSend saw log',
        'enrichEvent saw log',
        'beforeSend saw custom',
        'enrichEvent saw custom',
      ]);
    });

    test('uninstall restores the previous debugPrint', () {
      capture.restore();
      debugPrint('after');
      expect(printed, ['after']);
      expect(captured, isEmpty);
    });
  });

  group('through the runtime', () {
    late RecordingPipeline pipeline;

    setUp(() {
      pipeline = RecordingPipeline();
      RumRuntime.instance.debugReset(
        pipeline: () => pipeline,
        platform: (_) async => FakePlatform(),
      );
      addTearDown(RumRuntime.instance.debugReset);
    });

    test('captureException sends a handled error with frames', () async {
      await GroundcoverRum.init(config);
      GroundcoverRum.captureException(
        StateError('closed'),
        metadata: {'cart': 3},
      );
      final error = pipeline.captures.whereType<ErrorCapture>().single;
      expect(error.type, 'StateError');
      expect(error.message, 'closed');
      expect(error.handled, isTrue);
      expect(error.metadata, {'cart': 3});
      expect(error.frames.first.filename, endsWith('errors_logs_test.dart'));
    });

    test('an error with no trace of its own is placed at its caller', () async {
      await GroundcoverRum.init(config);
      // A thrown string carries no stack trace.
      GroundcoverRum.captureException('early');
      final error = pipeline.captures.whereType<ErrorCapture>().single;
      expect(error.frames.first.filename, endsWith('errors_logs_test.dart'));
    });

    test('what a framework error prints is not sent again as a log', () async {
      final flutter = FlutterError.onError;
      final print = debugPrint;
      final printed = <String?>[];
      addTearDown(() {
        FlutterError.onError = flutter;
        debugPrint = print;
      });
      debugPrint = (message, {wrapWidth}) => printed.add(message);
      // What the default presenter, or an app's own handler, does with it.
      FlutterError.onError = (details) => debugPrint('${details.exception}');
      await GroundcoverRum.init(config);
      FlutterError.onError!(FlutterErrorDetails(exception: StateError('x')));
      expect(printed, ['Bad state: x']);
      expect(pipeline.calls, ['submit:ErrorCapture']);
    });

    test('an app that silenced framework errors keeps them silent', () async {
      final flutter = FlutterError.onError;
      final present = FlutterError.presentError;
      final presented = <FlutterErrorDetails>[];
      addTearDown(() {
        FlutterError.onError = flutter;
        FlutterError.presentError = present;
      });
      FlutterError.presentError = presented.add;
      FlutterError.onError = null;
      await GroundcoverRum.init(config);
      FlutterError.onError!(FlutterErrorDetails(exception: StateError('x')));
      expect(pipeline.calls, ['submit:ErrorCapture']);
      expect(presented, isEmpty);
    });

    test('init hooks uncaught errors and debugPrint; reset unhooks', () async {
      final flutter = FlutterError.onError;
      final platform = PlatformDispatcher.instance.onError;
      final print = debugPrint;
      addTearDown(() {
        FlutterError.onError = flutter;
        PlatformDispatcher.instance.onError = platform;
        debugPrint = print;
      });
      FlutterError.onError = (_) {};
      await GroundcoverRum.init(config);
      FlutterError.onError!(FlutterErrorDetails(exception: StateError('x')));
      debugPrint('hello');
      expect(pipeline.calls, ['submit:ErrorCapture', 'submit:LogCapture']);

      RumRuntime.instance.debugReset();
      expect(debugPrint, print);
    });

    test('enabledEvents leaves out what it does not list', () async {
      final flutter = FlutterError.onError;
      final print = debugPrint;
      addTearDown(() {
        FlutterError.onError = flutter;
        debugPrint = print;
      });
      void appHandler(FlutterErrorDetails _) {}
      FlutterError.onError = appHandler;
      await GroundcoverRum.init(
        const GroundcoverConfig(
          apiKey: 'k',
          dsn: 'd',
          cluster: 'c',
          environment: 'e',
          appId: 'app',
          options: GroundcoverOptions(enabledEvents: [RumEventName.logs]),
        ),
      );
      expect(debugPrint, isNot(print));
      expect(FlutterError.onError, appHandler);
    });
  });
}

final class _Custom {
  @override
  String toString() => 'custom says hi';
}
