// The host API between the Dart SDK and the plugin's native side, generated
// by Pigeon (typed codegen, no JNI or FFI). Regenerate
// after any change, from the package root:
//
//   dart run pigeon --input pigeons/rum_api.dart
//
// The generated files are committed.
//
// Two halves: the plugin's own services (storage, device info), and the native
// engine. The engine's config, status and
// crash records stay JSON strings, as they are on RN's bridge: the engine
// already encodes and decodes them, and typed classes here would be a second
// codec to keep in step with it.
import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/src/platform/rum_api.g.dart',
    dartPackageName: 'groundcover_rum',
    kotlinOut:
        'android/src/main/kotlin/com/groundcover/rum/flutter/RumApi.g.kt',
    kotlinOptions: KotlinOptions(package: 'com.groundcover.rum.flutter'),
    swiftOut: 'ios/groundcover_rum/Sources/groundcover_rum/RumApi.g.swift',
  ),
)
/// What only native code can read about the device and the app.
class NativeDeviceInfo {
  NativeDeviceInfo({
    required this.osVersion,
    required this.model,
    required this.brand,
    this.codename,
    this.appVersion,
    this.appBuild,
  });

  /// iOS: the system version (`18.2`). Android: the API level (`34`), which
  /// is what the RN SDK reports there.
  String osVersion;

  /// iOS: the machine identifier (`iPhone17,1`), the simulated one on a
  /// simulator. Android: `Build.MODEL`.
  String model;

  String brand;

  /// Android's `Build.DEVICE`; absent on iOS.
  String? codename;

  String? appVersion;
  String? appBuild;
}

@HostApi()
abstract class RumHostApi {
  /// Every stored SDK key and its value, to hydrate the synchronous storage
  /// the core reads.
  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  Map<String, String> loadStorage();

  /// Writes and removes keys (a null value removes). The future completes
  /// once native has committed them, and fails when it reports it couldn't:
  /// Android's commit does, iOS's UserDefaults reports nothing.
  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  void writeStorage(Map<String, String?> changes);

  NativeDeviceInfo deviceInfo();

  /// Starts the native engine with [configJson] (GCRumEngineConfig /
  /// GcRumEngineConfig) and returns its status JSON. Never throws: a failure
  /// returns the all-false status. A second call returns the first one's
  /// status, so a hot restart doesn't start a second engine.
  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  String startEngine(String configJson);

  /// The session envelope plus the current screen, as JSON, for the engine to
  /// file with a crash; null clears it.
  void updateSessionSnapshot(String? json);

  /// The previous runs' crash records, as a JSON array.
  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  String pendingCrashReports();

  /// Deletes the records with these ids, once their batch was delivered.
  @TaskQueue(type: TaskQueueType.serialBackgroundThread)
  void clearPendingCrashReports(List<String> ids);

  void stopEngine();

  /// Crashes the app natively, for testing crash capture. Development
  /// builds only (a simulator or a provisioned build on iOS, a debuggable app
  /// on Android); a no-op anywhere else.
  void triggerTestCrash(String kind);

  /// Blocks the platform thread for [ms], so the hang watchdog fires.
  /// Development builds only, like [triggerTestCrash].
  void blockMainThread(int ms);
}

/// One signal from the engine: `hang`, `app_start` or `ping`, with the
/// engine's payload as JSON.
class NativeSignal {
  NativeSignal({required this.kind, required this.payloadJson});

  String kind;
  String payloadJson;
}

@EventChannelApi()
abstract class RumSignalsApi {
  NativeSignal signals();
}
