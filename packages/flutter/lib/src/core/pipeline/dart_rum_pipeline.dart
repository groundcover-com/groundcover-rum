// The Dart pipeline behind RumPipeline. Shaping lives in one shaper per
// signal under events/.
import '../common/ids.dart';
import '../common/json.dart';
import '../common/logger.dart';
import '../common/storage.dart';
import '../common/time.dart';
import '../config/config_manager.dart';
import '../config/types.dart';
import '../events/errors/shape_error.dart';
import '../events/event_enricher.dart';
import '../events/events_pool.dart';
import '../events/interaction/shape.dart';
import '../events/manual_event_emitter.dart';
import '../events/native/crash_drain.dart' as crash_drain;
import '../events/native/shape_app_start.dart';
import '../events/native/shape_frame_segment.dart';
import '../events/native/shape_hang.dart';
import '../events/navigation/navigation_tracker.dart';
import '../events/network/shape.dart';
import '../events/network/trace.dart';
import '../events/network/url_filter.dart';
import '../session/bootstrap.dart';
import '../session/session_lifecycle.dart';
import '../session/session_state.dart';
import '../transport/transporter.dart';
import 'rum_pipeline.dart';

/// Which event types prove a user is present.
const activityEventTypes = {'interaction'};

/// Heartbeat-style types that never drive session reconciliation.
const ignoredEventTypes = {'performance'};

/// Types that never trigger a size flush; they ride with the next one.
const eventsToSkipFlush = {'navigation', 'interaction', 'performance'};

/// Attributes the pipeline stamps on every event, which user-supplied log
/// attributes may not shadow.
const reservedAttributeKeys = ['screen'];

final class DartRumPipeline implements RumPipeline {
  @override
  Object? startError;

  DartRumPipeline({IdGenerator? idGenerator})
    : _ids = idGenerator ?? RandomIdGenerator();

  final IdGenerator _ids;
  ConfigManager? _config;
  PlatformServices? _platform;
  _Running? _running;
  Future<PipelineStart>? _started;
  bool _stopped = false;

  @override
  Future<PipelineStart> start(
    GroundcoverConfig config,
    PlatformServices platform,
  ) => _started ??= _start(config, platform);

  Future<PipelineStart> _start(
    GroundcoverConfig input,
    PlatformServices platform,
  ) async {
    try {
      RumDiagnostics.instance.configure(
        debug: input.options?.debug ?? false,
        prefix: '[groundcover]',
      );
      _platform = platform;
      final config = _config = ConfigManager(input);
      final storage = SafeStorage(platform.storage);
      final session = SessionState(
        storage: storage,
        maxDuration: () => config.config.options.sessionMaxDuration,
      );
      bootstrapSession(
        session: session,
        idGenerator: _ids,
        clock: platform.clock,
        providedSessionId: input.sessionId,
      );
      final sampled = resolveSamplingDecision(
        storage: storage,
        sessionSampleRate: config.config.options.sessionSampleRate,
      );
      if (!sampled) {
        RumDiagnostics.instance.log('[pipeline] session is not sampled');
        return PipelineStart.unsampled;
      }

      final pool = EventsPool(
        config: config,
        session: session,
        transporter: Transporter(
          config: config,
          sendBatch: platform.sendBatch,
          compressor: platform.compressor,
        ),
        deviceAttributes: platform.deviceAttributes,
        eventsToSkipFlush: eventsToSkipFlush,
      );
      final navigation = NavigationTracker();
      final enricher = EventEnricher(
        idGenerator: _ids,
        clock: platform.clock,
        reservedAttributeKeys: reservedAttributeKeys,
        // Every event carries the screen it happened on, empty before the
        // first navigation.
        platformAttributes: () => {
          'screen': {
            'name': navigation.screenName,
            'key': navigation.screenKey,
          },
        },
      );
      final lifecycle = SessionLifecycle(
        session: session,
        pool: pool,
        idGenerator: _ids,
        clock: platform.clock,
        activityEventTypes: activityEventTypes,
        ignoredEventTypes: ignoredEventTypes,
      )..install();
      pool.initialize();
      _running = _Running(
        config: config,
        clock: platform.clock,
        session: session,
        pool: pool,
        enricher: enricher,
        lifecycle: lifecycle,
        navigation: navigation,
        crashStore: platform.crashStore,
      )..syncSnapshot();
      return PipelineStart.recording;
    } catch (error) {
      handleError(error);
      _running = null;
      startError = error;
      return PipelineStart.failed;
    }
  }

