/// Nanoseconds per millisecond.
const msToNanoseconds = 1000000;

/// Milliseconds since the epoch (e.g. a clock read) to nanoseconds, the wire's
/// unit. Exact 64-bit integers, where a JavaScript number is a double that
/// steps in 256 ns near 1.8e18.
int msToNs(int ms) => ms * msToNanoseconds;

/// Nanoseconds back to milliseconds, rounded down.
int nsToMs(int ns) => ns ~/ msToNanoseconds;

/// [msToNs] for a time with a fractional part, as the native engine reports
/// some (iOS reads its clock as a double). The whole milliseconds convert
/// exactly; only the fraction goes through a double, so the result is off by
/// under a nanosecond rather than by the 256 ns a double steps in at today's
/// epoch.
int fractionalMsToNs(num ms) {
  final whole = ms.floor();
  return msToNs(whole) + ((ms - whole) * msToNanoseconds).round();
}

/// The SDK's clock: epoch milliseconds. Injected everywhere a time is read,
/// so tests run on a fixed one.
typedef Clock = int Function();

int systemClock() => DateTime.now().millisecondsSinceEpoch;
