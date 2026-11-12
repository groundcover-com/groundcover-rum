// The native engine the plugin compiles in, over its Pigeon API.
import 'dart:async';
import 'dart:convert';

import '../core/common/json.dart';
import '../core/common/logger.dart';
import '../core/config/native_options.dart';
import '../core/config/sdk_config.dart';
import '../core/config/types.dart';
import 'rum_api.g.dart';
import 'rum_api.g.dart' as pigeon show signals;

/// The engine, as the runtime drives it. Never throws: a native failure
/// degrades to nothing armed, never to an error in the app's startup.
abstract interface class NativeEngine {
  /// What the engine emits: `hang`, `app_start`, `ping`. Listen before
  /// [start]: the plugin keeps what it emits before anyone listens, but only
  /// so much.
  Stream<NativeSignal> get signals;

  /// Starts the engine with [configJson] (see [engineConfigJson]). Completes
  /// with what it armed; a second start, as after a hot restart, gets the
  /// first one's status.
  Future<NativeEngineStatus> start(String configJson);

  Future<void> stop();
}

/// What the engine armed. [crashesUnavailable] says why crash capture isn't
/// running when it was asked for: usually another reporter owning the
/// process's crash handling.
final class NativeEngineStatus {
  const NativeEngineStatus({
    this.crashes = false,
    this.hangs = false,
    this.appStart = false,
    this.crashesUnavailable,
  });

  /// The engine's status JSON; anything unreadable is nothing armed.
  factory NativeEngineStatus.fromJson(String json) {
    final decoded = decodeJsonObject(json);
    if (decoded == null) return const NativeEngineStatus();
    final unavailable = decoded['crashesUnavailable'];
    return NativeEngineStatus(
      crashes: decoded['crashes'] == true,
      hangs: decoded['hangs'] == true,
      appStart: decoded['appStart'] == true,
      crashesUnavailable: unavailable is String ? unavailable : null,
    );
  }

  final bool crashes;
  final bool hangs;
  final bool appStart;
  final String? crashesUnavailable;
}

/// The engine config RN's session manager sends (`initNative`), as JSON.
///
/// [recording] is whether this session is sampled. Crash capture is armed
/// either way, because it governs delivery as well as capture: on iOS the
/// harvest that turns the previous run's crash into a pending record lives
/// in the engine's crash block, so an unsampled launch must still run it, or
/// a crash from an earlier sampled session is never delivered.
/// `clearSnapshotAfterHarvest` makes that safe: an unsampled launch clears
/// the previous run's envelope right after the harvest read it, so a crash
/// in this run has no session to be filed under.
///
/// [snapshotJson] is this session's envelope, which a recorded session
/// hands over here rather than by a push: the engine installs it right after
/// its harvest has read the previous run's, in the same step. A push can't
/// promise that order: it lands on the platform thread while the start runs
/// on a background queue, so it could overwrite the envelope last run's
/// crash is filed under before the harvest read it.
String engineConfigJson(
  GroundcoverConfig config, {
  required bool recording,
  required bool android,
  String? snapshotJson,
}) {
  bool enabled(RumEventName name) =>
      isEventEnabled(config.options?.enabledEvents, name);
  final native = config.options?.native;
  return jsonEncode({
    'features': {
      'crashes': enabled(RumEventName.crashes),
      'hangs': recording && enabled(RumEventName.hangs),
      'appStart': recording && enabled(RumEventName.appStart),
      // Dart owns both: native frame hooks don't see Flutter's
      // surface, and Dart already sees every pointer.
      'vitals': false,
      'gestures': false,
    },
    'thresholds': {
      'hangThresholdMs': resolveHangThresholdMs(
        native?.hangThreshold,
        android: android,
      ),
      'vitalsMaxSegmentMs': resolveVitalsMaxSegmentMs(native?.vitalsMaxSegment),
    },
    'clearSnapshotAfterHarvest': !recording,
    'snapshotJson': ?snapshotJson,
  });
}

/// [NativeEngine] over the plugin.
final class PigeonNativeEngine implements NativeEngine {
  PigeonNativeEngine([RumHostApi? api]) : _api = api ?? RumHostApi();

  final RumHostApi _api;

  // One channel per process, so one stream: the generated function makes a
  // new channel on every call.
  static final Stream<NativeSignal> _signals = pigeon.signals();

  @override
  Stream<NativeSignal> get signals => _signals;

  @override
  Future<NativeEngineStatus> start(String configJson) async {
    try {
      return NativeEngineStatus.fromJson(await _api.startEngine(configJson));
    } catch (error) {
      handleError(error);
      return const NativeEngineStatus();
    }
  }

  @override
  Future<void> stop() async {
    try {
      await _api.stopEngine();
    } catch (error) {
      handleError(error);
    }
  }
}

/// No engine: the runtime's default in tests, where no plugin answers.
final class NoNativeEngine implements NativeEngine {
  const NoNativeEngine();

  @override
  Stream<NativeSignal> get signals => const Stream.empty();

  @override
  Future<NativeEngineStatus> start(String configJson) async =>
      const NativeEngineStatus();

  @override
  Future<void> stop() async {}
}
