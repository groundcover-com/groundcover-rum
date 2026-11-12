// The seam between capture and the pipeline.
//
// Capture code (lib/src/instrumentation, the public API) talks to nothing in
// the core but this, and hands it typed records (events/captures.dart):
// shaping, redaction, the hooks, enrichment and batching all happen behind the
// seam.
import '../common/storage.dart';
import '../common/time.dart';
import '../config/types.dart';
import '../events/captures.dart';
import '../events/events_pool.dart';
import '../transport/transporter.dart';

export '../events/captures.dart';

/// What the host gives the pipeline. Everything platform-shaped comes in
/// here, so the core stays free of Flutter and dart:io.
abstract interface class PlatformServices {
  /// Hydrated before [RumPipeline.start]: the core reads it synchronously.
  PlatformStorage get storage;

  Clock get clock;

  BatchSender get sendBatch;

  /// Null when the host can't gzip, nor build a body off the UI isolate;
  /// batches then go uncompressed, built inline.
  Compressor? get compressor;

  /// The session envelope's device part: `source`, `os`, `device`, `app`.
  DeviceAttributesProvider get deviceAttributes;

  /// The native engine's crash store, or null on a host without the engine.
  NativeCrashStore? get crashStore;
}

/// The native engine's crash records, and the session it files with a
/// crash. The pipeline keeps that session current and delivers the
/// records.
abstract interface class NativeCrashStore {
  /// The session envelope plus the current screen, as JSON, for the engine
  /// to file with a crash; null clears it. Fire-and-forget.
  void updateSessionSnapshot(String? json);

  /// The previous runs' crash records, as a JSON array.
  Future<String> pendingCrashReports();

  /// Deletes the records with these ids, once their batch was delivered.
  Future<void> clearPendingCrashReports(List<String> ids);
}

/// The host's foreground state, as the pipeline needs it.
enum HostLifecycle {
  /// Back in the foreground: a presence signal.
  foreground,

  /// Transitioning (a call, the app switcher): activity is persisted.
  inactive,

  /// In the background: activity is persisted and the buffer is sent.
  background,
}

/// How [RumPipeline.start] ended.
enum PipelineStart {
  /// The session is recorded: capture can be armed.
  recording,

  /// The sampling verdict left this session out. Nothing is recorded, every
  /// later call is a no-op, and capture stays unarmed.
  unsampled,

  /// The pipeline couldn't start. Nothing runs; init may be retried.
  failed,
}

/// The pipeline behind the seam.
abstract interface class RumPipeline {
  /// Builds the session and starts batching, once: a second call answers as
  /// the first did. Never throws.
  Future<PipelineStart> start(
    GroundcoverConfig config,
    PlatformServices platform,
  );

  /// What a [PipelineStart.failed] start threw, when it threw: the cause
  /// init's exception carries.
  Object? get startError;

  void submit(Capture capture);

  /// Whether a request to [url] is captured: never the SDK's own endpoint,
  /// nor an `excludedUrls` match. Asked before a request is sent.
  bool capturesUrl(String url);

  /// The trace headers a request to [url] carries, fresh ids each call:
  /// empty unless it matches `tracing.propagationUrls`.
  Map<String, String> traceHeadersFor(String url);

  /// A genuine user signal (a pointer down): opens the send gate.
  void presence();

  void lifecycle(HostLifecycle state);

  /// The current session id; `''` before [start] or when unsampled.
  String get sessionId;

  /// Sends what the old session buffered, then starts [id] (or a new id).
  Future<void> setSessionId(String? id);

  void identifyUser(RumUser user);

  void updateConfig(GroundcoverConfigUpdate update);

  /// Sends the buffer now.
  void flush();

  /// The session envelope plus the current screen, as JSON: what the native
  /// engine files a crash in this run under. The engine starts with it in
  /// its config; null when this session is not recorded.
  String? get sessionSnapshot;

  /// The native engine has started, so it has harvested the crashes earlier
  /// runs left. Until now nothing of this run reached it: the harvest pairs
  /// those crashes with the snapshot it holds. From now on the snapshot
  /// follows the session, and the harvested crashes are delivered, each under
  /// the session it crashed in, whether or not this session is sampled.
  /// Completes when that pass is over; a no-op once stopped; never throws.
  Future<void> nativeStarted();

  /// Stops batching. Buffered events are dropped; persisted session state is
  /// kept, so the next start continues the session.
  void stop();
}
