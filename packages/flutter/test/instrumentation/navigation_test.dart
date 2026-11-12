// Navigation: the observer over a real Navigator, and the events the
// pipeline builds from what it reports (ported from the RN SDK's
// navigation-tracker tests).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';

import '../support/fake_platform.dart';
import '../support/recording_pipeline.dart';
import '../support/rum_widgets.dart';

const config = GroundcoverConfig(
  apiKey: 'k',
  dsn: 'd',
  cluster: 'c',
  environment: 'e',
  appId: 'a',
  options: GroundcoverOptions(
    transport: TransportOptions(batchSize: 0, compression: false),
  ),
);

Widget app() => MaterialApp(
  navigatorObservers: [GroundcoverNavigatorObserver()],
  initialRoute: 'Home',
  onGenerateRoute: (settings) => MaterialPageRoute<void>(
    settings: settings,
    builder: (context) => Column(
      children: [
        Text('screen ${settings.name}'),
        TextButton(
          onPressed: () => Navigator.of(context).pushNamed('Detail'),
          child: const Text('push'),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('pop'),
        ),
        TextButton(
          onPressed: () => Navigator.of(
            context,
          ).pushNamedAndRemoveUntil('Logs', (_) => false),
          child: const Text('switch'),
        ),
        TextButton(
          onPressed: () =>
              Navigator.of(context).pushReplacementNamed('Settings'),
          child: const Text('replace'),
        ),
        TextButton(
          onPressed: () =>
              Navigator.of(context).removeRoute(ModalRoute.of(context)!),
          child: const Text('remove'),
        ),
        TextButton(
          onPressed: () => showDialog<void>(
            context: context,
            builder: (_) => const Text('dialog'),
          ),
          child: const Text('dialog'),
        ),
      ],
    ),
  ),
);

void main() {
  group('GroundcoverNavigatorObserver', () {
    late RecordingPipeline pipeline;
    setUp(() {
      pipeline = RecordingPipeline();
      RumRuntime.instance.debugReset(
        pipeline: () => pipeline,
        platform: (_) async => FakePlatform(),
      );
    });
    tearDown(() => RumRuntime.instance.debugReset());

    List<String> screens() => [
      for (final c in pipeline.captures.whereType<ScreenCapture>()) c.name,
    ];

    testWidgetsWithRum('reports the route that becomes current', (
      tester,
    ) async {
      // Init is awaited before the app's first route, as the README says.
      await tester.runAsync(() => GroundcoverRum.init(config));
      await tester.pumpWidget(app());
      await tester.tap(find.text('push'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('pop').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('dialog'));
      await tester.pumpAndSettle();
      Navigator.of(tester.element(find.text('dialog').last)).pop();
      await tester.pumpAndSettle();
      await tester.tap(find.text('switch'));
      await tester.pumpAndSettle();
      expect(screens(), ['Home', 'Detail', 'Home', 'Home', 'Logs']);
      final keys = pipeline.captures
          .whereType<ScreenCapture>()
          .map((c) => c.key)
          .toList();
      expect(keys[0], keys[2], reason: 'the same Home route, back again');
      expect(keys[1], isNot(keys[0]));
    });

    testWidgetsWithRum(
      'replacing or removing the current route reports the next; '
      'removing one under it does not',
      (tester) async {
        await tester.runAsync(() => GroundcoverRum.init(config));
        await tester.pumpWidget(app());
        await tester.tap(find.text('push'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('replace').last);
        await tester.pumpAndSettle();
        await tester.tap(find.text('remove').last);
        await tester.pumpAndSettle();
        await tester.tap(find.text('push'));
        await tester.pumpAndSettle();
        final home = ModalRoute.of(
          tester.element(find.text('screen Home', skipOffstage: false)),
        )!;
        home.navigator!.removeRoute(home);
        await tester.pumpAndSettle();
        expect(screens(), ['Home', 'Detail', 'Settings', 'Home', 'Detail']);
      },
    );

    testWidgetsWithRum('stopNavigationTracking stops the observer', (
      tester,
    ) async {
      await tester.runAsync(() => GroundcoverRum.init(config));
      GroundcoverRum.stopNavigationTracking();
      await tester.pumpWidget(app());
      await tester.tap(find.text('push'));
      await tester.pumpAndSettle();
      expect(screens(), isEmpty);
    });
  });

  group('navigation events', () {
    late FakePlatform platform;
    late DartRumPipeline pipeline;

    setUp(() async {
      platform = FakePlatform();
      pipeline = DartRumPipeline();
      await pipeline.start(config, platform);
      pipeline.presence();
    });
    tearDown(() => pipeline.stop());

    // Navigation is a skip-flush type: it rides with the next batch.
    Future<void> sent() async {
      pipeline.flush();
      await drain();
    }

    List<Map<String, Object?>> navigations() => [
      for (final r in platform.requests)
        for (final e in r.events)
          if (e['type'] == 'navigation')
            e['attributes']! as Map<String, Object?>,
    ];

    test('carry the screen left, its key and how long it was shown', () async {
      pipeline.submit(const ScreenCapture('Network', 'Network-1'));
      platform.nowMs += 1500;
      pipeline.submit(const ScreenCapture('Logs', 'Logs-2'));
      await sent();
      final [first, second] = navigations();
      expect(first.containsKey('from_screen'), isFalse);
      expect(first['duration_ms'], 0);
      expect(second['from_screen'], 'Network');
      expect(second['from_key'], 'Network-1');
      expect(second['duration_ms'], 1500);
      expect(second['screen'], {'name': 'Logs', 'key': 'Logs-2'});
      expect(
        (second['end_timestamp']! as int) - (second['start_timestamp']! as int),
        1500 * 1000000,
      );
    });

    test('the same screen twice is one navigation', () async {
      pipeline
        ..submit(const ScreenCapture('Home', 'Home-1'))
        ..submit(const ScreenCapture('Home', 'Home-1'));
      await sent();
      expect(navigations(), hasLength(1));
    });

    test('every later event carries the current screen', () async {
      pipeline
        ..submit(const ScreenCapture('Home', 'Home-1'))
        ..submit(const CustomEventCapture('x', {}));
      await sent();
      final custom = platform.requests.last.events.last;
      expect((custom['attributes']! as Map)['screen'], {
        'name': 'Home',
        'key': 'Home-1',
      });
    });

    test(
      'a manual navigation reports its name, key, metadata and duration',
      () async {
        pipeline.submit(
          const NavigationStartCapture('ManualScreen', key: 'manual-1'),
        );
        platform.nowMs += 250;
        pipeline.submit(const NavigationEndCapture({'e2e_manual': 'end'}));
        await sent();
        final nav = navigations().single;
        expect(nav['screen'], {'name': 'ManualScreen', 'key': 'manual-1'});
        expect(nav['duration_ms'], 250);
        expect(nav['metadata.e2e_manual'], 'end');
      },
    );

    test('a manual navigation with no name is dropped', () async {
      pipeline
        ..submit(
          const NavigationStartCapture(
            '',
            metadata: {'e2e_manual': 'nameless'},
          ),
        )
        ..submit(const NavigationEndCapture());
      await sent();
      expect(navigations(), isEmpty);
    });

    test(
      'a manual navigation leaves the automatic from_screen alone',
      () async {
        pipeline
          ..submit(const ScreenCapture('Config', 'Config-1'))
          ..submit(const NavigationStartCapture('ManualScreen'))
          ..submit(const NavigationEndCapture())
          ..submit(const ScreenCapture('Logs', 'Logs-2'));
        await sent();
        expect(navigations().last['from_screen'], 'Config');
      },
    );
  });
}
