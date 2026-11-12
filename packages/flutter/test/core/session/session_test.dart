// Port of packages/core/ts/src/session/{session-state,bootstrap,
// session-lifecycle}.test.ts. The host-hook cases (captureRotationContext,
// before/afterRotate, onReconcile) are left out: the Dart lifecycle has no
// host hooks, since nothing on this platform needs one.
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/common/ids.dart';
import 'package:groundcover_rum/src/core/common/storage.dart';
import 'package:groundcover_rum/src/core/common/time.dart';
import 'package:groundcover_rum/src/core/config/config_manager.dart';
import 'package:groundcover_rum/src/core/config/constants.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/events/event_enricher.dart';
import 'package:groundcover_rum/src/core/events/events_pool.dart';
import 'package:groundcover_rum/src/core/events/rum_event.dart';
import 'package:groundcover_rum/src/core/session/bootstrap.dart';
import 'package:groundcover_rum/src/core/session/session_lifecycle.dart';
import 'package:groundcover_rum/src/core/session/session_state.dart';
import 'package:groundcover_rum/src/core/transport/transporter.dart';

import '../../support/fake_platform.dart';

const t0 = 1800000000000;
final minute = const Duration(minutes: 1).inMilliseconds;

final class FixedRandom implements Random {
  FixedRandom(this.value);
  final double value;
  @override
  double nextDouble() => value;
  @override
  bool nextBool() => false;
  @override
  int nextInt(int max) => 0;
}

final class CountingIds implements IdGenerator {
  var n = 0;
  @override
  String generateId() => 'id-${++n}';
  @override
  String generateSpanId() => 'span';
  @override
  String generateTraceId() => 'trace';
}

