// DartRumPipeline as a whole, beyond what the wire golden pins: the
// enabledEvents gates, the host lifecycle, session id control and stopping.
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/common/storage.dart';
import 'package:groundcover_rum/src/core/common/time.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/events/events_pool.dart';
import 'package:groundcover_rum/src/core/pipeline/dart_rum_pipeline.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/core/transport/transporter.dart';
import 'package:groundcover_rum/src/core/session/session_state.dart';

import '../../support/fake_platform.dart';

GroundcoverConfig config({GroundcoverOptions? options, String? sessionId}) =>
    GroundcoverConfig(
      apiKey: 'k',
      dsn: 'ingest.example',
      cluster: 'c',
      environment: 'e',
      appId: 'a',
      sessionId: sessionId,
      options:
          options ??
          const GroundcoverOptions(
            transport: TransportOptions(batchSize: 0, compression: false),
          ),
    );

Future<(DartRumPipeline, FakePlatform)> started({
  GroundcoverOptions? options,
  String? sessionId,
}) async {
  final platform = FakePlatform();
  final pipeline = DartRumPipeline();
  await pipeline.start(
    config(options: options, sessionId: sessionId),
    platform,
  );
  return (pipeline, platform);
}

List<String> types(FakePlatform p) => [
  for (final r in p.requests)
    for (final e in r.events) e['type']! as String,
];

