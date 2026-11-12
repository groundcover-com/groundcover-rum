// The patch discipline every interceptor needs, in one place. A Dart
// assignment doesn't throw, so a group of patches needs no rollback.
import 'logger.dart';

/// One host slot the SDK wraps: `FlutterError.onError`, `debugPrint`,
/// `HttpOverrides.global`. [get] and [set] read and write the slot; [wrap]
/// builds the SDK's wrapper around whatever the slot held at install time.
final class PatchSpec<T> {
  const PatchSpec({required this.get, required this.set, required this.wrap});

  final T Function() get;
  final void Function(T value) set;
  final T Function(T original) wrap;
}

/// The wrappers the SDK installed, each with the original it replaced.
///
/// [restore] puts an original back only where the slot still holds the SDK's
/// wrapper: a host that wrapped on top of it keeps its wrapper. Nothing here
/// throws into the host.
final class PatchSet {
  final _undo = <void Function()>[];

  void install<T>(PatchSpec<T> spec) {
    try {
      final original = spec.get();
      final wrapped = spec.wrap(original);
      spec.set(wrapped);
      _undo.add(() {
        if (identical(spec.get(), wrapped)) spec.set(original);
      });
    } catch (error) {
      handleError(error);
    }
  }

  /// Stands every patch down, newest first, where its slot is still ours.
  void restore() {
    // Cleared first: a restore is never retried against slots it handed back.
    final undo = _undo.reversed.toList();
    _undo.clear();
    for (final step in undo) {
      try {
        step();
      } catch (error) {
        handleError(error);
      }
    }
  }

  bool get isEmpty => _undo.isEmpty;
}
