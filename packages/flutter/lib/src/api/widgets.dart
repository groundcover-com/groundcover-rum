import 'package:flutter/widgets.dart';

import 'runtime.dart';

/// Wrap the app with this, above `MaterialApp`, to capture taps, typing and
/// gestures:
///
/// ```dart
/// runApp(const GroundcoverWidget(child: MyApp()));
/// ```
///
/// It adds nothing to the layout. A pointer down anywhere in the app is the
/// presence signal that confirms a session; until one, nothing is sent.
class GroundcoverWidget extends StatelessWidget {
  const GroundcoverWidget({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final runtime = RumRuntime.instance;
    return Listener(
      // Translucent: it observes every pointer and takes none from the app.
      behavior: HitTestBehavior.translucent,
      onPointerDown: runtime.onPointerDown,
      onPointerMove: runtime.onPointerMove,
      onPointerUp: runtime.onPointerUp,
      onPointerCancel: runtime.onPointerCancel,
      child: child,
    );
  }
}

/// Masks the label, hint and value text of every interaction inside [child]
/// (taps, gestures and input) as `***`, whatever the privacy level, and of
/// one on a control whose label would be read from text inside [child]. The
/// role, state, component and component path stay. The counterpart of RN's
/// `dataPrivate`.
class GroundcoverPrivate extends StatelessWidget {
  const GroundcoverPrivate({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}
