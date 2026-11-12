// The host the Dart pipeline runs on in a Flutter app: the plugin's storage
// and device info over Pigeon, dart:io for batches, gzip, the system clock.
import 'dart:async';

import '../core/common/logger.dart';
import '../core/common/time.dart';
import '../core/config/types.dart';
import '../core/events/events_pool.dart';
import '../core/pipeline/rum_pipeline.dart';
import '../core/transport/transporter.dart';
import 'device_attributes.dart';
import 'hydrated_storage.dart';
import 'rum_api.g.dart';
import 'transport.dart';

final class FlutterPlatformServices implements PlatformServices {
  FlutterPlatformServices({
    required this.storage,
    required this.sendBatch,
    required this.deviceAttributes,
    required this.compressor,
    required this.clock,
    required this.crashStore,
  });

  /// Hydrated, and the store the testing hooks write through.
  @override
  final HydratedStorage storage;

  @override
  final BatchSender sendBatch;

  @override
  final DeviceAttributesProvider deviceAttributes;

  @override
  final Compressor? compressor;

  @override
  final Clock clock;

  @override
  final NativeCrashStore crashStore;
}

/// The engine's crash store, over the plugin.
final class PigeonCrashStore implements NativeCrashStore {
  PigeonCrashStore(this._api);

  final RumHostApi _api;

  @override
  void updateSessionSnapshot(String? json) {
    unawaited(_api.updateSessionSnapshot(json).catchError(handleError));
  }

  @override
  Future<String> pendingCrashReports() async {
    try {
      return await _api.pendingCrashReports();
    } catch (error) {
      handleError(error);
      return '[]';
    }
  }

  @override
  Future<void> clearPendingCrashReports(List<String> ids) =>
      _api.clearPendingCrashReports(ids);
}

/// The Flutter host for [config]: native storage hydrated and the device
/// read, together, since neither needs the other and neither throws. The
/// device is read before init completes, while the main thread is idle: read
/// behind it, the call waits behind the first frame, and a batch sent early
/// goes out without it.
Future<FlutterPlatformServices> flutterPlatform(
  GroundcoverConfig config, {
  RumHostApi? api,
}) async {
  final host = api ?? RumHostApi();
  var (storage, device) = await (
    HydratedStorage.hydrate(host),
    _deviceInfo(host),
  ).wait;
  // A miss at launch (a busy main thread past the timeout) is asked again
  // in the background, rather than kept for the whole process: RN caches
  // only a hit.
  if (device == null) {
    unawaited(_deviceInfo(host).then((info) => device ??= info));
  }
  return FlutterPlatformServices(
    storage: storage,
    sendBatch: HttpBatchSender().call,
    compressor: GzipCompressor(),
    clock: systemClock,
    crashStore: PigeonCrashStore(host),
    deviceAttributes: deviceAttributesFor(
      native: () => device,
      appId: config.appId,
      appVersion: config.options?.appVersion,
      appBuild: config.options?.appBuild,
    ),
  );
}

/// How long a native call may take before the SDK goes on without it.
const nativeCallTimeout = Duration(seconds: 3);

Future<NativeDeviceInfo?> _deviceInfo(RumHostApi api) async {
  try {
    return await api.deviceInfo().timeout(nativeCallTimeout);
  } catch (error) {
    handleError(error);
    return null;
  }
}