  @override
  void submit(Capture capture) {
    final running = _running;
    if (running == null) return;
    try {
      final gate = _gateOf(capture);
      final enabled =
          gate == null || running.config.config.options.isEnabled(gate);
      // A navigation moves the current screen even with navigation events
      // off: every other event is stamped with the screen it happened on, and
      // only the navigation events themselves are left out.
      if (!enabled && capture is! NavigationCapture) return;
      if (capture is FrameSegmentCapture) _addFrameSegment(running, capture);
      final privacy = running.config.privacy;
      final input = switch (capture) {
        CustomEventCapture() => shapeCustomEvent(capture),
        LogCapture() => shapeLogEvent(
          capture,
          privacy,
          reservedKeys: reservedAttributeKeys,
        ),
        ErrorCapture() => shapeErrorEvent(capture, privacy),
        InteractionCapture() => shapeInteractionEvent(capture, privacy),
        NetworkCapture() => shapeNetworkEvent(
          capture,
          privacy: privacy,
          tracing: running.config.config.options.tracing,
        ),
        NavigationCapture() => running.navigation.handle(
          capture,
          running.clock(),
          privacy,
        ),
        HangCapture() => shapeHangEvent(capture),
        // Added above, under the screen it was drawn on.
        FrameSegmentCapture() => null,
        AppStartCapture() => shapeAppStartEvent(
          capture,
          metricId: _ids.generateId(),
        ),
      };
      if (input != null && enabled) {
        running.pool.addEvent(running.enricher.enrich(input));
      }
      // A recovered hang often comes just before a force-quit or an OS kill,
      // which the batch timer would lose it to; RN flushes it at once too.
      if (capture is HangCapture) running.pool.flush(lifecycle: true);
    } catch (error) {
      handleError(error);
    }
    // A navigation changes the screen, and an event can rotate the session.
    running.syncSnapshot();
  }

  /// The enabledEvents gate [capture] passes through. A custom event is the
  /// app's own call, never gated.
  static RumEventName? _gateOf(Capture capture) => switch (capture) {
    CustomEventCapture() => null,
    LogCapture() => RumEventName.logs,
    ErrorCapture() => RumEventName.exceptions,
    InteractionCapture() => RumEventName.interaction,
    NetworkCapture() => RumEventName.network,
    NavigationCapture() => RumEventName.navigation,
    HangCapture() => RumEventName.hangs,
    FrameSegmentCapture() => RumEventName.vitals,
    AppStartCapture() => RumEventName.appStart,
  };

  /// RN's vitals listener: a closed segment, as one `frames_delay_total`.
  void _addFrameSegment(_Running running, FrameSegmentCapture segment) {
    // "Nothing rendered" is no vitals signal: an empty segment would report
    // no lost time, as though the screen had been smooth.
    if (segment.total <= 0) return;
    // The idle gate, as RN's: frames drawn while nobody was there don't
    // describe a session anyone used.
    if (running.session.isSessionInactive(running.clock())) return;
    // Started before this session did: part of it measured the session that
    // rotated away, and the pool stamps the session at send time, so it
    // would ship under the new one. That id is retired, so dropping it is
    // the only correct option. A segment drawn wholly since the rotation is
    // this session's own.
    if (msToNs(segment.startMs) < running.session.getSessionStartTime()) {
      return;
    }
    // An enricher of its own: on a navigation the segment belongs to the
    // screen being left, and the ambient stamp already names the new one.
    final enricher = EventEnricher(
      idGenerator: _ids,
      clock: running.clock,
      platformAttributes: () => {
        'screen': {'name': segment.screenName, 'key': segment.screenKey},
      },
    );
    running.pool.addEvent(
      enricher.enrich(
        shapeFrameSegmentEvent(segment, metricId: _ids.generateId()),
      ),
    );
  }

  @override
  bool capturesUrl(String url) {
    try {
      final running = _running;
      if (running == null) return false;
      final config = running.config.config;
      if (!config.options.isEnabled(RumEventName.network)) return false;
      // Capture reports a URL as dart:io's Uri prints it (lowercase host, no
      // default port, dot segments resolved), where RN's fetch sees the
      // string it was given. The endpoint is matched in that form too:
      // otherwise a DSN written another way has each batch upload captured,
      // which fills the next batch, and an idle app uploads forever.
      final endpoint = config.endpoint;
      final printed = Uri.tryParse(endpoint)?.toString() ?? '';
      if (printed.isNotEmpty && url.contains(printed)) return false;
      return !shouldIgnoreUrl(
        url,
        endpoint: endpoint,
        excludedUrls: config.options.excludedUrls,
      );
    } catch (error) {
      handleError(error);
      return false;
    }
  }

  @override
  Map<String, String> traceHeadersFor(String url) {
    try {
      final running = _running;
      if (running == null) return const {};
      final tracing = running.config.config.options.tracing;
      if (!matchesPropagationUrl([url], tracing.propagationUrls)) {
        return const {};
      }
      return buildTraceHeaders(tracing, generateTraceIds(_ids));
    } catch (error) {
      handleError(error);
      return const {};
    }
  }

  @override
  void presence() {
    final running = _running;
    if (running == null) return;
    try {
      running.lifecycle.reconcile(running.clock(), true);
    } catch (error) {
      handleError(error);
    }
    running.syncSnapshot();
  }

