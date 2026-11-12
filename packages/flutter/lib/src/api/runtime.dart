import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../core/common/hooks.dart';
import '../core/common/logger.dart';
import '../core/common/patch.dart';
import '../core/common/time.dart';
import '../core/config/native_options.dart';
import '../core/config/sdk_config.dart';
import '../core/config/types.dart';
import '../core/pipeline/dart_rum_pipeline.dart';
import '../core/pipeline/rum_pipeline.dart';
import '../instrumentation/app_start.dart';
import '../instrumentation/errors.dart';
import '../instrumentation/frame_vitals.dart';
import '../instrumentation/interactions.dart';
import '../instrumentation/interactive_mark.dart';
import '../instrumentation/logs.dart';
import '../instrumentation/native_signals.dart';
import '../instrumentation/network.dart';
import '../platform/flutter_platform.dart';
import '../platform/native_engine.dart';
import '../platform/rum_api.g.dart';
import 'init_exception.dart';

/// Builds the host a pipeline runs on. Replaceable in tests.
typedef PlatformFactory =
    Future<PlatformServices> Function(GroundcoverConfig config);

/// The SDK's process-wide state behind `GroundcoverRum` and the widgets: the
/// init attempt in progress or running, if there is one.
final class RumRuntime {
  RumRuntime._();

  static final RumRuntime instance = RumRuntime._();

  /// The SDK's clock: the host's once init has started it, the system's
  /// before, as the automatic TTI mark reads it.
  int now() => _attempt?.now() ?? systemClock();

  RumPipeline Function() _pipelineFactory = DartRumPipeline.new;
  PlatformFactory _platformFactory = flutterPlatform;
  NativeEngine Function() _engineFactory = PigeonNativeEngine.new;
  _Attempt? _attempt;

  /// Why the last init failed, until one succeeds: a call made meanwhile
  /// warns once with it, instead of blaming a missing init.
  GroundcoverInitException? _failure;
  bool _failureWarned = false;

  /// The running pipeline, or null before init has finished.
  RumPipeline? get pipeline => _attempt?.pipeline;

  /// The host the pipeline runs on, for the testing hooks.
  PlatformServices? get services => _attempt?.services;

  /// Starts the SDK: completes once the pipeline runs, a session not
  /// sampled included, or fails with [GroundcoverInitException]. A call while
  /// one is starting, or after one started, gets that one's future; after a
  /// failure, a new call starts again.
  Future<void> init(GroundcoverConfig config) {
    final current = _attempt;
    if (current != null) return current.started;
    // The pipeline, its storage and its platform channels live on the root
    // isolate.
    if (RootIsolateToken.instance == null) {
      return Future.error(
        _failed(
          const GroundcoverInitException('init must run on the root isolate'),
        ),
      );
    }
    if (config.appId.trim().isEmpty) {
      return Future.error(
        _failed(
          const GroundcoverInitException('init requires a nonblank appId'),
        ),
      );
    }
    // Before storage loads, as RN's Logger.initialize: a hydration timeout
    // is worth seeing.
    RumDiagnostics.instance.configure(
      debug: config.options?.debug ?? false,
      prefix: '[groundcover]',
    );
    // Claimed before anything async, so a second init in the meantime gets
    // this one's start.
    final attempt = _attempt = _Attempt(config);
    _failure = null;
    _failureWarned = false;
    // Before anything async too: a client reads the override when created,
    // so one made while the pipeline starts would never be seen. Its
    // requests pass through until the pipeline runs.
    if (attempt.captures(RumEventName.network)) {
      installHttpCapture(attempt.http, () => attempt.pipeline);
    }
    return attempt.started = _start(attempt);
  }

  Future<void> _start(_Attempt attempt) async {
    try {
      WidgetsFlutterBinding.ensureInitialized();
      final services = await _platformFactory(attempt.config);
      if (!identical(_attempt, attempt)) return;
      final pipeline = _pipelineFactory();
      final outcome = await pipeline.start(attempt.config, services);
      // Reset in the meantime: this attempt is over, its pipeline with it.
      if (!identical(_attempt, attempt)) {
        pipeline.stop();
        return;
      }
      if (outcome == PipelineStart.failed) {
        throw GroundcoverInitException(
          'the pipeline failed to start',
          pipeline.startError,
        );
      }
      attempt.run(
        pipeline,
        services,
        _engineFactory(),
        recording: outcome == PipelineStart.recording,
      );
    } catch (error, stack) {
      // Released, so the app can retry init.
      if (identical(_attempt, attempt)) _endAttempt();
      if (error is GroundcoverInitException) {
        Error.throwWithStackTrace(_failed(error), stack);
      }
      handleError(error);
      Error.throwWithStackTrace(
        _failed(GroundcoverInitException('the SDK failed to start', error)),
        stack,
      );
    }
  }

