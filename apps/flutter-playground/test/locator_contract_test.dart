import 'package:flutter/services.dart';
import 'package:flutter_playground/app.dart';
import 'package:flutter_test/flutter_test.dart';

// The shared Mobilewright suite (tests/e2e/mobile) finds controls by these
// labels, as the semantics tree reports them, so a rename here breaks e2e on a
// device. This pins the contract without one. Each list is what the specs
// locate on that screen, by getByLabel or getByText; add to it whenever a spec
// starts locating something new.

/// Strings the specs locate on each tab's screen.
const _byTab = {
  'Taps': [
    'Taps',
    'Increment counter',
    'Bare button (no testID/label)',
    'Private action',
    'Go to Detail screen',
    'A11y annotated button',
  ],
  'Network': [
    'Network',
    'fetch GET',
    'fetch POST',
    'dart:io GET',
    'dio GET',
    'abort in-flight',
    'large response',
    'failing request',
    'sensitive request',
  ],
  'Logs': [
    'Logs',
    'debugPrint',
    'logger.info',
    'captureException',
    'throw uncaught',
    'log sensitive',
    'capture sensitive error',
  ],
  'Custom': ['sendCustomEvent', 'identifyUser', 'show session id'],
  'Native': [
    'Crash natively',
    'Block main thread',
    'Block Dart thread',
    'Open modal',
    'Row 3',
  ],
  'Config': [
    'preset: default',
    'Session: —',
    'Last action: —',
    'tap DROPME (beforeSend drops this)',
    'tap survivor (beforeSend keeps this)',
    'show session id',
    'setSessionId fixed',
    'clear identity',
    'manual navigation',
    'manual navigation unnamed',
    'markAppInteractive',
    'stopNavigationTracking',
    'backdate activity 31m',
    'backdate session start 5h',
    'forget session',
  ],
};

Future<void> _openTab(WidgetTester tester, String tab) async {
  await tester.tap(find.bySemanticsLabel('$tab tab'));
  await tester.pumpAndSettle();
}

Finder _label(String label) => find.bySemanticsLabel(label);

void main() {
  late SemanticsHandle semantics;

  setUp(() => semantics = TestWidgetsFlutterBinding.instance.ensureSemantics());
  tearDown(() => semantics.dispose());

  Future<void> pumpApp(WidgetTester tester) async {
    // A tall surface, so the lower controls of long screens are built.
    tester.view.physicalSize = const Size(1200, 6000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const PlaygroundApp(preset: 'default'));
    await tester.pumpAndSettle();
  }

  testWidgets('every tab carries the exact label the specs locate', (
    tester,
  ) async {
    await pumpApp(tester);
    for (final tab in _byTab.keys) {
      expect(_label('$tab tab'), findsOneWidget, reason: '$tab tab');
    }
  });

  for (final MapEntry(key: tab, value: labels) in _byTab.entries) {
    testWidgets('the $tab screen exposes what the specs locate', (
      tester,
    ) async {
      await pumpApp(tester);
      await _openTab(tester, tab);
      for (final label in labels) {
        expect(_label(label), findsOneWidget, reason: label);
      }
    });
  }

  testWidgets('Detail is a push on Home, with its title and Back', (
    tester,
  ) async {
    await pumpApp(tester);
    await tester.tap(_label('Go to Detail screen'));
    await tester.pumpAndSettle();
    expect(_label('Detail'), findsOneWidget);
    await tester.tap(_label('Back'));
    await tester.pumpAndSettle();
    expect(_label('Taps'), findsOneWidget);
  });

  testWidgets('the modal opens over Native with its own rows', (tester) async {
    await pumpApp(tester);
    await _openTab(tester, 'Native');
    await tester.tap(_label('Open modal'));
    await tester.pumpAndSettle();
    expect(_label('Modal row 1'), findsOneWidget);
    expect(_label('Modal row 3'), findsOneWidget);
    await tester.tap(_label('Close modal'));
    await tester.pumpAndSettle();
    expect(_label('Row 3'), findsOneWidget);
  });

  testWidgets('Block main thread reaches the native hook and says so', (
    tester,
  ) async {
    // The preflight spec waits for exactly this text, and for no failure. The
    // plugin's channel answers as the native hook does: at once, before the
    // stall it posts to the main thread.
    const channel =
        'dev.flutter.pigeon.groundcover_rum.RumHostApi.blockMainThread';
    final calls = <Object?>[];
    tester.binding.defaultBinaryMessenger.setMockMessageHandler(channel, (
      message,
    ) async {
      calls.add(const StandardMessageCodec().decodeMessage(message));
      return const StandardMessageCodec().encodeMessage(<Object?>[null]);
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMessageHandler(
        channel,
        null,
      ),
    );
    await pumpApp(tester);
    await _openTab(tester, 'Native');
    await tester.tap(_label('Block main thread'));
    await tester.pumpAndSettle();
    expect(find.text('hang: triggered'), findsOneWidget);
    expect(calls, [
      [3000],
    ]);
  });

  testWidgets('the counter keeps its visible text behind the label', (
    tester,
  ) async {
    await pumpApp(tester);
    // The SDK labels the tap from the visible text ("Well-tagged…", which the
    // interactions spec asserts), while the specs locate it by the label.
    expect(find.text('Well-tagged button (tapped 0)'), findsOneWidget);
    expect(find.bySemanticsIdentifier('home-counter-button'), findsOneWidget);
    // Text fields are located by test ID, never by label (see ui.dart).
    expect(find.bySemanticsIdentifier('home-text-input'), findsOneWidget);
  });
}
