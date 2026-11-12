import 'dart:math';
import 'dart:typed_data';

/// Event, span and trace ids, as lowercase hex.
abstract interface class IdGenerator {
  /// 32 hex characters: 16 zeros, then 64 random bits.
  String generateTraceId();

  /// 16 hex characters.
  String generateSpanId();

  /// 32 hex characters.
  String generateId();
}

/// Ids from a secure random source when the platform has one.
final class RandomIdGenerator implements IdGenerator {
  RandomIdGenerator([Random? random]) : _random = random ?? _secureOrDefault();

  final Random _random;

  static Random _secureOrDefault() {
    try {
      return Random.secure();
    } on UnsupportedError {
      return Random();
    }
  }

  static final _hex = '0123456789abcdef'.codeUnits;
  static const _traceIdZeroPrefix = '0000000000000000';

  // One draw per 8 characters, 4 bits each: a secure draw is a native read,
  // and costs more than the formatting.
  String _hexChars(int count) {
    final codes = Uint8List(count);
    for (var i = 0; i < count; i += 8) {
      var bits = _random.nextInt(1 << 32);
      for (var j = i; j < i + 8 && j < count; j++) {
        codes[j] = _hex[bits & 0xf];
        bits >>= 4;
      }
    }
    return String.fromCharCodes(codes);
  }

  @override
  String generateTraceId() => _traceIdZeroPrefix + _hexChars(16);

  @override
  String generateSpanId() => _hexChars(16);

  @override
  String generateId() => _hexChars(32);
}
