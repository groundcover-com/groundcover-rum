// Frame vitals from Flutter's own frame timings: what the
// engine's FrameTracker does natively for RN, done in Dart, because native
// frame hooks don't see the surface Flutter draws on.
import 'dart:async';
import 'dart:ui';

import 'package:flutter/scheduler.dart';

import '../core/common/logger.dart';
import '../core/common/time.dart';
import '../core/pipeline/rum_pipeline.dart';
import 'frame_aggregator.dart';

/// Feeds [SchedulerBinding.addTimingsCallback] into a [FrameAggregator] and
/// closes a segment on a screen change, on backgrounding, and at the cap.
///
/// Flutter reports frame timings in batches (every 100 ms in a debug build,
/// up to every second in release), so a screen change can arrive before the
/// last frames of the screen being left, or before any of them. Frames are
/// placed by when they were drawn instead: each navigation close waits until
/// a frame drawn after its change arrives, or [settle] passes, so the frames
/// drawn before it land in the segment they belong to. Several closes can be
/// waiting at once, when screens change faster than a batch. "Drawn after"
/// is by the engine's frame number; see [_Change].
///
/// Timings come in drawing order, so a frame of the screen being left that
/// is still rasterizing holds back every report after it: [settle] is long
/// enough for a frozen frame, and only runs out when nothing is drawn after
/// the change. A frame that arrives after its close has gone out anyway is
/// dropped: its screen's segment is sent, and it belongs to no other.
final class FrameVitalsTracker {
  FrameVitalsTracker({
    required this._submit,
    required this._clock,
    required int maxSegmentMs,
    this.settle = const Duration(seconds: 5),
    double Function()? refreshRate,
    Duration Function()? currentVsync,
    int Function()? currentFrame,
    SchedulerPhase Function()? schedulerPhase,
  }) : _aggregator = FrameAggregator(maxSegmentMs: maxSegmentMs),
       _refreshRate = refreshRate ?? _displayRefreshRate,
       _currentVsync = currentVsync ?? _schedulerVsync,
       _currentFrame = currentFrame ?? _engineFrameNumber,
       _schedulerPhase = schedulerPhase ?? _bindingPhase {
    // The open segment starts with the tracker, the launch, not at its first
    // reported frame: a first screen left before the first batch of timings
    // would otherwise span no time at all.
    _aggregator.reset(_clock());
  }

  final void Function(Capture capture) _submit;
  final Clock _clock;
  final FrameAggregator _aggregator;
  final double Function() _refreshRate;
  final Duration Function() _currentVsync;
  final int Function() _currentFrame;
  final SchedulerPhase Function() _schedulerPhase;

  /// The longest a navigation close waits for the frames before it.
  final Duration settle;

  /// The change of the newest close that has gone out: frames drawn before
  /// it have no segment left to join.
  _Change? _closedThrough;

  /// The screen the open segment is drawn on.
  ({String name, String key}) _screen = (name: '', key: '');

  /// Segments closed by a screen change, oldest first, each still taking the
  /// frames drawn before its change that arrive after it.
  final _closings = <_Closing>[];
  bool _attached = false;

  void attach() {
    if (_attached) return;
    _attached = true;
    SchedulerBinding.instance.addTimingsCallback(onTimings);
  }

  void detach() {
    if (!_attached) return;
    _attached = false;
    SchedulerBinding.instance.removeTimingsCallback(onTimings);
    for (final closing in _closings) {
      closing.timer.cancel();
    }
    _closings.clear();
  }

  /// One batch of frame timings.
  void onTimings(List<FrameTiming> timings) {
    try {
      for (final timing in timings) {
        record(
          vsync: Duration(
            microseconds: timing.timestampInMicroseconds(FramePhase.vsyncStart),
          ),
          durationMs: timing.totalSpan.inMicroseconds / 1000,
          frame: timing.frameNumber,
        );
      }
    } catch (error) {
      handleError(error);
    }
  }

