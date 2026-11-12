// Port of packages/core/kotlin/.../vitals/GcRumFrameAggregatorTest.kt: what
// "slow" means, and what a segment is. Kept in step with the engine's twins,
// since a divergence in the thresholds makes the same app look jankier on
// one platform for no reason.
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/instrumentation/frame_aggregator.dart';

FrameAggregator _aggregator({int maxSegmentMs = 60000, double hz = 60}) =>
    FrameAggregator(maxSegmentMs: maxSegmentMs, refreshRateHz: hz);

/// Feeds [count] frames of [durationMs] at about 60 Hz; returns the clock.
int _feed(
  FrameAggregator aggregator,
  int count,
  double durationMs, {
  int startMs = 1000,
}) {
  var now = startMs;
  for (var i = 0; i < count; i++) {
    now += 16;
    aggregator.record(durationMs, now);
  }
  return now;
}

void main() {
  group('what counts as slow', () {
    test('a frame is slow only once it has missed its vsync', () {
      final aggregator = _aggregator();
      // At 60 Hz the bar is 1000/59 = 16.95 ms: 16.5 made its deadline, 20
      // didn't.
      _feed(aggregator, 8, 16.5);
      _feed(aggregator, 2, 20, startMs: 2000);
      final segment = aggregator.flush(3000, SegmentReason.navigation)!;
      expect(segment.total, 10);
      expect(segment.slow, 2);
    });

    test("the bar scales to the display's refresh rate", () {
      final aggregator = _aggregator(hz: 120);
      // At 120 Hz the bar is 1000/119 = 8.4 ms.
      _feed(aggregator, 1, 10);
      expect(aggregator.flush(1000, SegmentReason.navigation)!.slow, 1);
    });

    test(
      'a very late frame is frozen as well as slow; 700 ms is exclusive',
      () {
        final aggregator = _aggregator();
        _feed(aggregator, 1, 700);
        _feed(aggregator, 1, 701, startMs: 2000);
        final segment = aggregator.flush(3000, SegmentReason.navigation)!;
        expect(segment.slow, 2);
        expect(segment.frozen, 1);
      },
    );

    test('a 1 Hz display divides by nothing', () {
      final aggregator = _aggregator(hz: 1);
      _feed(aggregator, 1, 2000);
      final segment = aggregator.flush(5000, SegmentReason.navigation)!;
      expect(segment.slow, 1);
      expect(segment.budgetMs, 1000);
    });

    test('the refresh rate and the budget ride on the segment', () {
      final aggregator = _aggregator(hz: 90);
      _feed(aggregator, 1, 5);
      final segment = aggregator.flush(1000, SegmentReason.navigation)!;
      expect(segment.refreshRate, 90);
      expect(segment.budgetMs, closeTo(11.111, 0.001));
    });
  });

  group('segments', () {
    test(
      'accumulate without emitting anything until something closes them',
      () {
        final aggregator = _aggregator();
        var now = 1000;
        for (var i = 0; i < 100; i++) {
          now += 16;
          expect(aggregator.record(5, now), isNull);
        }
      },
    );

    test("carry their own bounds: the first frame's time to the close", () {
      final aggregator = _aggregator();
      aggregator.record(5, 1234);
      aggregator.record(5, 1300);
      final segment = aggregator.flush(2000, SegmentReason.navigation)!;
      expect(segment.startMs, 1234);
      expect(segment.endMs, 2000);
    });

    test('the first segment opens even when the clock reads zero', () {
      final aggregator = _aggregator();
      aggregator.record(5, 0);
      expect(aggregator.flush(10, SegmentReason.navigation)!.startMs, 0);
    });

    test('one past the cap is force-closed, with the frame that closed it', () {
      final aggregator = _aggregator(maxSegmentMs: 2000);
      expect(aggregator.record(5, 1000), isNull);
      expect(aggregator.record(5, 2999), isNull);
      final segment = aggregator.record(5, 3000)!;
      expect(segment.reason, SegmentReason.safety);
      expect(segment.total, 3);
    });

    test('the next one reopens at the close, leaving no gap', () {
      final aggregator = _aggregator(maxSegmentMs: 2000);
      aggregator.record(5, 1000);
      final first = aggregator.record(5, 3000)!;
      aggregator.record(5, 3100);
      final second = aggregator.flush(3500, SegmentReason.navigation)!;
      expect(second.startMs, first.endMs);
    });

    test('a flush with no frames hands back nothing, so a second flush is '
        'empty', () {
      final aggregator = _aggregator();
      expect(aggregator.flush(1000, SegmentReason.navigation), isNull);
      _feed(aggregator, 2, 5);
      expect(aggregator.flush(2000, SegmentReason.background), isNotNull);
      expect(aggregator.flush(3000, SegmentReason.background), isNull);
    });

    test('carry the reason they were given', () {
      final aggregator = _aggregator();
      _feed(aggregator, 1, 5);
      expect(
        aggregator.flush(2000, SegmentReason.background)!.reason,
        SegmentReason.background,
      );
    });
  });

  group('lost time', () {
    test('sums what each slow frame lost beyond the frame BUDGET', () {
      final aggregator = _aggregator();
      // Budget 16.667 ms, bar 16.949 ms: two 30 ms frames lost 13.333 each.
      _feed(aggregator, 2, 30);
      _feed(aggregator, 8, 10, startMs: 2000);
      final segment = aggregator.flush(3000, SegmentReason.navigation)!;
      expect(segment.slow, 2);
      expect(segment.delayMs, closeTo(26.667, 0.01));
    });

    test('charges nothing for a frame past the budget but inside the vsync '
        'tolerance', () {
      final aggregator = _aggregator();
      _feed(aggregator, 5, 16.8);
      final segment = aggregator.flush(1000, SegmentReason.navigation)!;
      expect(segment.slow, 0);
      expect(segment.delayMs, 0);
    });

    test('scales to the display, so a 120 Hz frame is late sooner', () {
      final aggregator = _aggregator(hz: 120);
      _feed(aggregator, 1, 20);
      expect(
        aggregator.flush(1000, SegmentReason.navigation)!.delayMs,
        closeTo(11.667, 0.01),
      );
    });

    test('is cleared when a segment closes', () {
      final aggregator = _aggregator();
      _feed(aggregator, 3, 500);
      expect(
        aggregator.flush(1000, SegmentReason.navigation)!.delayMs,
        greaterThan(1000),
      );
      _feed(aggregator, 1, 10, startMs: 2000);
      expect(aggregator.flush(3000, SegmentReason.navigation)!.delayMs, 0);
    });
  });

  group('reset', () {
    test('drops the in-flight segment, lost time included', () {
      final aggregator = _aggregator();
      _feed(aggregator, 3, 500);
      aggregator.reset(61000);
      expect(aggregator.flush(61500, SegmentReason.navigation), isNull);
      _feed(aggregator, 1, 10, startMs: 61100);
      expect(aggregator.flush(61500, SegmentReason.navigation)!.delayMs, 0);
    });

    test('re-anchors, so time spent away never counts toward the cap', () {
      final aggregator = _aggregator(maxSegmentMs: 1000);
      aggregator.record(50, 1000);
      aggregator.reset(61000);
      expect(aggregator.record(50, 61100), isNull);
      expect(aggregator.flush(61200, SegmentReason.navigation)!.startMs, 61000);
    });
  });
}
