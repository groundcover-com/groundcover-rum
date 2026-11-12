// groundcover RUM — the Flutter playground the shared Mobilewright suite
// (tests/e2e/mobile) drives: a screen-for-screen mirror of apps/rn-playground.
import 'package:flutter/widgets.dart';
import 'package:groundcover_rum/groundcover_rum.dart';

import 'app.dart';
import 'config_presets.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // The preset has to be known before init, since it is init-time config.
  final preset = resolvePreset(await readPresetFile());
  await GroundcoverRum.init(configFor(preset));
  runApp(GroundcoverWidget(child: PlaygroundApp(preset: preset)));
  // CI's Android script waits for this logcat line before running specs.
  // print, not debugPrint: the SDK captures debugPrint as a log event.
  // ignore: avoid_print
  print('flutter-playground: ready (preset: $preset)');
}