  GroundcoverInitException _failed(GroundcoverInitException failure) {
    _failure = failure;
    _failureWarned = false;
    return failure;
  }

  void _endAttempt() {
    _attempt?.dispose();
    _attempt = null;
  }

  /// Runs [run] on the pipeline, or drops it with a warning before init has
  /// completed: init is awaited before the SDK is used. Never throws.
  /// [onDrop] runs instead when [run] doesn't.
  void dispatch(
    String name,
    void Function(RumPipeline pipeline) run, {
    void Function()? onDrop,
  }) {
    // Called back from the SDK's own diagnostic line, by an app zone that
    // forwards print to the logger: dropped quietly, since a warning would
    // print, and so call back in, again.
    if (RumDiagnostics.instance.emitting) {
      _guard(() => onDrop?.call());
      return;
    }
    final pipeline = this.pipeline;
    if (pipeline == null) {
      warnNotReady(name);
      _guard(() => onDrop?.call());
      return;
    }
    // A call from one of the app's hooks would run that hook again, and so
    // on until the stack overflows: thousands of events and seconds of
    // blocked UI for one. Dropped, not deferred: deferred, it would loop one
    // call per microtask.
    if (inUserHook) {
      RumDiagnostics.instance.log('$name: called from a hook; dropped');
      _guard(() => onDrop?.call());
      return;
    }
    _guard(() => run(pipeline));
  }

  /// RN's warnNotInitialized, on every call made before init has completed:
  /// shown whatever `debug` says, and never captured as a log. After a
  /// failed init, once: why it failed.
  void warnNotReady(String name) {
    if (_attempt != null) {
      safeWarn(
        "[groundcover] $name: init() hasn't finished; await it before using "
        'the SDK',
      );
      return;
    }
    final failure = _failure;
    if (failure == null) {
      safeWarn('[groundcover] $name: not initialized, call init() first');
      return;
    }
    if (_failureWarned) return;
    _failureWarned = true;
    final cause = failure.cause == null ? '' : ': ${failure.cause}';
    safeWarn(
      '[groundcover] init() failed (${failure.message}$cause); the SDK is off '
      'until init succeeds',
    );
  }

  /// [dispatch]'s asynchronous counterpart: the future completes when [run]
  /// has, or at once when it never will. It never completes with an error.
  Future<void> dispatchAsync(
    String name,
    Future<void> Function(RumPipeline pipeline) run,
  ) {
    final done = Completer<void>();
    dispatch(name, (pipeline) {
      Future.sync(() => run(pipeline)).then(
        done.complete,
        onError: (Object error) {
          handleError(error);
          done.complete();
        },
      );
    }, onDrop: done.complete);
    return done.future;
  }

  /// A pointer down: a genuine user signal, and the start of a gesture.
  /// Ignored before init has completed: no session exists yet.
  void onPointerDown(PointerDownEvent event) {
    final attempt = _attempt;
    final pipeline = attempt?.pipeline;
    if (attempt == null || pipeline == null) return;
    _guard(pipeline.presence);
    attempt.gestures?.onPointerDown(event);
  }

  void onPointerMove(PointerMoveEvent event) =>
      _attempt?.gestures?.onPointerMove(event);

  void onPointerUp(PointerUpEvent event) =>
      _attempt?.gestures?.onPointerUp(event);

  void onPointerCancel(PointerCancelEvent event) =>
      _attempt?.gestures?.onPointerCancel(event);

  /// A screen change from a navigator observer, dropped like any call before
  /// init has completed: an awaited init has, by the app's first route.
  void navigate(ScreenCapture capture) {
    if (_attempt?.trackingNavigation == false) return;
    dispatch('navigation', (p) {
      // Submitted first: the launch metrics the first screen releases ship
      // under it, so it must be current by then, as RN's screen holder moves
      // before its listeners run.
      p.submit(capture);
      screenChanged(capture.name, capture.key);
    });
  }

  /// The screen changed, by the observer or a manual navigation, and is
  /// current in the pipeline: the frame segment drawn on the one being left
  /// closes, and the first screen is the automatic TTI mark and releases the
  /// launch metrics held for it.
  void screenChanged(String name, String key) {
    final attempt = _attempt;
    if (attempt == null || name.isEmpty) return;
    _guard(() => markAutoInteractive(attempt.now()));
    final appStart = attempt.appStart;
    if (appStart != null) _guard(appStart.screenKnown);
    final vitals = attempt.vitals;
    if (vitals != null) _guard(() => vitals.screenChanged(name, key));
  }