  /// One frame: its engine number (-1 when unknown), when its vsync was (on
  /// the frame timings' own clock), and how long it took to draw.
  void record({
    required Duration vsync,
    required double durationMs,
    int frame = -1,
  }) {
    // A frame from after a change: everything drawn before it is in, since
    // timings arrive in the order frames were drawn.
    while (_closings.isNotEmpty &&
        _closings.first.change.precedes(frame: frame, vsync: vsync)) {
      _finish(_closings.first);
    }
    // Drawn before a change whose close has gone out (it gave up waiting):
    // dropped, never charged to the screen after it.
    final closedThrough = _closedThrough;
    if (closedThrough != null &&
        !closedThrough.precedes(frame: frame, vsync: vsync)) {
      return;
    }
    if (_closings.isNotEmpty) {
      // Drawn before the oldest change still waiting: that screen's.
      final closing = _closings.first;
      closing.aggregator.record(durationMs, closing.endMs);
      return;
    }
    _aggregator.refreshRateHz = _refreshRate();
    final segment = _aggregator.record(durationMs, _clock());
    if (segment != null) _emit(segment, _screen);
  }

  /// The screen changed to [screen]. Closes the segment drawn on the one
  /// being left, once its last frames have arrived.
  void screenChanged(String name, String key) {
    if (name.isEmpty || (name == _screen.name && key == _screen.key)) return;
    final left = _screen;
    _screen = (name: name, key: key);
    // The first screen: what was drawn before it landed (the launch) is that
    // screen's, as in RN, which closes on every screen change but the first.
    if (left.name.isEmpty) return;
    final endMs = _clock();
    // What was reported so far moves into the close, empty or not: a screen
    // left within one batch has frames still to come. The open segment
    // restarts now.
    final late = FrameAggregator(
      maxSegmentMs: 1 << 62,
      refreshRateHz: _aggregator.refreshRateHz,
    )..reset(_aggregator.startMs!);
    final partial = _aggregator.flush(endMs, SegmentReason.navigation);
    _aggregator.reset(endMs);
    // The frame being built when the change fires is the new screen's (a
    // Navigator.pages update, as GoRouter's, notifies observers mid-build);
    // outside a build the next one is. During transient callbacks the engine
    // still names the previous frame.
    final building = switch (_schedulerPhase()) {
      SchedulerPhase.midFrameMicrotasks ||
      SchedulerPhase.persistentCallbacks => true,
      _ => false,
    };
    final current = _currentFrame();
    late final _Closing closing;
    closing = _Closing(
      partial: partial,
      aggregator: late,
      endMs: endMs,
      change: _Change(
        // Unknown stays unknown (before the engine's first frame): the vsync
        // rule places every frame then.
        firstFrame: current < 0 ? -1 : current + (building ? 0 : 1),
        vsync: _currentVsync(),
      ),
      screen: left,
      timer: Timer(settle, () => _finishThrough(closing)),
    );
    _closings.add(closing);
    // Bounded, whatever the navigation rate: the oldest gives up waiting.
    if (_closings.length > _maxClosings) _finish(_closings.first);
  }

  /// The app left the foreground: the open segment closes now, under the
  /// screen it was drawn on.
  void background() {
    try {
      _finishAll();
      final segment = _aggregator.flush(_clock(), SegmentReason.background);
      if (segment != null) _emit(segment, _screen);
    } catch (error) {
      handleError(error);
    }
  }

  /// Back in the foreground: the time away is no frame time.
  void foreground() {
    try {
      _finishAll();
      _aggregator.reset(_clock());
    } catch (error) {
      handleError(error);
    }
  }

  /// The settle timer: finishes [closing] and every close older than it, in
  /// order. Guarded, as nothing calls it that would catch.
  void _finishThrough(_Closing closing) {
    try {
      if (!_closings.contains(closing)) return;
      while (_closings.isNotEmpty) {
        final first = _closings.first;
        _finish(first);
        if (identical(first, closing)) return;
      }
    } catch (error) {
      handleError(error);
    }
  }

