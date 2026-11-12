// Frame vitals: the tracker that closes segments on a screen change, on
// backgrounding and at the cap, placing frames by when they were drawn
// (their frame number, else their vsync); and the
// pipeline that ships each as one `frames_delay_total` (RN's vitals
// listener), under the screen it was drawn on.
import 'package:fake_async/fake_async.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/instrumentation/frame_vitals.dart';

import '../support/fake_platform.dart';

/// A tracker on a fake clock and frame clock, collecting what it submits.
///
/// Frames are numbered as on a device unless [numbered] is false: a frame's
/// number is its vsync, and outside a build the engine is on the frame
/// before [vsync], so the first frame drawn after a change is the one at
/// [vsync], as the vsync fallback would place it.
final class _Harness {
  _Harness({int maxSegmentMs = 60000, this.numbered = true}) {
    tracker = FrameVitalsTracker(
      submit: (capture) => segments.add(capture as FrameSegmentCapture),
      clock: () => nowMs,
      maxSegmentMs: maxSegmentMs,
      refreshRate: () => 60,
      currentVsync: () => vsync,
      currentFrame: () =>
          frameNumber ?? (numbered ? vsync.inMicroseconds - 1 : -1),
      schedulerPhase: () => phase,
    );
  }

  final bool numbered;
  late final FrameVitalsTracker tracker;
  final segments = <FrameSegmentCapture>[];
  int nowMs = 1000;
  Duration vsync = Duration.zero;

  /// The engine's frame number and the scheduler's phase when a screen
  /// changes; a null number is derived from [vsync], and -1 is none.
  int? frameNumber;
  SchedulerPhase phase = SchedulerPhase.idle;

  /// One frame drawn at [atUs] on the frame clock, numbered [n] (by default
  /// [atUs], or none when not [numbered]; -1 is none).
  void frame(int atUs, {double ms = 5, int? n}) => tracker.record(
    vsync: Duration(microseconds: atUs),
    durationMs: ms,
    frame: n ?? (numbered ? atUs : -1),
  );
}

FrameSegmentCapture _segment({
  int total = 10,
  int slow = 2,
  String screen = 'Native',
  FrameSegmentReason reason = FrameSegmentReason.navigation,
  int startMs = 1800000000000,
  int endMs = 1800000005000,
}) => FrameSegmentCapture(
  startMs: startMs,
  endMs: endMs,
  total: total,
  slow: slow,
  frozen: 1,
  refreshRate: 60,
  delayMs: 26.6667,
  budgetMs: 16.6667,
  reason: reason,
  screenName: screen,
  screenKey: '$screen-1',
);

