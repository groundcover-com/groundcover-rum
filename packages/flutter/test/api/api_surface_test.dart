import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/testing.dart';

import '../support/fake_platform.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) => const SizedBox();
}

void main() {
  setUp(
    () => RumRuntime.instance.debugReset(platform: (_) async => FakePlatform()),
  );
  tearDown(() => RumRuntime.instance.debugReset());

  // The quick start from the README and the library doc, as code that has to
  // compile and run: init awaited, and caught, before the app runs.
  testWidgets('the quick start compiles and runs', (tester) async {
    try {
      await tester.runAsync(
        () => GroundcoverRum.init(
          GroundcoverConfig(
            apiKey: 'your-rum-ingestion-key',
            dsn: 'https://example.platform.grcv.io',
            cluster: 'your-cluster',
            environment: 'production',
            appId: 'my-app',
            options: GroundcoverOptions(
              tracing: const TracingOptions(
                propagationUrls: ['https://api.myapp.com/*'],
              ),
              beforeSend: (event) => event.type != 'log',
              enrichEvent: (event) => event..attributes['team'] = 'checkout',
            ),
          ),
        ),
      );
    } on GroundcoverInitException {
      // The app runs unmonitored.
    }
    expect(RumRuntime.instance.pipeline, isNotNull);
    await tester.pumpWidget(
      GroundcoverWidget(
        child: WidgetsApp(
          color: const Color(0xFF000000),
          navigatorObservers: [GroundcoverNavigatorObserver()],
          onGenerateRoute: (settings) => PageRouteBuilder<void>(
            settings: settings,
            pageBuilder: (context, animation, secondary) =>
                const GroundcoverPrivate(child: MyApp()),
          ),
        ),
      ),
    );
    expect(find.byType(MyApp), findsOneWidget);
    // Stops the pipeline's batch timer before the test's pending-timer check.
    RumRuntime.instance.debugReset();
  });

  test('every call is safe before init', () async {
    GroundcoverRum.identifyUser(const RumUser(id: 'u_123'));
    GroundcoverRum.updateConfig(const GroundcoverConfigUpdate(clearUser: true));
    GroundcoverRum.sendCustomEvent('plan_upgraded', {'plan': 'pro'});
    GroundcoverRum.captureException(
      StateError('boom'),
      stackTrace: StackTrace.current,
      metadata: {'feature': 'checkout'},
    );
    GroundcoverRum.logger.warn('Payment retry', {'attempt': 2});
    GroundcoverRum.startNavigation('Checkout', key: 'checkout-1');
    GroundcoverRum.endNavigation();
    GroundcoverRum.stopNavigationTracking();
    GroundcoverRum.markAppInteractive();
    await GroundcoverRum.setSessionId('fixed');
    await GroundcoverRumTesting.backdateLastActivity(
      const Duration(minutes: 31),
    );
    await GroundcoverRumTesting.backdateSessionStart(const Duration(hours: 5));
    await GroundcoverRumTesting.forgetSession();
    expect(GroundcoverRum.getSessionId(), '');
  });

  test(
    'native options take RN\'s shapes: one threshold or one per platform',
    () {
      const both = GroundcoverOptions(
        native: NativeOptions(
          hangThreshold: HangThreshold(Duration(seconds: 1)),
          vitalsMaxSegment: Duration(seconds: 30),
          tti: TtiMode.manual,
        ),
      );
      expect(both.native!.hangThreshold!.ios, const Duration(seconds: 1));
      expect(both.native!.hangThreshold!.android, const Duration(seconds: 1));

      // A platform left out keeps its own default rather than borrowing the
      // other's value.
      const iosOnly = HangThreshold.perPlatform(ios: Duration(seconds: 3));
      expect(iosOnly.ios, const Duration(seconds: 3));
      expect(iosOnly.android, isNull);
    },
  );

  test(
    'privacy levels and redact kinds carry the names the other SDKs use',
    () {
      expect(PrivacyLevel.values.map((l) => l.wireName), [
        'mask-sensitive',
        'mask-all',
        'allow',
      ]);
      expect(RedactKind.values.map((k) => k.wireName), [
        'request-body',
        'response-body',
        'query',
        'header',
        'log',
        'error',
      ]);
    },
  );
}
