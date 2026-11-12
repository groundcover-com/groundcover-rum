// Taps, gestures and finished text edits, from the pointer stream the root
// GroundcoverWidget sees and from the focus system. The counterpart of the RN
// SDK's GroundcoverProvider, gesture classifier and TextInput patch.
import 'dart:collection';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../core/common/logger.dart';
import '../core/pipeline/rum_pipeline.dart';
import 'interaction_target.dart';

// The React Native SDK's constants, in logical pixels, which are Flutter's dp.
const tapSlopDp = 10.0;
const tapMaxDuration = Duration(milliseconds: 500);
const minSwipeDistanceDp = 32.0;
const minSwipeVelocityDpS = 300.0;

/// How far back from the release its velocity is measured: the horizon of
/// Flutter's and Android's VelocityTracker, about what UIKit's pan recognizer
/// smooths over. RN's JS classifier gets by on two samples a frame apart, but a
/// busy device delivers touches in bursts, and two samples from one burst can
/// read a slow drag as a swipe and inflate a flick several-fold.
const releaseWindow = Duration(milliseconds: 100);

/// A pointer position and the event's timestamp.
typedef PointerSample = ({Offset position, Duration time});

/// One gesture's classification: RN's `classifyGesture`, unchanged in its rules.
///
/// [previous] starts the release window: the last sample at least
/// [releaseWindow] before [end], or [start] in a shorter gesture.
({InteractionKind kind, GestureMeasure? measure})? classifyGesture({
  required PointerSample start,
  required PointerSample previous,
  required PointerSample end,
  required int pointerCount,
  required bool cancelled,
}) {
  final delta = end.position - start.position;
  final duration = end.time - start.time;
  final durationMs = max(0, duration.inMilliseconds);
  final exactDistance = delta.distance;
  final windowMs = (end.time - previous.time).inMicroseconds / 1000;
  final exactVelocity = windowMs > 0
      ? (end.position - previous.position).distance / windowMs * 1000
      : 0.0;

  GestureMeasure measure({GestureDirection? direction}) => GestureMeasure(
    direction: direction,
    distanceDp: exactDistance.round(),
    velocityDpS: exactVelocity.round(),
    durationMs: durationMs,
    pointerCount: pointerCount,
    partial: cancelled,
  );

  if (pointerCount >= 2) {
    return (kind: InteractionKind.pinch, measure: measure());
  }
  final movedFar = delta.dx.abs() > tapSlopDp || delta.dy.abs() > tapSlopDp;
  if (!movedFar) {
    return duration <= tapMaxDuration
        ? (kind: InteractionKind.tap, measure: null)
        : (kind: InteractionKind.longPress, measure: measure());
  }
  final direction = delta.dx.abs() >= delta.dy.abs()
      ? (delta.dx >= 0 ? GestureDirection.right : GestureDirection.left)
      : (delta.dy >= 0 ? GestureDirection.down : GestureDirection.up);
  if (cancelled) {
    return (
      kind: InteractionKind.scroll,
      measure: measure(direction: direction),
    );
  }
  if (exactDistance < minSwipeDistanceDp) return null;
  final kind = exactVelocity >= minSwipeVelocityDpS
      ? InteractionKind.swipe
      : InteractionKind.scroll;
  return (kind: kind, measure: measure(direction: direction));
}

/// Turns the root Listener's pointer events into one interaction per
/// gesture: from the first pointer down to the last pointer up.
final class PointerGestureTracker {
  PointerGestureTracker(this._submit);

  final void Function(InteractionCapture capture) _submit;

  final _active = <int>{};
  PointerSample? _start;

  /// The gesture's samples back to the first at least [releaseWindow] before
  /// the newest, so the window's start is always among them.
  final _recent = ListQueue<PointerSample>();
  int _pointerCount = 0;
  InteractionTarget? _target;

  void onPointerDown(PointerDownEvent event) {
    try {
      if (_active.isEmpty) {
        final sample = (position: event.position, time: event.timeStamp);
        _start = sample;
        _recent
          ..clear()
          ..add(sample);
        _pointerCount = 0;
        // What the gesture began on names it, as in RN.
        _target = targetOf(elementAt(event.position));
      }
      _active.add(event.pointer);
      _pointerCount = max(_pointerCount, _active.length);
    } catch (error) {
      handleError(error);
    }
  }

  void onPointerMove(PointerMoveEvent event) {
    if (!_active.contains(event.pointer) || _active.length > 1) return;
    _recent.add((position: event.position, time: event.timeStamp));
    while (_recent.length > 2 &&
        event.timeStamp - _recent.elementAt(1).time >= releaseWindow) {
      _recent.removeFirst();
    }
  }

  void onPointerUp(PointerUpEvent event) => _end(event, cancelled: false);

  void onPointerCancel(PointerCancelEvent event) =>
      _end(event, cancelled: true);

  void _end(PointerEvent event, {required bool cancelled}) {
    if (!_active.remove(event.pointer) || _active.isNotEmpty) return;
    try {
      final start = _start;
      final target = _target;
      if (start == null || target == null) return;
      final end = (position: event.position, time: event.timeStamp);
      final previous = _recent.lastWhere(
        (sample) => end.time - sample.time >= releaseWindow,
        orElse: () => _recent.first,
      );
      final result = classifyGesture(
        start: start,
        previous: previous,
        end: end,
        pointerCount: _pointerCount,
        cancelled: cancelled,
      );
      if (result == null) return;
      // A tap is placed where it lifted; a gesture where it began.
      final at = result.kind == InteractionKind.tap
          ? end.position
          : start.position;
      _submit(
        InteractionCapture(
          kind: result.kind,
          target: target,
          x: at.dx,
          y: at.dy,
          gesture: result.measure,
        ),
      );
    } catch (error) {
      handleError(error);
    } finally {
      _start = null;
      _recent.clear();
      _target = null;
    }
  }
}

/// One `input` interaction per finished edit: when a text field that
/// changed loses focus. Never the text, never coordinates.
final class TextInputTracker {
  TextInputTracker(this._submit);

  final void Function(InteractionCapture capture) _submit;
  EditableTextState? _editing;
  String? _textAtFocus;

  void attach() => FocusManager.instance.addListener(_onFocusChange);

  void detach() => FocusManager.instance.removeListener(_onFocusChange);

  void _onFocusChange() {
    try {
      final focused = FocusManager.instance.primaryFocus;
      final editable = focused?.context
          ?.findAncestorStateOfType<EditableTextState>();
      if (editable == _editing) return;
      _finish();
      _editing = editable;
      _textAtFocus = editable?.textEditingValue.text;
    } catch (error) {
      handleError(error);
    }
  }

  void _finish() {
    final editing = _editing;
    _editing = null;
    if (editing == null || !editing.mounted) return;
    if (editing.textEditingValue.text == _textAtFocus) return;
    _submit(
      InteractionCapture(
        kind: InteractionKind.input,
        target: targetOf(editing.context as Element),
      ),
    );
  }
}
