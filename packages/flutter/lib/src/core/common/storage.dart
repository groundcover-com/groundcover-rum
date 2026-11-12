import 'logger.dart';

/// The storage a host provides. Synchronous by design: session state is read
/// while the pipeline is built and on hot paths. A host whose backend is
/// asynchronous hydrates a synchronous cache before the pipeline starts.
abstract interface class PlatformStorage {
  String? getItem(String key);
  void setItem(String key, String value);
  void removeItem(String key);
}

/// A [PlatformStorage] that never throws. Storage fails in normal operation
/// (full disk, a broken backend): reads degrade to null or a fallback, and
/// writes are dropped, never surfaced to the host app.
final class SafeStorage {
  const SafeStorage(this._storage);

  final PlatformStorage? _storage;

  String? getItem(String key) {
    try {
      return _storage?.getItem(key);
    } catch (error) {
      handleError(error);
      return null;
    }
  }

  void setItem(String key, String value) {
    try {
      _storage?.setItem(key, value);
    } catch (error) {
      handleError(error);
    }
  }

  void removeItem(String key) {
    try {
      _storage?.removeItem(key);
    } catch (error) {
      handleError(error);
    }
  }

  /// The stored value as a number, or [fallback] when it is missing or not a
  /// finite number.
  num getNumericItem(String key, {num fallback = 0}) {
    final raw = getItem(key);
    if (raw == null) return fallback;
    final parsed = num.tryParse(raw.trim());
    return parsed != null && parsed.isFinite ? parsed : fallback;
  }
}