void main() {
  test('a start that throws keeps what it threw', () async {
    final broken = StateError('storage gone');
    final pipeline = DartRumPipeline();
    final outcome = await pipeline.start(
      config(),
      _ThrowingStoragePlatform(broken),
    );
    expect(outcome, PipelineStart.failed);
    expect(pipeline.startError, broken);
  });

  test(
    "the SDK's own uploads are never captured, however the dsn is written",
    () async {
      // Captured, each upload would fill the next batch with its own network
      // event, and an idle app would upload every batchTimeout for good.
      for (final dsn in [
        'ingest.example',
        'Ingest.Example',
        'https://INGEST.example:443',
        'https://ingest.example/a/../rum',
      ]) {
        final pipeline = DartRumPipeline();
        await pipeline.start(
          GroundcoverConfig(
            apiKey: 'k',
            dsn: dsn,
            cluster: 'c',
            environment: 'e',
            appId: 'a',
          ),
          FakePlatform(),
        );
        final endpoint = dsn.startsWith('http') ? dsn : 'https://$dsn';
        // As network capture reports it: the Uri dart:io was given, printed.
        final upload = '${Uri.parse('$endpoint/json/rum')}';
        expect(pipeline.capturesUrl(upload), isFalse, reason: '$dsn: $upload');
        expect(pipeline.capturesUrl('https://api.example/orders'), isTrue);
        pipeline.stop();
      }
    },
  );

  test('starts once; a second start is ignored', () async {
    final (pipeline, platform) = await started(sessionId: 'first');
    await pipeline.start(config(sessionId: 'second'), platform);
    expect(pipeline.sessionId, 'first');
  });

  test('does nothing before start', () async {
    final pipeline = DartRumPipeline();
    pipeline
      ..presence()
      ..submit(const CustomEventCapture('x', {}))
      ..lifecycle(HostLifecycle.background)
      ..flush();
    expect(pipeline.sessionId, '');
    await pipeline.setSessionId('x');
  });

  test(
    'enabledEvents gates logs and exceptions, never custom events',
    () async {
      final (pipeline, platform) = await started(
        options: const GroundcoverOptions(
          enabledEvents: [RumEventName.interaction],
          transport: TransportOptions(batchSize: 0, compression: false),
        ),
      );
      pipeline
        ..presence()
        ..submit(const LogCapture('m', LogLevel.info))
        ..submit(const ErrorCapture(type: 'E', message: 'm'))
        ..submit(const CustomEventCapture('c', {}));
      await drain();
      expect(types(platform), ['custom']);
    },
  );

  test('log attributes cannot shadow message, level or screen', () async {
    final (pipeline, platform) = await started();
    pipeline
      ..presence()
      ..submit(
        const LogCapture(
          'real',
          LogLevel.warn,
          attributes: {
            'message': 'fake',
            'level': 'fake',
            'screen': 'fake',
            'ok': 1,
          },
        ),
      );
    await drain();
    final attrs = platform.requests.single.events.single['attributes'] as Map;
    expect(attrs, {
      'message': 'real',
      'level': 'warn',
      'ok': 1,
      // Stamped by the pipeline on every event, empty before any navigation.
      'screen': {'name': '', 'key': ''},
    });
  });

  test(
    'a background transition persists activity and sends the buffer',
    () async {
      final (pipeline, platform) = await started(
        options: const GroundcoverOptions(
          transport: TransportOptions(batchSize: 100, compression: false),
        ),
      );
      pipeline
        ..presence()
        ..submit(const CustomEventCapture('held', {}));
      await drain();
      expect(platform.requests, isEmpty);
      platform.nowMs += 1000;
      pipeline.presence();
      pipeline.lifecycle(HostLifecycle.background);
      await drain();
      expect(types(platform), ['custom']);
      expect(
        platform.mapStorage.values[SessionKeys.lastActivity],
        '${platform.nowMs}',
      );
    },
  );

  test('returning to the foreground counts as presence', () async {
    final (pipeline, platform) = await started();
    pipeline.submit(const CustomEventCapture('held', {}));
    await drain();
    expect(platform.requests, isEmpty);
    pipeline.lifecycle(HostLifecycle.foreground);
    pipeline.flush();
    await drain();
    expect(types(platform), ['custom']);
  });

  test(
    'setSessionId sends the old session, then starts the given id',
    () async {
      final (pipeline, platform) = await started(
        options: const GroundcoverOptions(
          transport: TransportOptions(batchSize: 100, compression: false),
        ),
      );
      final before = pipeline.sessionId;
      pipeline
        ..presence()
        ..submit(const CustomEventCapture('old', {}));
      await pipeline.setSessionId('fixed');
      await drain();
      expect(platform.requests.single.sessionAttributes['session_id'], before);
      expect(pipeline.sessionId, 'fixed');
      await pipeline.setSessionId(null);
      expect(pipeline.sessionId, hasLength(32));
    },
  );

  test('an unsampled session reports nothing and says so', () async {
    final platform = FakePlatform();
    final pipeline = DartRumPipeline();
    expect(
      await pipeline.start(
        config(options: const GroundcoverOptions(sessionSampleRate: 0)),
        platform,
      ),
      PipelineStart.unsampled,
    );
    pipeline
      ..presence()
      ..submit(const CustomEventCapture('x', {}))
      ..flush();
    await drain();
    expect(platform.requests, isEmpty);
    expect(pipeline.sessionId, '');
  });

  test('stop drops the buffer and keeps the persisted session', () async {
    final (pipeline, platform) = await started(
      options: const GroundcoverOptions(
        transport: TransportOptions(batchSize: 100, compression: false),
      ),
    );
    final id = pipeline.sessionId;
    pipeline
      ..presence()
      ..submit(const CustomEventCapture('x', {}))
      ..stop()
      ..flush();
    await drain();
    expect(platform.requests, isEmpty);
    expect(platform.mapStorage.values[SessionKeys.id], id);
  });

  test('identifyUser and updateConfig reach the envelope', () async {
    final (pipeline, platform) = await started();
    pipeline
      ..presence()
      ..identifyUser(const RumUser(id: 'u1'))
      ..updateConfig(const GroundcoverConfigUpdate(environment: 'prod'))
      ..submit(const CustomEventCapture('x', {}));
    await drain();
    final attrs = platform.requests.single.sessionAttributes;
    expect(attrs['user'], {'id': 'u1'});
    expect(attrs['env'], 'prod');
  });

  group('interaction events', () {
    const target = InteractionTarget(
      component: 'Button',
      label: 'Pay now',
      role: 'button',
      hint: 'Charges the card',
      state: {'selected': true},
      valueText: 'forty two percent',
      componentPath: 'HomeScreen > Card > Button',
    );

    Future<Map<String, Object?>> shipped(
      InteractionCapture capture, {
      GroundcoverOptions? options,
    }) async {
      final (pipeline, platform) = await started(
        options:
            options ??
            const GroundcoverOptions(
              transport: TransportOptions(batchSize: 0, compression: false),
            ),
      );
      pipeline
        ..submit(capture)
        ..submit(const CustomEventCapture('flush', {}));
      await drain();
      return platform.requests.single.events.first['attributes']!
          as Map<String, Object?>;
    }

    test('a tap: coordinates, the target and the path, flattened', () async {
      final attrs = await shipped(
        const InteractionCapture(
          kind: InteractionKind.tap,
          target: target,
          x: 12,
          y: 34,
        ),
      );
      expect(attrs, {
        'interaction_type': 'tap',
        'interaction_coordinates.x': 12,
        'interaction_coordinates.y': 34,
        'interaction_target.component': 'Button',
        'interaction_target.label': 'Pay now',
        'interaction_target.role': 'button',
        'interaction_target.hint': 'Charges the card',
        'interaction_target.state.selected': true,
        'interaction_target.value.text': 'forty two percent',
        'interaction_component_path': 'HomeScreen > Card > Button',
        'screen': {'name': '', 'key': ''},
      });
    });

    test('a gesture adds its measure; an input has no coordinates', () async {
      final swipe = await shipped(
        const InteractionCapture(
          kind: InteractionKind.swipe,
          target: target,
          x: 1,
          y: 2,
          gesture: GestureMeasure(
            direction: GestureDirection.up,
            distanceDp: 120,
            velocityDpS: 900,
            durationMs: 130,
            pointerCount: 1,
          ),
        ),
      );
      expect(swipe['interaction_gesture.direction'], 'up');
      expect(swipe['interaction_gesture.capture_source'], 'dart');
      expect(swipe.containsKey('interaction_gesture.partial'), isFalse);

      final input = await shipped(
        const InteractionCapture(kind: InteractionKind.input, target: target),
      );
      expect(
        input.keys.where((k) => k.startsWith('interaction_coordinates')),
        isEmpty,
      );
    });

    test(
      'GroundcoverPrivate masks label, hint and value text; structure stays',
      () async {
        final attrs = await shipped(
          const InteractionCapture(
            kind: InteractionKind.tap,
            target: InteractionTarget(
              component: 'Button',
              label: 'Private action',
              role: 'button',
              hint: 'secret hint',
              state: {'selected': true},
              valueText: 'secret',
              componentPath: 'HomeScreen > Button',
              masked: true,
            ),
            x: 0,
            y: 0,
          ),
        );
        expect(attrs['interaction_target.label'], '***');
        expect(attrs['interaction_target.hint'], '***');
        expect(attrs['interaction_target.value.text'], '***');
        expect(attrs['interaction_target.state.selected'], isTrue);
        expect(attrs['interaction_target.component'], 'Button');
        expect(attrs['interaction_component_path'], 'HomeScreen > Button');
      },
    );

    test('mask-all masks every label; the default level masks none', () async {
      final masked = await shipped(
        const InteractionCapture(
          kind: InteractionKind.tap,
          target: target,
          x: 0,
          y: 0,
        ),
        options: const GroundcoverOptions(
          privacy: PrivacyOptions(level: PrivacyLevel.maskAll),
          transport: TransportOptions(batchSize: 0, compression: false),
        ),
      );
      expect(masked['interaction_target.label'], '***');
      final plain = await shipped(
        const InteractionCapture(
          kind: InteractionKind.tap,
          target: target,
          x: 0,
          y: 0,
        ),
      );
      expect(plain['interaction_target.label'], 'Pay now');
    });

    test(
      'an interaction confirms the session, like a presence signal',
      () async {
        final (pipeline, platform) = await started();
        pipeline.submit(
          const InteractionCapture(
            kind: InteractionKind.tap,
            target: target,
            x: 0,
            y: 0,
          ),
        );
        pipeline.submit(const CustomEventCapture('after', {}));
        await drain();
        expect(types(platform), ['interaction', 'custom']);
      },
    );

    test('enabledEvents without interaction drops them', () async {
      final (pipeline, platform) = await started(
        options: const GroundcoverOptions(
          enabledEvents: [RumEventName.logs],
          transport: TransportOptions(batchSize: 0, compression: false),
        ),
      );
      pipeline
        ..presence()
        ..submit(
          const InteractionCapture(kind: InteractionKind.tap, target: target),
        )
        ..submit(const CustomEventCapture('c', {}));
      await drain();
      expect(types(platform), ['custom']);
    });
  });
}

/// A host whose storage can't be reached; the rest is a [FakePlatform]'s.
final class _ThrowingStoragePlatform implements PlatformServices {
  _ThrowingStoragePlatform(this.error);

  final Object error;
  final _fake = FakePlatform();

  @override
  PlatformStorage get storage => throw error;

  @override
  Clock get clock => _fake.clock;

  @override
  BatchSender get sendBatch => _fake.sendBatch;

  @override
  Compressor? get compressor => _fake.compressor;

  @override
  DeviceAttributesProvider get deviceAttributes => _fake.deviceAttributes;

  @override
  NativeCrashStore? get crashStore => null;
}
