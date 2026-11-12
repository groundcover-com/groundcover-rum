// Port of packages/core/ts/src/common/{text,id-generator,storage,global}.test.ts
// and events/event-time behaviour.
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/common/ids.dart';
import 'package:groundcover_rum/src/core/common/storage.dart';
import 'package:groundcover_rum/src/core/common/text.dart';
import 'package:groundcover_rum/src/core/common/time.dart';
import 'package:groundcover_rum/src/core/events/event_time.dart';
import 'package:groundcover_rum/src/core/events/rum_event.dart';

final class MapStorage implements PlatformStorage {
  final values = <String, String>{};
  bool throwing = false;

  void _check() {
    if (throwing) throw StateError('storage unavailable');
  }

  @override
  String? getItem(String key) {
    _check();
    return values[key];
  }

  @override
  void setItem(String key, String value) {
    _check();
    values[key] = value;
  }

  @override
  void removeItem(String key) {
    _check();
    values.remove(key);
  }
}

void main() {
  group('truncate', () {
    test('null becomes empty; other values are stringified first', () {
      expect(truncate(null), '');
      expect(truncate(''), '');
      expect(truncate(0), '0');
      expect(truncate(false), 'false');
      expect(truncate(12345, maxLength: 3), '123');
    });

    test('keeps text within the limit, cuts and marks text beyond it', () {
      expect(truncate('abc', maxLength: 3), 'abc');
      expect(truncate('abcd', maxLength: 3), 'abc');
      expect(truncate('abcd', maxLength: 3, ellipsis: '…'), 'abc…');
      expect(truncate('abc', maxLength: 3, ellipsis: '…'), 'abc');
      expect(truncate('x' * 10001).length, 10000);
      expect(truncate('abc', maxLength: 0), '');
    });
  });

  test('normalizeWhitespace collapses runs and trims', () {
    expect(normalizeWhitespace('  a \n\t b  '), 'a b');
    expect(normalizeWhitespace(null), '');
  });

  group('RandomIdGenerator', () {
    final ids = RandomIdGenerator();
    final hex = RegExp(r'^[0-9a-f]+$');

    test('ids are 32, span ids 16, trace ids 32 lowercase hex', () {
      expect(ids.generateId(), allOf(hasLength(32), matches(hex)));
      expect(ids.generateSpanId(), allOf(hasLength(16), matches(hex)));
      expect(ids.generateTraceId(), allOf(hasLength(32), matches(hex)));
    });

    test('every hex digit turns up, in every position', () {
      final seen = List.generate(32, (_) => <String>{});
      for (var i = 0; i < 2000; i++) {
        final id = ids.generateId();
        for (var p = 0; p < 32; p++) {
          seen[p].add(id[p]);
        }
      }
      expect(seen.every((digits) => digits.length == 16), isTrue);
    });

    test('trace ids keep the upper 64 bits zero', () {
      for (var i = 0; i < 20; i++) {
        expect(ids.generateTraceId().substring(0, 16), '0' * 16);
      }
    });

    test('ids do not repeat', () {
      expect({
        for (var i = 0; i < 1000; i++) ids.generateId(),
      }, hasLength(1000));
      expect({
        for (var i = 0; i < 1000; i++) ids.generateSpanId(),
      }, hasLength(1000));
    });
  });

  group('SafeStorage', () {
    test('round-trips through the backend', () {
      final backend = MapStorage();
      final storage = SafeStorage(backend);
      storage.setItem('k', 'v');
      expect(storage.getItem('k'), 'v');
      storage.removeItem('k');
      expect(storage.getItem('k'), isNull);
    });

    test('never throws when the backend does', () {
      final storage = SafeStorage(MapStorage()..throwing = true);
      expect(storage.getItem('k'), isNull);
      storage.setItem('k', 'v');
      storage.removeItem('k');
      expect(storage.getNumericItem('k', fallback: 7), 7);
    });

    test('getNumericItem parses numbers and falls back otherwise', () {
      final backend = MapStorage()
        ..values.addAll({
          'int': '42',
          'dec': '1.5',
          'nan': 'abc',
          'inf': 'Infinity',
        });
      final storage = SafeStorage(backend);
      expect(storage.getNumericItem('int'), 42);
      expect(storage.getNumericItem('dec'), 1.5);
      expect(storage.getNumericItem('nan', fallback: 3), 3);
      expect(storage.getNumericItem('inf', fallback: 3), 3);
      expect(storage.getNumericItem('missing'), 0);
    });

    test('a null backend is a silent no-op', () {
      const storage = SafeStorage(null);
      storage.setItem('k', 'v');
      expect(storage.getItem('k'), isNull);
      expect(storage.getNumericItem('k', fallback: 5), 5);
    });
  });

  test('ms and ns convert exactly, as 64-bit integers', () {
    expect(msToNs(1800000000000), 1800000000000000000);
    expect(nsToMs(1800000000000000000), 1800000000000);
    expect(nsToMs(msToNs(1234567890123)), 1234567890123);
  });

  group('event time', () {
    const now = 1800000000000000000;
    const window = 3600 * 1000000000;

    test('trusts only (now - window, now]', () {
      expect(isTrustedEventTime(now, now, window), isTrue);
      expect(isTrustedEventTime(now - window + 1, now, window), isTrue);
      expect(isTrustedEventTime(now - window, now, window), isFalse);
      expect(isTrustedEventTime(now + 1, now, window), isFalse);
      expect(isTrustedEventTime(0, now, window), isFalse);
      expect(isTrustedEventTime(null, now, window), isFalse);
      expect(
        isTrustedEventTime(1800000000000, now, window),
        isFalse,
        reason: 'milliseconds read as nanoseconds land in 1970',
      );
    });

    RumEvent event({int? timestamp, int? start}) => RumEvent(
      type: 'x',
      id: 'i',
      spanId: 's',
      timestamp: timestamp,
      startTimestamp: start,
    );

    test('the earliest trusted time reads timestamp and startTimestamp', () {
      expect(
        earliestTrustedEventTime(
          [
            event(timestamp: now - 10),
            event(start: now - 20),
            null,
            event(timestamp: 5),
          ],
          now,
          window,
        ),
        now - 20,
      );
      expect(earliestTrustedEventTime([event()], now, window), isNull);
    });
  });
}