void main() {
  group('the tracker', () {
    test('a screen change closes the left screen\'s segment once a frame '
        'from after the change arrives, with the late frames in it, with or '
        'without frame numbers', () {
      for (final numbered in [true, false]) {
        fakeAsync((async) {
          final h = _Harness(numbered: numbered);
          h.tracker.screenChanged('Native', 'Native-1');
          h.frame(100);
          h.frame(200, ms: 40);
          h.nowMs = 2000;
          h.vsync = const Duration(microseconds: 300);
          h.tracker.screenChanged('Logs', 'Logs-1');
          // Reported after the change, drawn before it.
          h.frame(250, ms: 40);
          expect(h.segments, isEmpty);
          // Drawn after it: the left screen's segment is complete.
          h.frame(300);
          final left = h.segments.single;
          expect(left.screenName, 'Native');
          expect(left.reason, FrameSegmentReason.navigation);
          expect(left.total, 3);
          expect(left.slow, 2);
          expect(left.endMs, 2000);
        });
      }
    });

    test('a screen left before its frames were reported keeps them, and '
        'the next screen gets none of them', () {
      fakeAsync((async) {
        final h = _Harness();
        h.tracker.screenChanged('A', 'A-1');
        h.frame(100);
        h.nowMs = 2000;
        h.vsync = const Duration(microseconds: 200);
        h.tracker.screenChanged('B', 'B-1');
        // B is left within one batch: none of its frames reported yet.
        h.nowMs = 3000;
        h.vsync = const Duration(microseconds: 400);
        h.tracker.screenChanged('C', 'C-1');
        // The engine's batch: frames drawn on A, then B, then C.
        h.frame(150, ms: 40);
        h.frame(300, ms: 40);
        h.frame(350, ms: 40);
        h.frame(500);
        expect(
          [for (final s in h.segments) (s.screenName, s.total, s.slow)],
          [('A', 2, 1), ('B', 2, 2)],
        );
        expect(h.segments.last.startMs, 2000);
        expect(h.segments.last.endMs, 3000);
        h.tracker.background();
        expect(h.segments.last.screenName, 'C');
        expect(h.segments.last.total, 1);
      });
    });

    test('closes anyway once settle passes with no later frame', () {
      fakeAsync((async) {
        final h = _Harness();
        h.tracker.screenChanged('Native', 'Native-1');
        h.frame(100);
        h.vsync = const Duration(microseconds: 200);
        h.tracker.screenChanged('Logs', 'Logs-1');
        async.elapse(const Duration(milliseconds: 4999));
        expect(h.segments, isEmpty);
        async.elapse(const Duration(milliseconds: 1));
        expect(h.segments.single.screenName, 'Native');
      });
    });

    test('a frame still rasterizing seconds after the change stays with the '
        'screen it was drawn on', () {
      fakeAsync((async) {
        final h = _Harness();
        h.tracker.screenChanged('Checkout', 'Checkout-1');
        h.frame(100);
        h.nowMs = 2000;
        h.vsync = const Duration(microseconds: 200);
        h.tracker.screenChanged('Profile', 'Profile-1');
        // Timings come in drawing order, so nothing reports until the slow
        // frame's raster finishes.
        async.elapse(const Duration(milliseconds: 2606));
        h.frame(150, ms: 2488);
        h.frame(300, ms: 800);
        h.tracker.background();
        expect(
          [for (final s in h.segments) (s.screenName, s.frozen)],
          [('Checkout', 1), ('Profile', 1)],
        );
      });
    });

    group('placed by frame number', () {
      // Checkout's last frame is 9; frame 10 starts at 1,000,000 us and
      // targets 1,016,667 us.
      /// A change to Profile in [phase], with the engine on frame [frame]
      /// and the scheduler's timestamp at [target].
      _Harness changeAt(
        SchedulerPhase phase, {
        required int frame,
        required int target,
        double lastCheckoutMs = 5,
      }) {
        final h = _Harness();
        h.tracker.screenChanged('Checkout', 'Checkout-1');
        h.frame(983333, n: 9, ms: lastCheckoutMs);
        h.nowMs = 2000;
        h.phase = phase;
        h.frameNumber = frame;
        h.vsync = Duration(microseconds: target);
        h.tracker.screenChanged('Profile', 'Profile-1');
        return h;
      }

      List<(String, int)> frozenByScreen(_Harness h) => [
        for (final s in h.segments) (s.screenName, s.frozen),
      ];

      test('declarative navigation (Navigator.pages, GoRouter) fires while '
          "the new screen's first frame is built: that frame is Profile's", () {
        fakeAsync((async) {
          final h = changeAt(
            SchedulerPhase.persistentCallbacks,
            frame: 10,
            target: 1016667,
          );
          h.frame(1000000, n: 10, ms: 920);
          h.frame(1016667, n: 11);
          h.tracker.background();
          expect(frozenByScreen(h), [('Checkout', 0), ('Profile', 1)]);
        });
      });

      test('during transient callbacks the engine still reports the previous '
          "frame's number: the frame in progress is Profile's", () {
        fakeAsync((async) {
          // Frame 10 began (its target is the timestamp), but frameData
          // still names frame 9.
          final h = changeAt(
            SchedulerPhase.transientCallbacks,
            frame: 9,
            target: 1016667,
          );
          h.frame(1000000, n: 10, ms: 920);
          h.frame(1016667, n: 11);
          h.tracker.background();
          expect(frozenByScreen(h), [('Checkout', 0), ('Profile', 1)]);
        });
      });

      test('outside a frame (a tap, a timer) the next frame is the first '
          "Profile draws; Checkout's last one stays Checkout's", () {
        fakeAsync((async) {
          final h = changeAt(
            SchedulerPhase.idle,
            frame: 9,
            target: 1000000,
            lastCheckoutMs: 800,
          );
          h.frame(1000000, n: 10);
          h.tracker.background();
          expect(frozenByScreen(h), [('Checkout', 1), ('Profile', 0)]);
        });
      });

      test(
        'from a post-frame callback the frame just built is Checkout\'s',
        () {
          fakeAsync((async) {
            final h = changeAt(
              SchedulerPhase.postFrameCallbacks,
              frame: 10,
              target: 1016667,
            );
            h.frame(1000000, n: 10, ms: 2488);
            h.frame(1016667, n: 11);
            h.tracker.background();
            expect(frozenByScreen(h), [('Checkout', 1), ('Profile', 0)]);
          });
        },
      );

      test('a change while the engine has no frame number yet places every '
          'frame by its vsync, numbered or not', () {
        fakeAsync((async) {
          final h = _Harness()..frameNumber = -1;
          h.tracker.screenChanged('Checkout', 'Checkout-1');
          h.nowMs = 2000;
          h.vsync = const Duration(microseconds: 200);
          h.tracker.screenChanged('Profile', 'Profile-1');
          h.frame(150, n: 5, ms: 800);
          h.frame(250, n: 6);
          h.tracker.background();
          expect(frozenByScreen(h), [('Checkout', 1), ('Profile', 0)]);
        });
      });
    });

    test('a first screen left before any frame was reported spans the launch, '
        'not zero time', () {
      fakeAsync((async) {
        final h = _Harness(); // started at 1000
        h.tracker.screenChanged('Splash', 'Splash-1');
        h.nowMs = 1500;
        h.vsync = const Duration(microseconds: 200);
        h.tracker.screenChanged('Home', 'Home-1');
        // The first batch: frames drawn on Splash, then one on Home.
        h.frame(100);
        h.frame(150, ms: 40);
        h.frame(300);
        final splash = h.segments.single;
        expect(splash.screenName, 'Splash');
        expect((splash.startMs, splash.endMs), (1000, 1500));
        expect(splash.total, 2);
      });
    });

    test('a close finished by the settle timer or by a return from the '
        'background never throws into the app, whatever submit does', () {
      fakeAsync((async) {
        FrameVitalsTracker leftCheckout() =>
            FrameVitalsTracker(
                submit: (_) => throw StateError('submit failed'),
                clock: () => 1000,
                maxSegmentMs: 60000,
                refreshRate: () => 60,
                currentVsync: () => const Duration(microseconds: 200),
                currentFrame: () => -1,
                schedulerPhase: () => SchedulerPhase.idle,
              )
              ..screenChanged('Checkout', 'Checkout-1')
              ..record(vsync: const Duration(microseconds: 100), durationMs: 5)
              ..screenChanged('Profile', 'Profile-1');
        leftCheckout();
        expect(() => async.elapse(const Duration(seconds: 6)), returnsNormally);
        expect(leftCheckout().foreground, returnsNormally);
      });
    });

    test('a frame that arrives after its screen\'s segment went out is '
        'dropped, never charged to the next screen, with or without frame '
        'numbers', () {
      for (final numbered in [true, false]) {
        fakeAsync((async) {
          final h = _Harness(numbered: numbered);
          h.tracker.screenChanged('Checkout', 'Checkout-1');
          h.frame(100);
          h.nowMs = 2000;
          h.vsync = const Duration(microseconds: 200);
          h.tracker.screenChanged('Profile', 'Profile-1');
          async.elapse(const Duration(seconds: 6));
          expect(h.segments.single.screenName, 'Checkout');
          h.frame(150, ms: 6000);
          h.frame(300);
          h.tracker.background();
          final profile = h.segments.last;
          expect(profile.screenName, 'Profile');
          expect((profile.total, profile.slow, profile.frozen), (1, 0, 0));
        });
      }
    });

    test('the first screen closes nothing: the launch is its own', () {
      final h = _Harness();
      h.frame(100);
      h.tracker.screenChanged('Home', 'Home-1');
      h.frame(200);
      h.tracker.background();
      final segment = h.segments.single;
      expect(segment.screenName, 'Home');
      expect(segment.total, 2);
    });

    test('a screen nothing was drawn on reports nothing', () {
      fakeAsync((async) {
        final h = _Harness();
        h.tracker.screenChanged('Native', 'Native-1');
        h.tracker.screenChanged('Logs', 'Logs-1');
        async.elapse(const Duration(seconds: 5));
        expect(h.segments, isEmpty);
      });
    });

    test('backgrounding closes the segment at once, under the screen it was '
        'drawn on', () {
      final h = _Harness();
      h.tracker.screenChanged('Native', 'Native-1');
      h.frame(100);
      h.nowMs = 5000;
      h.tracker.background();
      final segment = h.segments.single;
      expect(segment.reason, FrameSegmentReason.background);
      expect(segment.screenName, 'Native');
      expect(segment.endMs, 5000);
    });

    test('the time away is no frame time: the return starts afresh', () {
      final h = _Harness(maxSegmentMs: 2000);
      h.tracker.screenChanged('Native', 'Native-1');
      h.frame(100);
      h.tracker.background();
      h.nowMs = 100000;
      h.tracker.foreground();
      h.frame(200);
      // Not a safety close at once, though 99 s passed.
      expect(h.segments, hasLength(1));
    });

    test('a long dwell is closed at the cap, as safety', () {
      final h = _Harness(maxSegmentMs: 2000);
      h.tracker.screenChanged('Native', 'Native-1');
      h.frame(100);
      h.nowMs = 3000;
      h.frame(200);
      expect(h.segments.single.reason, FrameSegmentReason.safety);
      expect(h.segments.single.screenName, 'Native');
    });

    test('an idle app reports nothing: no frames, no segments', () {
      fakeAsync((async) {
        final h = _Harness(maxSegmentMs: 2000);
        h.tracker.screenChanged('Native', 'Native-1');
        async.elapse(const Duration(minutes: 5));
        expect(h.segments, isEmpty);
      });
    });
  });

  group('the pipeline', () {
    Future<(DartRumPipeline, FakePlatform)> started([
      GroundcoverOptions? options,
    ]) async {
      final platform = FakePlatform();
      final pipeline = DartRumPipeline();
      await pipeline.start(
        GroundcoverConfig(
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
        ),
        platform,
      );
      pipeline.presence();
      return (pipeline, platform);
    }

    List<Map<String, Object?>> sent(FakePlatform platform) => [
      for (final r in platform.requests) ...r.events,
    ];

    test('ships one frames_delay_total per segment, at its end, under the '
        'screen it was drawn on', () async {
      final (pipeline, platform) = await started();
      pipeline.submit(const ScreenCapture('Logs', 'Logs-1'));
      pipeline.submit(_segment());
      pipeline.flush();
      await drain();
      final event = sent(
        platform,
      ).singleWhere((e) => e['type'] == 'performance');
      expect(event['timestamp'], 1800000005000000000);
      final attributes = event['attributes']! as Map;
      expect(attributes['screen'], {'name': 'Native', 'key': 'Native-1'});
      expect(attributes['performance_metric_name'], 'frames_delay_total');
      expect(attributes['performance_metric_value'], 26.67);
      expect(attributes['performance_metric_id'], isA<String>());
      expect(attributes['performance_metric_navigation_type'], '');
      expect(attributes['performance_refresh_rate_hz'], 60);
      expect(attributes['performance_frame_budget_ms'], 16.67);
      expect(attributes['performance_segment_reason'], 'navigation');
      expect(attributes['start_timestamp'], 1800000000000000000);
      expect(attributes['end_timestamp'], 1800000005000000000);
      expect(attributes['performance_frames_slow'], 2);
      expect(attributes['performance_frames_frozen'], 1);
      // No count and no rate: platforms don't count the same frames.
      expect(attributes.keys, isNot(contains('performance_frames_total')));
      pipeline.stop();
    });

    test('drops an empty segment', () async {
      final (pipeline, platform) = await started();
      pipeline.submit(_segment(total: 0));
      pipeline.flush();
      await drain();
      expect(sent(platform).where((e) => e['type'] == 'performance'), isEmpty);
      pipeline.stop();
    });

    List<Object?> shippedScreens(FakePlatform platform) => [
      for (final e in sent(platform))
        if (e['type'] == 'performance')
          ((e['attributes']! as Map)['screen'] as Map)['name'],
    ];

    test('drops a segment that started before a session rotation', () async {
      final (pipeline, platform) = await started();
      platform.nowMs += 60000;
      await pipeline.setSessionId('next');
      // A user is there, so the new session's batches can ship.
      pipeline.presence();
      // Started under the session that rotated away, and the pool stamps the
      // session at send time, so it would ship under the new one.
      pipeline.submit(_segment());
      pipeline.submit(
        _segment(
          screen: 'Logs',
          startMs: platform.nowMs,
          endMs: platform.nowMs + 5000,
        ),
      );
      pipeline.flush();
      await drain();
      expect(shippedScreens(platform), ['Logs']);
      pipeline.stop();
    });

    test('keeps the first segment drawn wholly in the session after a '
        'rotation', () async {
      final (pipeline, platform) = await started();
      pipeline.submit(_segment());
      // Away for longer than the inactivity gap, back to a new session.
      platform.nowMs += const Duration(minutes: 40).inMilliseconds;
      await pipeline.setSessionId('next');
      pipeline.presence();
      pipeline.submit(
        _segment(
          screen: 'Logs',
          startMs: platform.nowMs,
          endMs: platform.nowMs + 5000,
        ),
      );
      pipeline.flush();
      await drain();
      expect(shippedScreens(platform), ['Native', 'Logs']);
      pipeline.stop();
    });

    test('drops a segment while the session is inactive', () async {
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
      // Past the 30-minute inactivity gap, with no new presence.
      platform.nowMs += const Duration(minutes: 31).inMilliseconds;
      pipeline.submit(_segment());
      pipeline.flush();
      await drain();
      expect(sent(platform).where((e) => e['type'] == 'performance'), isEmpty);
      pipeline.stop();
    });

    test('enabledEvents without vitals sends none', () async {
      final (pipeline, platform) = await started(
        const GroundcoverOptions(
          enabledEvents: [RumEventName.logs],
          transport: TransportOptions(batchSize: 0, compression: false),
        ),
      );
      pipeline.submit(_segment());
      pipeline.flush();
      await drain();
      expect(platform.requests, isEmpty);
      pipeline.stop();
    });
  });
}
