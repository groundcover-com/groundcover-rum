/// Thrown by `GroundcoverRum.init` when the SDK can't start: an invalid
/// config, a call off the root isolate, or a start that failed.
final class GroundcoverInitException implements Exception {
  const GroundcoverInitException(this.message, [this.cause]);

  final String message;

  /// What the start failed on, when it was an error.
  final Object? cause;

  @override
  String toString() => cause == null
      ? 'GroundcoverInitException: $message'
      : 'GroundcoverInitException: $message ($cause)';
}