  /// `GroundcoverRum.stopNavigationTracking`: observers report nothing more.
  /// Like every call, dropped before init has completed.
  void stopNavigationTracking() {
    final attempt = _attempt;
    if (attempt == null || attempt.pipeline == null) {
      warnNotReady('stopNavigationTracking');
      return;
    }
    attempt.trackingNavigation = false;
  }

  /// Stops the SDK and undoes everything it set up, as if init had never
  /// run: `GroundcoverRumTesting.reset`.
  void reset() {
    _endAttempt();
    _failure = null;
    _failureWarned = false;
    resetInteractiveMarks();
  }

  /// [reset], and replaces what init builds, for tests. With no [engine],
  /// none: no plugin answers in a unit test.
  @visibleForTesting
  void debugReset({
    RumPipeline Function()? pipeline,
    PlatformFactory? platform,
    NativeEngine Function()? engine,
  }) {
    reset();
    _pipelineFactory = pipeline ?? DartRumPipeline.new;
    _platformFactory = platform ?? flutterPlatform;
    _engineFactory = engine ?? NoNativeEngine.new;
  }
}

/// Everything one init call builds: its start, the pipeline and its host,
/// and every hook and listener it installs, so ending it is one [dispose].
final class _Attempt {
  _Attempt(this.config);

  final GroundcoverConfig config;

  /// What init returns: completes when the pipeline runs.
  late final Future<void> started;
  bool trackingNavigation = true;

  RumPipeline? pipeline;
  PlatformServices? services;
  PointerGestureTracker? gestures;
  FrameVitalsTracker? vitals;
  AppStartTracker? appStart;
  NativeEngine? _engine;
  StreamSubscription<NativeSignal>? _signals;

  /// The uncaught-error hooks and the debugPrint wrapper.
  final hooks = PatchSet();

  /// The HTTP override, in at init and out again for an unsampled session.
  final http = PatchSet();

  /// Listeners to stop.
  final _undo = <void Function()>[];

  /// Set by [dispose]: work still in flight from this attempt (the engine's
  /// start) must not act for it afterwards.
  bool _disposed = false;

  bool captures(RumEventName name) =>
      isEventEnabled(config.options?.enabledEvents, name);

  /// The host's clock once running, the system's before.
  int now() => (services?.clock ?? systemClock)();

  /// The pipeline has started: listen to the lifecycle, and arm capture for
  /// a recorded session.
  void run(
    RumPipeline pipeline,
    PlatformServices services,
    NativeEngine engine, {
    required bool recording,
  }) {
    this.pipeline = pipeline;
    this.services = services;
    _listenToLifecycle(pipeline);
    _armNative(pipeline, engine, recording: recording);
    // An unsampled session must cost the app nothing. The clients the HTTP
    // override already wrapped pass its requests straight through.
    if (recording) {
      _instrument(pipeline);
    } else {
      http.restore();
    }
  }

  void _instrument(RumPipeline pipeline) {
    if (captures(RumEventName.interaction)) {
      gestures = PointerGestureTracker(pipeline.submit);
      final input = TextInputTracker(pipeline.submit)..attach();
      _undo.add(input.detach);
    }
    if (captures(RumEventName.exceptions)) {
      installErrorHooks(hooks, pipeline.submit);
    }
    if (captures(RumEventName.logs)) {
      installDebugPrintCapture(hooks, pipeline.submit);
    }
    if (captures(RumEventName.network)) {
      warnOnPathOnlyPropagationUrls(config.options?.tracing?.propagationUrls);
    }
    if (captures(RumEventName.appStart)) {
      final tracker = appStart = AppStartTracker(
        submit: pipeline.submit,
        manualTti: config.options?.native?.tti == TtiMode.manual,
      );
      _undo.add(tracker.dispose);
    }
    if (captures(RumEventName.vitals)) {
      final tracker = vitals = FrameVitalsTracker(
        submit: pipeline.submit,
        clock: services!.clock,
        maxSegmentMs: resolveVitalsMaxSegmentMs(
          config.options?.native?.vitalsMaxSegment,
        ),
      )..attach();
      _undo.add(tracker.detach);
    }
  }

