import 'dart:async';

import 'package:groundcover_rum/src/platform/native_engine.dart';
import 'package:groundcover_rum/src/platform/rum_api.g.dart';

/// A native engine that records what the runtime asks of it.
final class FakeNativeEngine implements NativeEngine {
  /// [calls] may be a log shared with other fakes, to order across them.
  FakeNativeEngine({List<String>? calls}) : calls = calls ?? [];

  final controller = StreamController<NativeSignal>.broadcast();
  final List<String> calls;
  String? configJson;
  NativeEngineStatus status = const NativeEngineStatus();

  /// Holds [start] until completed.
  Completer<void>? startGate;

  @override
  Stream<NativeSignal> get signals {
    calls.add('signals');
    return controller.stream;
  }

  @override
  Future<NativeEngineStatus> start(String configJson) async {
    calls.add('start');
    this.configJson = configJson;
    await startGate?.future;
    return status;
  }

  @override
  Future<void> stop() async => calls.add('stop');
}
