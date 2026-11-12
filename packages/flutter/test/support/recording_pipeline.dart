import 'dart:async';

import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';

/// A pipeline that records what reaches it.
final class RecordingPipeline implements RumPipeline {
  final calls = <String>[];
  final captures = <Capture>[];
  GroundcoverConfig? config;
  Completer<void>? startGate;
  bool failStart = false;
  bool sampled = true;
  @override
  Object? startError;

  List<InteractionCapture> get interactions =>
      captures.whereType<InteractionCapture>().toList();

  @override
  Future<PipelineStart> start(
    GroundcoverConfig config,
    PlatformServices platform,
  ) async {
    this.config = config;
    await startGate?.future;
    if (failStart) return PipelineStart.failed;
    return sampled ? PipelineStart.recording : PipelineStart.unsampled;
  }

  @override
  void submit(Capture capture) {
    captures.add(capture);
    calls.add('submit:${capture.runtimeType}');
  }

  /// What [capturesUrl] answers; everything by default.
  bool Function(String url) capturedUrls = (_) => true;

  /// What [traceHeadersFor] answers; nothing by default.
  Map<String, String> Function(String url) traceHeaders = (_) => const {};

  @override
  bool capturesUrl(String url) => capturedUrls(url);

  @override
  Map<String, String> traceHeadersFor(String url) => traceHeaders(url);

  @override
  void presence() => calls.add('presence');

  @override
  void lifecycle(HostLifecycle state) => calls.add('lifecycle:${state.name}');

  @override
  String get sessionId => 'sid';

  /// Thrown synchronously from [setSessionId], as a pipeline across a
  /// platform channel could.
  Object? throwOnSetSessionId;

  @override
  Future<void> setSessionId(String? id) {
    final error = throwOnSetSessionId;
    if (error != null) throw error;
    calls.add('setSessionId:$id');
    return Future.value();
  }

  @override
  void identifyUser(RumUser user) => calls.add('identifyUser:${user.id}');

  @override
  void updateConfig(GroundcoverConfigUpdate update) =>
      calls.add('updateConfig');

  @override
  void flush() => calls.add('flush');

  /// How many times the runtime said the engine started; kept out of
  /// [calls], which tests compare whole.
  int nativeStarts = 0;

  @override
  String? get sessionSnapshot => sampled ? '{"session_id":"recorded"}' : null;

  @override
  Future<void> nativeStarted() async => nativeStarts++;

  @override
  void stop() => calls.add('stop');
}
