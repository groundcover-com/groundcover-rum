import '../core/common/logger.dart';
import '../core/common/storage.dart';
import '../core/common/time.dart';
import '../core/session/session_state.dart';
import '../platform/flutter_platform.dart';
import '../platform/hydrated_storage.dart';
import '../platform/rum_api.g.dart';
import 'runtime.dart';

/// Hooks for an app's tests and for end-to-end harnesses. Not for
/// production code.
///
/// [reset] stops the SDK and undoes everything it installed, for a test that
/// ran `GroundcoverRum.init`.
///
/// The session hooks change the persisted session state that the SDK reads
/// when it starts, so their effect shows on the next launch, exactly as it
/// would in the field, and no harness depends on the SDK's storage keys.
/// Each completes once the write has settled.
///
/// The native hooks ([triggerTestCrash], [blockMainThread]) work in
/// development builds only: a simulator or a provisioned build on iOS, a
/// debuggable app on Android. Anywhere else they do nothing, and they never
/// throw into the caller: with no plugin to answer them (a widget test, a
/// desktop build) they do nothing too.
abstract final class GroundcoverRumTesting {
  // The running SDK's own storage, so it holds the change too; or, before
  // init, native storage directly.
  static Future<HydratedStorage> _storage() async {
    final services = RumRuntime.instance.services;
    return services is FlutterPlatformServices
        ? services.storage
        : await HydratedStorage.hydrate(RumHostApi());
  }

  /// Moves the last-activity time [by] into the past. Past 30 minutes, the
  /// next launch starts a new session.
  static Future<void> backdateLastActivity(Duration by) async {
    final storage = await _storage();
    storage.setItem(
      SessionKeys.lastActivity,
      '${systemClock() - by.inMilliseconds}',
    );
    await storage.flushWrites();
  }

  /// Moves the session start [by] into the past. Past `sessionMaxDuration`,
  /// the next launch starts a new session.
  static Future<void> backdateSessionStart(Duration by) async {
    final storage = await _storage();
    storage.setItem(
      SessionKeys.startTime,
      '${msToNs(systemClock() - by.inMilliseconds)}',
    );
    await storage.flushWrites();
  }

  /// Forgets the persisted session: its id, start, last activity and
  /// sampling verdict. The next launch starts a session that has not yet seen
  /// a user.
  static Future<void> forgetSession() async {
    final storage = await _storage();
    SessionState(storage: SafeStorage(storage)).clearSessionState();
    await storage.flushWrites();
  }

  /// Crashes the app natively: a segmentation fault on iOS, an uncaught
  /// `IllegalStateException` on Android's main thread. [kind] travels in the
  /// Android message. Completes before the crash, which is posted to the
  /// main thread.
  static Future<void> triggerTestCrash([String kind = 'native']) =>
      _quietly(() => RumHostApi().triggerTestCrash(kind));

  /// Blocks the main thread, where Dart runs too, for [duration] and at most
  /// 30 seconds, so the hang watchdog fires. Completes before the block,
  /// which is posted to the main thread.
  static Future<void> blockMainThread(Duration duration) => _quietly(
    () => RumHostApi().blockMainThread(
      duration.inMilliseconds.clamp(0, _maxBlock.inMilliseconds),
    ),
  );

  /// A stall long enough for any hang threshold, never one that outlasts the
  /// system's own watchdogs.
  static const _maxBlock = Duration(seconds: 30);

  static Future<void> _quietly(Future<void> Function() call) async {
    try {
      await call();
    } catch (error) {
      handleError(error);
    }
  }

  /// Stops the SDK and undoes everything it installed, so a widget or
  /// integration test can end cleanly: Flutter's test binding fails a test
  /// that leaves timers running or `debugPrint` replaced. Call it at the end
  /// of a `testWidgets` body: the binding checks before `tearDown` runs. In a
  /// plain `test`, `tearDown` works too. A later `GroundcoverRum.init` starts
  /// afresh.
  static Future<void> reset() async => RumRuntime.instance.reset();
}
