// The app's own callbacks, run inside the SDK: beforeSend, enrichEvent, the
// redact hook, and the error handlers the SDK passes errors on to.

var _depth = 0;

/// Whether one of the app's hooks is running. What it prints, and what it
/// sends through the SDK's API, is a side effect of the SDK sending or
/// reporting something, so both are left out (logs.dart, runtime.dart):
/// sent, it would go through the same hook again, or restate an error
/// already reported.
bool get inUserHook => _depth > 0;

/// Runs one of the app's hooks.
T runUserHook<T>(T Function() hook) {
  _depth++;
  try {
    return hook();
  } finally {
    _depth--;
  }
}