  @override
  void lifecycle(HostLifecycle state) {
    final running = _running;
    if (running == null) return;
    try {
      switch (state) {
        case HostLifecycle.foreground:
          running.lifecycle.reconcile(running.clock(), true);
        case HostLifecycle.inactive:
          running.session.persistLastActivity();
        case HostLifecycle.background:
          running.session.persistLastActivity();
          running.pool.flush(lifecycle: true);
      }
    } catch (error) {
      handleError(error);
    }
    running.syncSnapshot();
  }

  @override
  String get sessionId => _running?.session.getSessionId() ?? '';

  @override
  Future<void> setSessionId(String? id) async {
    final running = _running;
    if (running == null) return;
    try {
      await running.pool.flushSync();
      running.session.setSessionId(
        id == null || id.isEmpty ? _ids.generateId() : id,
      );
      running.session.setSessionStartTime(msToNs(running.clock()));
    } catch (error) {
      handleError(error);
    }
    running.syncSnapshot();
  }

  @override
  void identifyUser(RumUser user) =>
      updateConfig(GroundcoverConfigUpdate(user: user));

  @override
  void updateConfig(GroundcoverConfigUpdate update) {
    try {
      _config?.update(update);
      final debug = update.options?.debug;
      if (debug != null) RumDiagnostics.instance.configure(debug: debug);
    } catch (error) {
      handleError(error);
    }
    final running = _running;
    if (running != null) {
      // The envelope may have changed (the user, the cluster, the env).
      running.configVersion++;
      running.syncSnapshot();
    }
  }

  @override
  void flush() => _running?.pool.flush();

  @override
  String? get sessionSnapshot => _running?.snapshot;

  @override
  Future<void> nativeStarted() async {
    // Stopped first: the drain would send under the config init gave up on.
    if (_stopped) return;
    _running?.engineStarted();
    final config = _config;
    final platform = _platform;
    final store = platform?.crashStore;
    if (config == null || platform == null || store == null) return;
    await crash_drain.drainCrashReports(
      store: store,
      config: config,
      ids: _ids,
      clock: platform.clock,
      sendBatch: platform.sendBatch,
      compressor: platform.compressor,
    );
  }

  @override
  void stop() {
    _stopped = true;
    final running = _running;
    if (running == null) return;
    running.lifecycle.uninstall();
    running.pool.destroy();
    // A session that stopped is no longer one to file a crash under, as RN's
    // destroy clears it.
    running.clearSnapshot();
    _running = null;
  }
}

final class _Running {
  _Running({
    required this.config,
    required this.clock,
    required this.session,
    required this.pool,
    required this.enricher,
    required this.lifecycle,
    required this.navigation,
    required this.crashStore,
  });

  final ConfigManager config;
  final Clock clock;
  final SessionState session;
  final EventsPool pool;
  final EventEnricher enricher;
  final SessionLifecycle lifecycle;
  final NavigationTracker navigation;
  final NativeCrashStore? crashStore;

  /// Bumped by every config update, which can change the envelope.
  int configVersion = 0;

  /// The session to file a crash in this run under: the envelope this
  /// session's batches carry, plus the current screen, as RN's
  /// session-snapshot pusher. Kept current whether or not it can go out yet.
  String? snapshot;
  String? _snapshotKey;

  /// Whether the native engine has started. Until it has, nothing of this
  /// run may reach it: its start pairs the previous run's crashes with the
  /// snapshot it holds, and the engine gets [snapshot] in its config instead.
  bool _engineStarted = false;

  /// Rebuilds [snapshot] when the session, the screen or the config changed,
  /// compared by a cheap key first, since this runs after every capture;
  /// pushes it once the engine has started.
  void syncSnapshot() {
    final store = crashStore;
    if (store == null) return;
    try {
      final key = [
        session.getSessionId(),
        session.getSessionStartTime(),
        navigation.screenName,
        navigation.screenKey,
        configVersion,
      ].join('\u0000');
      if (key == _snapshotKey) return;
      // As batches encode it: a user property JSON has no form for (a
      // DateTime) is written as its string, rather than costing every
      // snapshot from here on.
      final json = encodeJson({
        ...pool.getSessionAttributes(),
        'screen': {'name': navigation.screenName, 'key': navigation.screenKey},
      });
      _snapshotKey = key;
      snapshot = json;
      if (_engineStarted) store.updateSessionSnapshot(json);
    } catch (error) {
      handleError(error);
    }
  }

  /// The engine has started: the latest snapshot goes out, and every change
  /// after it. Even when the engine started with it in its config: one
  /// already running (after a hot restart) answers a second start without
  /// reading that config.
  void engineStarted() {
    if (_engineStarted) return;
    _engineStarted = true;
    final json = snapshot;
    if (json == null) return;
    try {
      crashStore?.updateSessionSnapshot(json);
    } catch (error) {
      handleError(error);
    }
  }

  void clearSnapshot() {
    // Not before the engine started: what it holds then is the previous
    // run's envelope, which its harvest still has to read.
    if (!_engineStarted) return;
    try {
      crashStore?.updateSessionSnapshot(null);
    } catch (error) {
      handleError(error);
    }
  }
}
