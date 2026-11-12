import 'package:flutter/material.dart';
import 'package:groundcover_rum/groundcover_rum.dart';

import 'screens/config_screen.dart';
import 'screens/custom_screen.dart';
import 'screens/detail_screen.dart';
import 'screens/home_screen.dart';
import 'screens/logs_screen.dart';
import 'screens/native_screen.dart';
import 'screens/network_screen.dart';

/// The six tabs, by label, and the route each one opens.
const _tabs = [
  (label: 'Taps', route: 'Home', icon: Icons.touch_app),
  (label: 'Network', route: 'Network', icon: Icons.public),
  (label: 'Logs', route: 'Logs', icon: Icons.notes),
  (label: 'Custom', route: 'Custom', icon: Icons.star_outline),
  (label: 'Native', route: 'Native', icon: Icons.memory),
  (label: 'Config', route: 'Config', icon: Icons.settings),
];

/// The playground: one named route per screen, with RN's route names (Home,
/// Detail, Network, Logs, Custom, Native, Config), because the specs assert
/// them as `screen.name`.
///
/// Tabs are routes, not an IndexedStack. Switching tabs replaces the route on
/// the one navigator GroundcoverNavigatorObserver watches, so a tab switch is
/// a navigation the SDK sees, as React Navigation's tab switches are in RN.
/// Detail is pushed on top of Home, like RN's stack inside the Taps tab.
class PlaygroundApp extends StatelessWidget {
  const PlaygroundApp({super.key, required this.preset});

  final String preset;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'flutter-playground',
      navigatorObservers: [GroundcoverNavigatorObserver()],
      initialRoute: 'Home',
      onGenerateRoute: (settings) {
        final screen = switch (settings.name) {
          'Detail' => const DetailScreen(),
          'Network' => const NetworkScreen(),
          'Logs' => const LogsScreen(),
          'Custom' => const CustomScreen(),
          'Native' => const NativeScreen(),
          'Config' => ConfigScreen(preset: preset),
          _ => const HomeScreen(),
        };
        final page = _TabShell(route: settings.name ?? 'Home', child: screen);
        // A tab switch is instant, as in RN; the stack push animates.
        if (settings.name == 'Detail') {
          return MaterialPageRoute<void>(
            settings: settings,
            builder: (_) => page,
          );
        }
        return PageRouteBuilder<void>(
          settings: settings,
          transitionDuration: Duration.zero,
          reverseTransitionDuration: Duration.zero,
          pageBuilder: (_, _, _) => page,
        );
      },
    );
  }
}

class _TabShell extends StatelessWidget {
  const _TabShell({required this.route, required this.child});

  final String route;
  final Widget child;

  String get _activeTab => route == 'Detail' ? 'Home' : route;

  Widget _tabButton(
    BuildContext context,
    String label,
    String target,
    IconData icon,
  ) {
    final active = _activeTab == target;
    // An explicit label with the visible text excluded: specs, and
    // tapScrolling's tab-bar measurement, locate tabs by this exact label.
    return Expanded(
      child: Semantics(
        label: '$label tab',
        button: true,
        selected: active,
        excludeSemantics: true,
        child: InkWell(
          onTap: () {
            if (route == target) return;
            Navigator.of(context).pushNamedAndRemoveUntil(target, (_) => false);
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  icon,
                  color: active ? Theme.of(context).colorScheme.primary : null,
                ),
                Text(label, style: const TextStyle(fontSize: 12)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(bottom: false, child: child),
      bottomNavigationBar: SafeArea(
        child: Row(
          children: [
            for (final tab in _tabs)
              _tabButton(context, tab.label, tab.route, tab.icon),
          ],
        ),
      ),
    );
  }
}