  void _finishAll() {
    while (_closings.isNotEmpty) {
      _finish(_closings.first);
    }
  }

  void _finish(_Closing closing) {
    _closings.remove(closing);
    closing.timer.cancel();
    _closedThrough = closing.change;
    final late = closing.aggregator.flush(
      closing.endMs,
      SegmentReason.navigation,
    );
    final partial = closing.partial;
    final segment = partial == null || late == null
        ? partial ?? late
        : _merge(partial, late);
    // A screen nothing was drawn on has nothing to report.
    if (segment != null) _emit(segment, closing.screen);
  }

  void _emit(FrameSegment segment, ({String name, String key}) screen) {
    _submit(
      FrameSegmentCapture(
        startMs: segment.startMs,
        endMs: segment.endMs,
        slow: segment.slow,
        frozen: segment.frozen,
        total: segment.total,
        refreshRate: segment.refreshRate,
        delayMs: segment.delayMs,
        budgetMs: segment.budgetMs,
        reason: switch (segment.reason) {
          SegmentReason.navigation => FrameSegmentReason.navigation,
          SegmentReason.background => FrameSegmentReason.background,
          SegmentReason.safety => FrameSegmentReason.safety,
        },
        screenName: screen.name,
        screenKey: screen.key,
      ),
    );
  }
}

FrameSegment _merge(FrameSegment a, FrameSegment b) => FrameSegment(
  startMs: a.startMs,
  endMs: a.endMs,
  total: a.total + b.total,
  slow: a.slow + b.slow,
  frozen: a.frozen + b.frozen,
  refreshRate: a.refreshRate,
  delayMs: a.delayMs + b.delayMs,
  budgetMs: a.budgetMs,
  reason: a.reason,
);

/// Closes waiting at once; more only when screens change many times within
/// one batch.
const _maxClosings = 8;

final class _Closing {
  _Closing({
    required this.partial,
    required this.aggregator,
    required this.endMs,
    required this.change,
    required this.screen,
    required this.timer,
  });

  /// What was reported before the change; null when nothing was yet.
  final FrameSegment? partial;

  /// Frames from before the change that arrived after it.
  final FrameAggregator aggregator;
  final int endMs;
  final _Change change;
  final ({String name, String key}) screen;
  final Timer timer;
}

/// Where a screen change falls in the stream of frames.
final class _Change {
  const _Change({required this.firstFrame, required this.vsync});

  /// The engine's number for the first frame drawn after the change; -1
  /// when the engine gave none.
  final int firstFrame;

  /// The scheduler's timestamp at the change: the fallback for a frame or a
  /// change without a number. It is the current frame's target, one interval
  /// after the vsync start a timing reports, so it is right outside a build
  /// and one frame late inside one.
  final Duration vsync;

  /// Whether the change comes before the frame numbered [frame] (-1 when
  /// unknown) whose vsync started at [vsync]: that frame is drawn after it.
  bool precedes({required int frame, required Duration vsync}) =>
      frame >= 0 && firstFrame >= 0 ? frame >= firstFrame : vsync >= this.vsync;
}

double _displayRefreshRate() {
  final views = PlatformDispatcher.instance.views;
  final rate = views.isEmpty ? 0.0 : views.first.display.refreshRate;
  return rate > 0 ? rate : 60;
}

/// The current frame's vsync on the engine's frame clock, the one frame
/// timings use.
Duration _schedulerVsync() =>
    SchedulerBinding.instance.currentSystemFrameTimeStamp;

int _engineFrameNumber() => PlatformDispatcher.instance.frameData.frameNumber;

SchedulerPhase _bindingPhase() => SchedulerBinding.instance.schedulerPhase;
