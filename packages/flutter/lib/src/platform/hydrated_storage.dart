import 'dart:async';

import '../core/common/logger.dart';
import '../core/common/storage.dart';
import 'flutter_platform.dart';
import 'rum_api.g.dart';

/// The core's synchronous storage over the plugin's asynchronous native
/// store, the counterpart of RN's HydratedStorage: hydrated once before the
/// pipeline starts, then read from memory, with writes sent behind.
final class HydratedStorage implements PlatformStorage {
  HydratedStorage._(this._api, this._values);

  final RumHostApi _api;
  final Map<String, String> _values;
  Map<String, String?> _pending = {};
  Future<void> _writing = Future<void>.value();

  static Future<HydratedStorage> hydrate(RumHostApi api) async {
    var values = <String, String>{};
    try {
      // Past the timeout, the SDK starts with empty storage (a fresh
      // session) rather than delay the app.
      values = Map.of(await api.loadStorage().timeout(nativeCallTimeout));
    } catch (error) {
      handleError(error);
    }
    return HydratedStorage._(api, values);
  }

  @override
  String? getItem(String key) => _values[key];

  @override
  void setItem(String key, String value) {
    _values[key] = value;
    _queue(key, value);
  }

  @override
  void removeItem(String key) {
    _values.remove(key);
    _queue(key, null);
  }

  // Writes made in one turn of the event loop go to native together, and in
  // order: each batch waits for the one before it.
  void _queue(String key, String? value) {
    final firstInTurn = _pending.isEmpty;
    _pending[key] = value;
    if (!firstInTurn) return;
    _writing = _writing.then((_) async {
      await Future<void>.delayed(Duration.zero);
      final batch = _pending;
      _pending = {};
      try {
        await _api.writeStorage(batch);
      } catch (error) {
        handleError(error);
      }
    });
  }

  /// Completes once every write made so far has settled: native committed
  /// it, or reported that it couldn't and the failure was logged. Each was
  /// chained onto [_writing] when it was made. Nothing retries a failed
  /// write, as in RN.
  Future<void> flushWrites() => _writing;
}
