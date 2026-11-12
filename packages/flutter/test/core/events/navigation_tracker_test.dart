// NavigationTracker on its own: the screen it stamps, and the navigation
// events between screens (the pipeline-level cases are in
// test/instrumentation/navigation_test.dart).
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/events/captures.dart';
import 'package:groundcover_rum/src/core/events/navigation/navigation_tracker.dart';
import 'package:groundcover_rum/src/core/privacy/privacy_config.dart';

void main() {
  final privacy = resolvePrivacy(null);

  test('a screen change reports the screen left and how long it showed', () {
    final tracker = NavigationTracker();
    final first = tracker.handle(
      const ScreenCapture('Home', 'Home-1'),
      1000,
      privacy,
    )!;
    expect(first.attributes['duration_ms'], 0);
    expect(first.attributes.containsKey('from_screen'), isFalse);
    final second = tracker.handle(
      const ScreenCapture('Detail', 'Detail-2'),
      1400,
      privacy,
    )!;
    expect(second.attributes['from_screen'], 'Home');
    expect(second.attributes['from_key'], 'Home-1');
    expect(second.attributes['duration_ms'], 400);
    expect((tracker.screenName, tracker.screenKey), ('Detail', 'Detail-2'));
  });

  test('the same screen again, or a blank one, reports nothing', () {
    final tracker = NavigationTracker()
      ..handle(const ScreenCapture('Home', 'Home-1'), 1000, privacy);
    expect(
      tracker.handle(const ScreenCapture('Home', 'Home-1'), 1200, privacy),
      isNull,
    );
    expect(tracker.handle(const ScreenCapture('', 'x'), 1300, privacy), isNull);
  });

  test(
    'a manual navigation stamps its screen at once and reports at its end',
    () {
      final tracker = NavigationTracker();
      expect(
        tracker.handle(
          const NavigationStartCapture(
            'Manual',
            key: 'm-1',
            metadata: {'a': 1},
          ),
          100,
          privacy,
        ),
        isNull,
      );
      expect((tracker.screenName, tracker.screenKey), ('Manual', 'm-1'));
      final end = tracker.handle(
        const NavigationEndCapture({'b': 2}),
        350,
        privacy,
      )!;
      expect(end.attributes['duration_ms'], 250);
      expect(end.attributes['metadata'], {'a': 1, 'b': 2});
    },
  );

  test('a blank manual key is no key, as RN reads it', () {
    final tracker = NavigationTracker()
      ..handle(
        const NavigationStartCapture('Checkout', key: '  '),
        100,
        privacy,
      );
    expect(tracker.screenKey, '');
  });

  test(
    'a manual navigation with a blank screen, or no start, reports nothing',
    () {
      final tracker = NavigationTracker()
        ..handle(const NavigationStartCapture('  '), 100, privacy);
      expect(
        tracker.handle(const NavigationEndCapture(), 200, privacy),
        isNull,
      );
      expect(
        tracker.handle(const NavigationEndCapture(), 300, privacy),
        isNull,
      );
      expect(tracker.screenName, '');
    },
  );
}
