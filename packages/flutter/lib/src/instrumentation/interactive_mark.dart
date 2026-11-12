// When the app became usable: the "I" in TTI.
//
// Process state rather than the runtime's, for RN's reason: a mark can come
// before init completes, and it must record WHEN IT WAS CALLED. Set once: the
// first screen a user reaches is the one TTI is about.

int? _autoMarkMs;
int? _manualMarkMs;
final _subscribers = <void Function()>{};

/// The automatic anchor: the first screen landing. A floor rather than a
/// promise; it comes before that screen's own data loads.
void markAutoInteractive(int nowMs) {
  if (_autoMarkMs != null) return;
  _autoMarkMs = nowMs;
  _notify();
}

/// The app's own word that the first screen is usable.
void markManualInteractive(int nowMs) {
  if (_manualMarkMs != null) return;
  _manualMarkMs = nowMs;
  _notify();
}

/// The mark [manual] or automatic TTI is measured to, if it has landed.
int? interactiveMark({required bool manual}) =>
    manual ? _manualMarkMs : _autoMarkMs;

/// Runs [subscriber] whenever either mark lands. Returns an unsubscribe.
void Function() onInteractiveMark(void Function() subscriber) {
  _subscribers.add(subscriber);
  return () => _subscribers.remove(subscriber);
}

void _notify() {
  for (final subscriber in List.of(_subscribers)) {
    try {
      subscriber();
    } catch (_) {
      // A TTI subscriber must never break whatever set the mark.
    }
  }
}

/// Clears the marks and their subscribers: the testing reset, whose re-init
/// starts afresh, and tests. The marks are process state otherwise.
void resetInteractiveMarks() {
  _autoMarkMs = null;
  _manualMarkMs = null;
  _subscribers.clear();
}