void main() {
  group('resolveSamplingDecision', () {
    late MapStorage backend;
    late SafeStorage storage;
    setUp(() {
      backend = MapStorage();
      storage = SafeStorage(backend);
    });

    test('samples everything with no rate, or at 1, without persisting', () {
      expect(
        resolveSamplingDecision(storage: storage, sessionSampleRate: null),
        isTrue,
      );
      expect(
        resolveSamplingDecision(storage: storage, sessionSampleRate: 1),
        isTrue,
      );
      expect(backend.values, isEmpty);
    });

    test('samples nothing at 0, even when the roll is 0, and persists it', () {
      expect(
        resolveSamplingDecision(
          storage: storage,
          sessionSampleRate: 0,
          random: FixedRandom(0),
        ),
        isFalse,
      );
      expect(backend.values[SessionKeys.sampling], '0');
    });

    test('rolls against the rate and persists the verdict', () {
      expect(
        resolveSamplingDecision(
          storage: storage,
          sessionSampleRate: 0.5,
          random: FixedRandom(0.4),
        ),
        isTrue,
      );
      expect(backend.values[SessionKeys.sampling], '1');
    });

    test('reuses a stored verdict instead of re-rolling', () {
      backend.values[SessionKeys.sampling] = '0';
      expect(
        resolveSamplingDecision(
          storage: storage,
          sessionSampleRate: 0.5,
          random: FixedRandom(0),
        ),
        isFalse,
      );
    });

    test('treats a non-finite rate as unset', () {
      expect(
        resolveSamplingDecision(
          storage: storage,
          sessionSampleRate: double.nan,
        ),
        isTrue,
      );
    });
  });

  group('bootstrapSession', () {
    late MapStorage backend;
    late SessionState session;
    final ids = CountingIds();
    setUp(() {
      backend = MapStorage();
      session = SessionState(storage: SafeStorage(backend));
    });

    void boot({String? provided, int now = t0}) => bootstrapSession(
      session: session,
      idGenerator: ids,
      clock: () => now,
      providedSessionId: provided,
    );

    test('mints an id and a start when there is no session yet', () {
      boot();
      expect(session.getSessionId(), startsWith('id-'));
      expect(session.getSessionStartTime(), msToNs(t0));
    });

    test('continues a persisted, current session', () {
      backend.values.addAll({
        SessionKeys.id: 'kept',
        SessionKeys.startTime: '${msToNs(t0 - minute)}',
        SessionKeys.lastActivity: '${t0 - minute}',
        SessionKeys.sampling: '1',
      });
      boot();
      expect(session.getSessionId(), 'kept');
      expect(backend.values[SessionKeys.sampling], '1');
    });

    test('rotates a persisted session past its cap, re-rolling sampling', () {
      backend.values.addAll({
        SessionKeys.id: 'old',
        SessionKeys.startTime: '${msToNs(t0 - 5 * 60 * minute)}',
        SessionKeys.lastActivity: '${t0 - minute}',
        SessionKeys.sampling: '1',
      });
      boot();
      expect(session.getSessionId(), isNot('old'));
      expect(session.getSessionStartTime(), msToNs(t0));
      expect(backend.values.containsKey(SessionKeys.sampling), isFalse);
    });

    test('rotates after an inactivity gap across a restart', () {
      backend.values.addAll({
        SessionKeys.id: 'old',
        SessionKeys.startTime: '${msToNs(t0 - 40 * minute)}',
        SessionKeys.lastActivity: '${t0 - 31 * minute}',
      });
      boot();
      expect(session.getSessionId(), isNot('old'));
    });

    test(
      'a different provided id starts its own clock and re-rolls sampling',
      () {
        backend.values.addAll({
          SessionKeys.id: 'old',
          SessionKeys.startTime: '${msToNs(t0 - minute)}',
          SessionKeys.sampling: '1',
        });
        boot(provided: 'mine');
        expect(session.getSessionId(), 'mine');
        expect(session.getSessionStartTime(), msToNs(t0));
        expect(backend.values.containsKey(SessionKeys.sampling), isFalse);
      },
    );

    test('the same id re-provided keeps its start and verdict', () {
      backend.values.addAll({
        SessionKeys.id: 'mine',
        SessionKeys.startTime: '${msToNs(t0 - minute)}',
        SessionKeys.lastActivity: '${t0 - minute}',
        SessionKeys.sampling: '1',
      });
      boot(provided: 'mine');
      expect(session.getSessionStartTime(), msToNs(t0 - minute));
      expect(backend.values[SessionKeys.sampling], '1');
    });

    test('treats an implausibly future start as missing', () {
      backend.values.addAll({
        SessionKeys.id: 'x',
        SessionKeys.startTime: '${msToNs(t0 + 10 * minute)}',
      });
      boot();
      expect(session.getSessionStartTime(), msToNs(t0));
    });
  });

  group('SessionState', () {
    late MapStorage backend;
    late SessionState session;
    setUp(() {
      backend = MapStorage();
      session = SessionState(storage: SafeStorage(backend));
    });

    test('reads the id and start from storage until set in memory', () {
      expect(session.getSessionId(), '');
      backend.values[SessionKeys.id] = 'stored';
      expect(session.getSessionId(), 'stored');
      session.setSessionId('memory');
      expect(session.getSessionId(), 'memory');
      expect(backend.values[SessionKeys.id], 'memory');
    });

    test('elapsed time and the cap', () {
      expect(session.getSessionElapsedMs(t0), 0);
      expect(session.isSessionExpired(t0), isFalse);
      session.setSessionStartTime(msToNs(t0));
      expect(session.getSessionElapsedMs(t0 + 1000), 1000);
      expect(
        session.isSessionExpired(
          t0 + defaultSessionMaxDuration.inMilliseconds - 1,
        ),
        isFalse,
      );
      expect(
        session.isSessionExpired(t0 + defaultSessionMaxDuration.inMilliseconds),
        isTrue,
      );
    });

    test(
      'persists the first activity stamp, then throttles to once a minute',
      () {
        session.setLastActivityMs(t0);
        expect(backend.values[SessionKeys.lastActivity], '$t0');
        session.setLastActivityMs(t0 + 1000);
        expect(backend.values[SessionKeys.lastActivity], '$t0');
        expect(session.getLastActivityMs(), t0 + 1000);
        session.setLastActivityMs(t0 + minute);
        expect(backend.values[SessionKeys.lastActivity], '${t0 + minute}');
      },
    );

    test(
      'persistLastActivity writes the exact clock, but never after a reset',
      () {
        session.setLastActivityMs(t0);
        session.setLastActivityMs(t0 + 1000);
        session.persistLastActivity();
        expect(backend.values[SessionKeys.lastActivity], '${t0 + 1000}');
        session.setSessionStartTime(msToNs(t0 + 2000));
        session.persistLastActivity();
        expect(backend.values.containsKey(SessionKeys.lastActivity), isFalse);
      },
    );

    test('a new start leaves the session unconfirmed', () {
      session.setLastActivityMs(t0);
      expect(session.hasUserActivity(), isTrue);
      session.setSessionStartTime(msToNs(t0));
      expect(session.hasUserActivity(), isFalse);
    });

    test('a confirmed session read back from storage stays confirmed', () {
      backend.values[SessionKeys.lastActivity] = '$t0';
      expect(session.hasUserActivity(), isTrue);
    });

    test(
      'inactivity: from the last activity, or from birth when unstamped',
      () {
        expect(session.isSessionInactive(t0), isFalse);
        session.setSessionStartTime(msToNs(t0));
        expect(session.isSessionInactive(t0 + 29 * minute), isFalse);
        expect(session.isSessionInactive(t0 + 30 * minute), isTrue);
        session.setLastActivityMs(t0 + 20 * minute);
        expect(session.isSessionInactive(t0 + 30 * minute), isFalse);
        expect(session.isSessionInactive(t0 + 50 * minute), isTrue);
      },
    );

    test('clearSessionState removes every key and the in-memory mirrors', () {
      session
        ..setSessionId('x')
        ..setSessionStartTime(msToNs(t0))
        ..setLastActivityMs(t0);
      backend.values[SessionKeys.sampling] = '1';
      session.clearSessionState();
      expect(backend.values, isEmpty);
      expect(session.getSessionId(), '');
      expect(session.hasUserActivity(), isFalse);
    });
  });

  group('SessionLifecycle', () {
    late FakePlatform platform;
    late SessionState session;
    late EventsPool pool;
    late SessionLifecycle lifecycle;
    late EventEnricher enricher;
    late CountingIds ids;

    void build({Duration? cap}) {
      platform = FakePlatform(nowMs: t0);
      ids = CountingIds();
      final config = ConfigManager(
        GroundcoverConfig(
          apiKey: 'k',
          dsn: 'd',
          cluster: 'c',
          environment: 'e',
          appId: 'a',
          options: GroundcoverOptions(
            sessionMaxDuration: cap,
            transport: const TransportOptions(
              batchSize: 100,
              compression: false,
            ),
          ),
        ),
      );
      session =
          SessionState(
              storage: SafeStorage(platform.mapStorage),
              maxDuration: () => config.config.options.sessionMaxDuration,
            )
            ..setSessionId('first')
            ..setSessionStartTime(msToNs(t0));
      pool = EventsPool(
        config: config,
        session: session,
        transporter: Transporter(config: config, sendBatch: platform.sendBatch),
        deviceAttributes: () => const {},
        eventsToSkipFlush: const {},
      )..initialize();
      enricher = EventEnricher(idGenerator: ids, clock: platform.clock);
      lifecycle = SessionLifecycle(
        session: session,
        pool: pool,
        idGenerator: ids,
        clock: platform.clock,
        activityEventTypes: const {'interaction'},
        ignoredEventTypes: const {'performance'},
      )..install();
    }

    RumEvent event(String type, {int? timestamp}) =>
        enricher.enrich(EnrichInput(type: type, timestamp: timestamp));

    tearDown(() => pool.destroy());

    test(
      'an interaction confirms the session and opens the send gate',
      () async {
        build();
        pool.addEvent(event('custom'));
        pool.flush();
        await drain();
        expect(platform.requests, isEmpty, reason: 'held until presence');
        pool.addEvent(event('interaction'));
        expect(session.hasUserActivity(), isTrue);
        pool.flush();
        await drain();
        expect(platform.requests.single.events, hasLength(2));
      },
    );

    test('background traffic never confirms a session', () {
      build();
      for (final type in [
        'network',
        'custom',
        'log',
        'navigation',
        'performance',
      ]) {
        pool.addEvent(event(type));
      }
      expect(session.hasUserActivity(), isFalse);
    });

    test('rotates once the cap is reached, but not for a heartbeat type', () {
      build(cap: const Duration(minutes: 1));
      platform.nowMs = t0 + minute;
      pool.addEvent(event('performance'));
      expect(session.getSessionId(), 'first');
      pool.addEvent(event('custom'));
      expect(session.getSessionId(), isNot('first'));
    });

    test('rotates on the first interaction after a gap, exactly once', () {
      build();
      lifecycle.reconcile(t0, true);
      platform.nowMs = t0 + 31 * minute;
      pool.addEvent(event('custom'));
      expect(
        session.getSessionId(),
        'first',
        reason: 'only presence ends a gap',
      );
      pool.addEvent(event('interaction'));
      final rotated = session.getSessionId();
      expect(rotated, isNot('first'));
      pool.addEvent(event('interaction'));
      expect(session.getSessionId(), rotated);
    });

    test('a confirmed session flushes its buffer under the old id', () async {
      build(cap: const Duration(minutes: 1));
      lifecycle.reconcile(t0, true);
      pool.addEvent(event('custom'));
      platform.nowMs = t0 + minute;
      pool.addEvent(event('custom'));
      await drain();
      expect(platform.requests.single.sessionAttributes['session_id'], 'first');
    });

    test('an unconfirmed session discards its buffer on rotation', () async {
      build(cap: const Duration(minutes: 1));
      pool.addEvent(event('custom'));
      platform.nowMs = t0 + minute;
      lifecycle.reconcile(t0 + minute, false);
      lifecycle.reconcile(t0 + minute, true);
      pool.flush();
      await drain();
      expect(platform.requests, isEmpty);
    });

    test("stamps the rotated session's start from the triggering event", () {
      build(cap: const Duration(minutes: 1));
      platform.nowMs = t0 + minute + 10;
      lifecycle.reconcile(
        t0 + minute + 10,
        false,
        event('custom', timestamp: msToNs(t0 + minute)),
      );
      expect(session.getSessionStartTime(), msToNs(t0 + minute));
    });

    test('a network event starts it from its start timestamp', () {
      build(cap: const Duration(minutes: 1));
      platform.nowMs = t0 + minute + 10;
      final network = event('network', timestamp: msToNs(t0 + minute + 5));
      expect(network.timestamp, isNull);
      lifecycle.reconcile(t0 + minute + 10, false, network);
      expect(session.getSessionStartTime(), msToNs(t0 + minute + 5));
    });

    test('stamps from the clock when no event drove it', () {
      build(cap: const Duration(minutes: 1));
      platform.nowMs = t0 + 2 * minute;
      lifecycle.rotateIfStale(t0 + 2 * minute, 'test');
      expect(session.getSessionStartTime(), msToNs(t0 + 2 * minute));
    });

    test('ignores implausible trigger times instead of starting in 1970', () {
      build(cap: const Duration(minutes: 1));
      final now = t0 + minute;
      platform.nowMs = now;
      for (final bogus in [
        0,
        -5,
        t0,
        msToNs(now) + 1,
        msToNs(now - 31 * minute),
      ]) {
        session.setSessionStartTime(msToNs(t0));
        lifecycle.reconcile(now, false, event('custom', timestamp: bogus));
        expect(session.getSessionStartTime(), msToNs(now), reason: '$bogus');
      }
    });

    test(
      'does not rotate on every event when events carry bogus old times',
      () {
        build(cap: const Duration(minutes: 1));
        platform.nowMs = t0 + minute;
        pool.addEvent(event('custom', timestamp: 1));
        final rotated = session.getSessionId();
        pool.addEvent(event('custom', timestamp: 1));
        pool.addEvent(event('custom', timestamp: 1));
        expect(session.getSessionId(), rotated);
      },
    );

    test(
      'rotateIfStale rotates a gapped or capped session, never a current one',
      () {
        build(cap: const Duration(minutes: 1));
        lifecycle.rotateIfStale(t0 + 1000, 'current');
        expect(session.getSessionId(), 'first');
        lifecycle.rotateIfStale(t0 + minute, 'capped');
        expect(session.getSessionId(), isNot('first'));
      },
    );

    test('uninstall clears the hook and the gate', () async {
      build();
      lifecycle.uninstall();
      pool.addEvent(event('custom'));
      pool.flush();
      await drain();
      expect(
        platform.requests,
        hasLength(1),
        reason: 'no gate after uninstall',
      );
      expect(
        session.hasUserActivity(),
        isFalse,
        reason: 'no hook after uninstall',
      );
    });
  });
}
