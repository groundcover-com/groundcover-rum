// Port of packages/core/ts/src/config/{sdk-config,config-manager}.test.ts and
// privacy/config.test.ts. The cases about untyped JS input (null groups,
// prototype pollution, removed options, shared default objects) test
// machinery the typed Dart config does not need, and are left out.
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/config/config_manager.dart';
import 'package:groundcover_rum/src/core/config/constants.dart';
import 'package:groundcover_rum/src/core/config/sdk_config.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/privacy/privacy_config.dart';

GroundcoverConfig input({GroundcoverOptions? options, RumUser? user}) =>
    GroundcoverConfig(
      apiKey: 'key',
      dsn: 'ingest.example',
      cluster: 'cluster',
      environment: 'env',
      appId: 'app',
      user: user,
      options: options,
    );

void main() {
  group('SdkConfig', () {
    test('applies the core defaults', () {
      final o = SdkConfig(input()).options;
      expect(o.sessionSampleRate, 1);
      expect(o.debug, isFalse);
      expect(o.enabledEvents, isEmpty);
      expect(o.sessionMaxDuration, defaultSessionMaxDuration);
      expect(o.tracing.propagationUrls, isEmpty);
      expect(o.tracing.traceIdHeaderName, '');
      expect(o.tracing.origin.name, '');
      expect(
        o.privacy.level,
        isNull,
        reason: 'resolvePrivacy owns the default',
      );
    });

    test('the endpoint gains https:// only when the DSN names no scheme', () {
      expect(SdkConfig(input()).endpoint, 'https://ingest.example');
      final withScheme = SdkConfig(
        const GroundcoverConfig(
          apiKey: 'k',
          dsn: 'http://localhost:9393',
          cluster: 'c',
          environment: 'e',
          appId: 'a',
        ),
      );
      expect(withScheme.endpoint, 'http://localhost:9393');
    });

    group('sessionMaxDuration', () {
      test('keeps a value within 1 minute to 8 hours, both ends included', () {
        for (final d in [
          minSessionMaxDuration,
          const Duration(hours: 6),
          maxSessionMaxDuration,
        ]) {
          final o = SdkConfig(
            input(options: GroundcoverOptions(sessionMaxDuration: d)),
          ).options;
          expect(o.sessionMaxDuration, d);
        }
      });

      test('falls back to 4 hours outside that range', () {
        for (final d in [
          const Duration(seconds: 59),
          const Duration(hours: 9),
          Duration.zero,
        ]) {
          final o = SdkConfig(
            input(options: GroundcoverOptions(sessionMaxDuration: d)),
          ).options;
          expect(o.sessionMaxDuration, defaultSessionMaxDuration, reason: '$d');
        }
      });

      test('is validated on update, and kept when an update omits it or '
          'brings a value out of range', () {
        final config = SdkConfig(
          input(
            options: const GroundcoverOptions(
              sessionMaxDuration: Duration(hours: 2),
            ),
          ),
        );
        config.update(
          const GroundcoverConfigUpdate(
            options: GroundcoverOptionsUpdate(debug: true),
          ),
        );
        expect(config.options.sessionMaxDuration, const Duration(hours: 2));
        config.update(
          const GroundcoverConfigUpdate(
            options: GroundcoverOptionsUpdate(
              sessionMaxDuration: Duration(hours: 12),
            ),
          ),
        );
        // Out of range: the session keeps the cap it runs on, not the
        // default the app never chose.
        expect(config.options.sessionMaxDuration, const Duration(hours: 2));
      });
    });

    group('update', () {
      test('merges a partial tracing.origin and keeps its sibling field', () {
        final config = SdkConfig(
          input(
            options: const GroundcoverOptions(
              tracing: TracingOptions(
                propagationUrls: ['https://a/*'],
                origin: TracingOrigin(name: 'n', value: 'v'),
              ),
            ),
          ),
        );
        config.update(
          const GroundcoverConfigUpdate(
            options: GroundcoverOptionsUpdate(
              tracing: TracingOptions(traceIdHeaderName: 'x-trace'),
            ),
          ),
        );
        final t = config.options.tracing;
        expect(t.propagationUrls, ['https://a/*']);
        expect(t.traceIdHeaderName, 'x-trace');
        expect(t.origin.name, 'n');
      });

      test('replaces lists wholesale', () {
        final config = SdkConfig(
          input(
            options: const GroundcoverOptions(
              tracing: TracingOptions(propagationUrls: ['a', 'b']),
            ),
          ),
        );
        config.update(
          const GroundcoverConfigUpdate(
            options: GroundcoverOptionsUpdate(
              tracing: TracingOptions(propagationUrls: ['c']),
            ),
          ),
        );
        expect(config.options.tracing.propagationUrls, ['c']);
      });

      test('merges a partial privacy update instead of replacing it', () {
        final config = SdkConfig(
          input(
            options: const GroundcoverOptions(
              privacy: PrivacyOptions(
                level: PrivacyLevel.maskAll,
                sensitiveKeys: ['order_id'],
              ),
            ),
          ),
        );
        config.update(
          const GroundcoverConfigUpdate(
            options: GroundcoverOptionsUpdate(
              privacy: PrivacyOptions(maskLogs: false),
            ),
          ),
        );
        expect(config.options.privacy.level, PrivacyLevel.maskAll);
        expect(config.options.privacy.sensitiveKeys, ['order_id']);
        expect(config.options.privacy.maskLogs, isFalse);
      });

      test('keeps the init enabledEvents through an update', () {
        final config = SdkConfig(
          input(
            options: const GroundcoverOptions(
              enabledEvents: [RumEventName.crashes],
            ),
          ),
        );
        config.update(
          const GroundcoverConfigUpdate(
            options: GroundcoverOptionsUpdate(debug: true),
          ),
        );
        expect(config.options.enabledEvents, [RumEventName.crashes]);
        expect(config.options.debug, isTrue);
      });

      test(
        'merges a partial user, keeps it when omitted, clears it on request',
        () {
          final config = SdkConfig(
            input(
              user: const RumUser(id: 'u1', email: 'a@b'),
            ),
          );
          config.update(
            const GroundcoverConfigUpdate(user: RumUser(name: 'Ann')),
          );
          expect(config.user?.id, 'u1');
          expect(config.user?.email, 'a@b');
          expect(config.user?.name, 'Ann');

          config.update(const GroundcoverConfigUpdate(cluster: 'c2'));
          expect(config.user?.id, 'u1');

          config.update(const GroundcoverConfigUpdate(clearUser: true));
          expect(config.user, isNull);
        },
      );

      test('user properties are made JSON once, as they are set', () {
        // Every batch envelope carries them, and every batch is handed to
        // an isolate: an app object would be copied whole each time, and a
        // cycle would fail every batch.
        final loop = <String, Object?>{'a': 1};
        loop['self'] = loop;
        final config = SdkConfig(
          input(
            user: RumUser(
              id: 'u1',
              properties: {'profile': _Profile(), 'loop': loop},
            ),
          ),
        );
        expect(config.user!.properties!['profile'], 'profile #7');
        expect((config.user!.properties!['loop'] as Map)['self'], '[Circular]');

        config.update(
          GroundcoverConfigUpdate(
            user: RumUser(properties: {'since': DateTime.utc(2026)}),
          ),
        );
        expect(config.user!.id, 'u1');
        expect(config.user!.properties, {'since': '2026-01-01 00:00:00.000Z'});
      });

      test(
        'changes identity fields only when they are given and non-empty',
        () {
          final config = SdkConfig(input());
          config.update(
            const GroundcoverConfigUpdate(
              dsn: 'other.example',
              environment: '',
              releaseId: 'abc123',
            ),
          );
          expect(config.dsn, 'other.example');
          expect(config.environment, 'env');
          expect(config.releaseId, 'abc123');
          expect(config.cluster, 'cluster');
        },
      );
    });
  });

  group('ConfigManager', () {
    test('holds the configuration it was built with, and its updates', () {
      final manager = ConfigManager(input());
      expect(manager.config.appId, 'app');
      manager.update(const GroundcoverConfigUpdate(cluster: 'c2'));
      expect(manager.config.cluster, 'c2');
    });

    test('re-resolves privacy after an update', () {
      final manager = ConfigManager(input());
      expect(manager.privacy.level, PrivacyLevel.maskSensitive);
      expect(identical(manager.privacy, manager.privacy), isTrue);
      manager.update(
        const GroundcoverConfigUpdate(
          options: GroundcoverOptionsUpdate(
            privacy: PrivacyOptions(level: PrivacyLevel.allow),
          ),
        ),
      );
      expect(manager.privacy.level, PrivacyLevel.allow);
    });
  });

  group('resolvePrivacy', () {
    test('defaults to mask-sensitive with every toggle on', () {
      final p = resolvePrivacy(null);
      expect(p.level, PrivacyLevel.maskSensitive);
      expect(p.shouldMaskNetworkBodies, isTrue);
      expect(p.shouldMaskNetworkQueryParams, isTrue);
      expect(p.shouldMaskLogs, isTrue);
      expect(p.shouldMaskErrors, isTrue);
      expect(p.maskInteractionLabels, isFalse);
    });

    test('turns every toggle off under allow, even when set on', () {
      final p = resolvePrivacy(
        const PrivacyOptions(level: PrivacyLevel.allow, maskLogs: true),
      );
      expect(p.maskLogs, isFalse);
      expect(p.shouldMaskLogs, isFalse);
      expect(p.shouldMaskNetworkBodies, isFalse);
    });

    test('lets each toggle be overridden on its own', () {
      final p = resolvePrivacy(const PrivacyOptions(maskNetworkBodies: false));
      expect(p.shouldMaskNetworkBodies, isFalse);
      expect(p.shouldMaskNetworkQueryParams, isTrue);
    });

    test('masks interaction labels under mask-all, or when asked to', () {
      expect(
        resolvePrivacy(
          const PrivacyOptions(level: PrivacyLevel.maskAll),
        ).maskInteractionLabels,
        isTrue,
      );
      // As RN: mask-all can't be talked out of masking labels.
      expect(
        resolvePrivacy(
          const PrivacyOptions(
            level: PrivacyLevel.maskAll,
            maskInteractionLabels: false,
          ),
        ).maskInteractionLabels,
        isTrue,
      );
      expect(
        resolvePrivacy(
          const PrivacyOptions(maskInteractionLabels: true),
        ).maskInteractionLabels,
        isTrue,
      );
    });

    test('carries trimmed, non-blank sensitiveKeys and the redact hook', () {
      Object? hook(RedactField f) => null;
      final p = resolvePrivacy(
        PrivacyOptions(
          sensitiveKeys: const [' order_id ', '', '  '],
          redact: hook,
        ),
      );
      expect(p.sensitiveKeys, ['order_id']);
      expect(p.redact, same(hook));
    });
  });
}

final class _Profile {
  @override
  String toString() => 'profile #7';
}
