// The screen every event is stamped with, and the navigation events between
// screens.
import '../../common/time.dart';
import '../../privacy/privacy_config.dart';
import '../../privacy/redaction.dart';
import '../captures.dart';
import '../event_enricher.dart';

/// The screen stamped on events, the automatic tracker's last screen (which a
/// manual navigation does not move), and the manual navigation in progress.
final class NavigationTracker {
  /// The current screen, set before a navigation is built, so the navigation
  /// and everything after it carry it. Empty before the first.
  String screenName = '';
  String screenKey = '';

  String _lastName = '';
  String _lastKey = '';

  /// When the tracker's last screen became current; 0 before the first.
  int _lastChangeMs = 0;

  ({String name, String key, Map<String, Object?>? metadata, int startMs})?
  _manual;

  /// The navigation event [capture] completes at [nowMs], if any.
  EnrichInput? handle(
    NavigationCapture capture,
    int nowMs,
    EffectivePrivacy privacy,
  ) => switch (capture) {
    ScreenCapture() => _onScreen(capture, nowMs, privacy),
    NavigationStartCapture() => _onStart(capture, nowMs),
    NavigationEndCapture() => _onEnd(capture, nowMs, privacy),
  };

  EnrichInput? _onScreen(
    ScreenCapture capture,
    int nowMs,
    EffectivePrivacy privacy,
  ) {
    final ScreenCapture(:name, :key) = capture;
    if (name.isEmpty || (name == _lastName && key == _lastKey)) return null;
    final from = _lastName;
    final fromKey = _lastKey;
    final durationMs = _lastChangeMs == 0 ? 0 : nowMs - _lastChangeMs;
    screenName = _lastName = name;
    screenKey = _lastKey = key;
    _lastChangeMs = nowMs;
    return _navigation(
      privacy,
      from: from,
      fromKey: fromKey,
      durationMs: durationMs,
      startMs: nowMs - durationMs,
      endMs: nowMs,
    );
  }

  EnrichInput? _onStart(NavigationStartCapture capture, int nowMs) {
    final name = capture.screen.trim().isEmpty ? '' : capture.screen;
    final key = capture.key.trim().isEmpty ? '' : capture.key;
    _manual = (
      name: name,
      key: key,
      metadata: capture.metadata,
      startMs: nowMs,
    );
    if (name.isNotEmpty) {
      screenName = name;
      screenKey = key;
    }
    return null;
  }

  EnrichInput? _onEnd(
    NavigationEndCapture capture,
    int nowMs,
    EffectivePrivacy privacy,
  ) {
    final active = _manual;
    _manual = null;
    // A record with no screen name is never shipped.
    if (active == null || active.name.isEmpty) return null;
    screenName = active.name;
    screenKey = active.key;
    return _navigation(
      privacy,
      durationMs: nowMs - active.startMs,
      metadata: {...?active.metadata, ...?capture.metadata},
      startMs: active.startMs,
      endMs: nowMs,
    );
  }

  EnrichInput _navigation(
    EffectivePrivacy privacy, {
    String from = '',
    String fromKey = '',
    required int durationMs,
    Map<String, Object?>? metadata,
    required int startMs,
    required int endMs,
  }) => EnrichInput(
    type: 'navigation',
    attributes: {
      if (from.isNotEmpty) 'from_screen': from,
      if (fromKey.isNotEmpty) 'from_key': fromKey,
      'metadata': ?redactMetadata(metadata, privacy),
      'duration_ms': durationMs,
      'start_timestamp': msToNs(startMs),
      'end_timestamp': msToNs(endMs),
    },
  );
}
