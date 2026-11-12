import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../core/events/events_pool.dart';
import '../version.dart';
import 'rum_api.g.dart';

/// The session envelope's device part, with the RN SDK's shape: `source`,
/// `os`, `device` (with `codename` on Android) and `app`, plus `sdk`, which
/// tells Flutter sessions from RN ones under the shared `source`.
///
/// [native] is read per batch, so device info that arrives late is used from
/// then on. A blank app version or build is left out, as RN omits it.
DeviceAttributesProvider deviceAttributesFor({
  required NativeDeviceInfo? Function() native,
  required String appId,
  String? appVersion,
  String? appBuild,
}) {
  final osName = switch (defaultTargetPlatform) {
    TargetPlatform.iOS => 'ios',
    TargetPlatform.android => 'android',
    _ => 'other',
  };
  return () {
    final device = native();
    return _envelope(
      osName,
      device,
      appId: appId,
      version: _nonBlank(appVersion) ?? _nonBlank(device?.appVersion),
      build: _nonBlank(appBuild) ?? _nonBlank(device?.appBuild),
    );
  };
}

String? _nonBlank(String? value) =>
    value == null || value.trim().isEmpty ? null : value;

Map<String, Object?> _envelope(
  String osName,
  NativeDeviceInfo? native, {
  required String appId,
  String? version,
  String? build,
}) => {
  'source': 'mobile-rum',
  'os': {'name': osName, 'version': native?.osVersion ?? ''},
  'device': {
    'model': native?.model ?? 'unknown',
    'brand': native?.brand ?? (osName == 'ios' ? 'Apple' : 'unknown'),
    'codename': ?native?.codename,
    // Read per batch: the logical screen can change (an orientation flip).
    'screen': _screen(),
  },
  'app': {
    'version': ?version,
    'build': ?build,
    if (appId.isNotEmpty) 'id': appId,
  },
  'sdk': {'name': sdkName, 'version': sdkVersion},
};

Map<String, Object?> _screen() {
  final dispatcher = WidgetsBinding.instance.platformDispatcher;
  final display = dispatcher.displays.firstOrNull;
  if (display == null) {
    return {'width': 0, 'height': 0, 'scale': 1, 'fontScale': 1};
  }
  final scale = display.devicePixelRatio;
  return {
    'width': display.size.width / scale,
    'height': display.size.height / scale,
    'scale': scale,
    'fontScale': dispatcher.textScaleFactor,
  };
}