  /// Starts the native engine, unsampled sessions included: crash capture
  /// governs delivery of an earlier session's crash too (see
  /// [engineConfigJson]). Not awaited: init doesn't wait for native work, as
  /// RN's doesn't.
  void _armNative(
    RumPipeline pipeline,
    NativeEngine engine, {
    required bool recording,
  }) {
    _engine = engine;
    // Before the start: the engine emits from inside it.
    _signals = engine.signals.listen(
      (signal) => _guard(() {
        final start = appStartOfSignal(signal);
        if (start != null) {
          appStart?.onAppStart(start);
          return;
        }
        final capture = captureOfSignal(signal);
        if (capture != null) pipeline.submit(capture);
      }),
      onError: (Object error) => handleError(error),
    );
    final configJson = engineConfigJson(
      config,
      recording: recording,
      android: defaultTargetPlatform == TargetPlatform.android,
      snapshotJson: pipeline.sessionSnapshot,
    );
    unawaited(
      engine.start(configJson).then((status) {
        // Reset, or init failed, while the engine started: nothing to act
        // for any more.
        if (_disposed) return;
        // Started, so the previous runs' crashes are harvested: the snapshot
        // may follow the session now, and those crashes are delivered,
        // sampled or not, each under the session it crashed in.
        unawaited(pipeline.nativeStarted());
        // The app asked for crashes and native couldn't oblige: usually
        // another reporter owning the process's crash handling, which the
        // engine refuses to take over. Said out loud, as RN does, or the app
        // reports no native crashes with nothing to explain it.
        // A session not sampled reports nothing anyway, so it says nothing,
        // as RN's.
        final unavailable = status.crashesUnavailable;
        if (unavailable != null &&
            recording &&
            captures(RumEventName.crashes)) {
          safeWarn(
            '[groundcover] native crash capture is unavailable: $unavailable. '
            'Native crashes will not be reported for this session.',
          );
        }
      }),
    );
  }

  // RN's AppState wiring: inactive persists activity; going to the
  // background persists it and flushes, once per departure (Flutter passes
  // hidden and paused on the way back up too, which is no departure); a
  // resume after the app was shown and left, or after it started away, is a
  // return. The launch is none of these, as RN's startup 'unknown' ->
  // 'active' isn't: the embedders seed the state as detached, and iOS passes
  // inactive on its way to the first resumed.
  void _listenToLifecycle(RumPipeline pipeline) {
    final initial = WidgetsBinding.instance.lifecycleState;
    var shown = initial == AppLifecycleState.resumed;
    var away =
        initial == AppLifecycleState.hidden ||
        initial == AppLifecycleState.paused;
    final listener = AppLifecycleListener(
      onStateChange: (state) => _guard(() {
        switch (state) {
          case AppLifecycleState.resumed:
            // Every way out of resumed passes inactive or the background, so
            // a resume after the app was shown, or one that started away, is
            // a return.
            final wasAway = away;
            final returning = shown || away;
            away = false;
            if (returning) {
              pipeline.lifecycle(HostLifecycle.foreground);
              // The time away is no frame time. Only a return from the
              // background restarts the segment: an overlay (a permission
              // prompt, Control Center) left the screen on display, and its
              // frames so far are still that screen's.
              if (wasAway) vitals?.foreground();
            }
            // The framework passes resumed on its way from detached to
            // inactive (iOS's launch): only a resume still current shows the
            // app.
            if (!shown) {
              scheduleMicrotask(() {
                if (WidgetsBinding.instance.lifecycleState ==
                    AppLifecycleState.resumed) {
                  shown = true;
                }
              });
            }
          case AppLifecycleState.inactive:
            pipeline.lifecycle(HostLifecycle.inactive);
          case AppLifecycleState.hidden:
          case AppLifecycleState.paused:
          case AppLifecycleState.detached:
            if (!away) {
              away = true;
              // Before the pipeline flushes, so the segment rides with it.
              vitals?.background();
              pipeline.lifecycle(HostLifecycle.background);
            }
        }
      }),
    );
    _undo.add(listener.dispose);
  }

  void dispose() {
    _disposed = true;
    unawaited(_signals?.cancel());
    _signals = null;
    final engine = _engine;
    _engine = null;
    if (engine != null) unawaited(engine.stop());
    pipeline?.stop();
    for (final undo in _undo.reversed) {
      _guard(undo);
    }
    _undo.clear();
    hooks.restore();
    http.restore();
    gestures = null;
    vitals = null;
    appStart = null;
  }
}

void _guard(void Function() body) {
  try {
    body();
  } catch (error) {
    handleError(error);
  }
}
