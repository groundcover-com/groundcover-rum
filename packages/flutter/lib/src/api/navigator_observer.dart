import 'package:flutter/widgets.dart';

import '../core/pipeline/rum_pipeline.dart';
import 'runtime.dart';

/// Reports navigations between named routes. Add it to the app's navigator,
/// or to a router's observers:
///
/// ```dart
/// MaterialApp(navigatorObservers: [GroundcoverNavigatorObserver()]);
/// GoRouter(observers: [GroundcoverNavigatorObserver()], routes: ...);
/// ```
///
/// Screens are named by `RouteSettings.name`, and unnamed routes are
/// skipped: give a route pushed directly a name
/// (`MaterialPageRoute(settings: RouteSettings(name: 'Checkout'), ...)`),
/// and a go_router `pageBuilder` page `name: state.name ?? state.path`. Most
/// dialogs stay unnamed, so the screen under them stays current. Each route instance gets its own key, so two visits to one
/// screen are told apart. An app with nested navigators adds one observer to
/// each; tab bars that switch without a route change call
/// `GroundcoverRum.startNavigation` / `endNavigation` instead.
class GroundcoverNavigatorObserver extends NavigatorObserver {
  /// The route now on top, whatever put it there: a push, a pop, a replace,
  /// or a removal. Routes removed from under it change nothing.
  @override
  void didChangeTop(Route<dynamic> topRoute, Route<dynamic>? previousTopRoute) {
    final name = topRoute.settings.name;
    if (name == null || name.isEmpty) return;
    RumRuntime.instance.navigate(
      ScreenCapture(name, _routeKey(topRoute, name)),
    );
  }
}

final _keys = Expando<String>('groundcover route key');
var _nextKey = 0;

/// A key per route instance, stable while the route lives: `Detail-3`.
String _routeKey(Route<dynamic> route, String name) =>
    _keys[route] ??= '$name-${++_nextKey}';
