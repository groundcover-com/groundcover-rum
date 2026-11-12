import 'dart:math';

import '../common/ids.dart';
import '../common/logger.dart';
import '../common/storage.dart';
import '../common/time.dart';
import 'session_state.dart';

/// Session-level sampling: decided once per session and persisted, so a
/// restart mid-session keeps its verdict. A rate of 1 (or null) samples
/// everything; an explicit 0 samples nothing.
bool resolveSamplingDecision({
  required SafeStorage storage,
  required double? sessionSampleRate,
  Random? random,
}) {
  final rate = sessionSampleRate;
  if (rate == null || !rate.isFinite || rate == 1) return true;
  final stored = storage.getItem(SessionKeys.sampling);
  if (stored != null && stored.isNotEmpty) {
    final decision = stored == '1';
    RumDiagnostics.instance.log(
      '[session-bootstrap] using stored sampling decision:',
      decision,
    );
    return decision;
  }
  final decision = (random ?? Random()).nextDouble() < rate;
  storage.setItem(SessionKeys.sampling, decision ? '1' : '0');
  RumDiagnostics.instance.log(
    '[session-bootstrap] stored new sampling decision:',
    decision,
  );
  return decision;
}

/// Init-time session identity, resolved before the lifecycle arms, so the
/// first event carries a current id.
///
/// 1. A new provided id starts its own cap clock; the same id re-provided is a
///    continuation that keeps the stored start. No id at all mints one.
/// 2. A persisted start is trusted only if positive and not implausibly in the
///    future (a minute absorbs clock skew). Otherwise it is treated as missing.
/// 3. Init-time expiry mirrors the per-event check: a restart is activity too.
void bootstrapSession({
  required SessionState session,
  required IdGenerator idGenerator,
  required Clock clock,
  String? providedSessionId,
}) {
  try {
    final existing = session.getSessionId();
    final provided = providedSessionId;

    if (provided != null && provided.isNotEmpty && provided != existing) {
      session.setSessionId(provided);
      session.setSessionStartTime(msToNs(clock()));
      // A different session: its sampling verdict is re-rolled.
      session.clearSamplingDecision();
      RumDiagnostics.instance.log(
        '[session-bootstrap] using provided sessionId:',
        provided,
      );
    } else if (provided != null && provided.isNotEmpty) {
      session.setSessionId(provided);
      RumDiagnostics.instance.log(
        '[session-bootstrap] continuing provided sessionId:',
        provided,
      );
    } else if (existing.isEmpty) {
      session.setSessionId(idGenerator.generateId());
    }

    const futureSkewToleranceMs = 60000;
    final nowMs = clock();
    final persistedStartMs = nsToMs(session.getSessionStartTime());
    final hasValidStart =
        persistedStartMs > 0 &&
        nowMs - persistedStartMs >= -futureSkewToleranceMs;
    if (!hasValidStart) {
      session.setSessionStartTime(msToNs(nowMs));
    } else if (session.isSessionExpired(nowMs) ||
        session.isSessionInactive(nowMs)) {
      final reason = session.isSessionExpired(nowMs)
          ? 'persisted session past cap'
          : 'inactivity gap across restart';
      final previousId = session.getSessionId();
      final newId = idGenerator.generateId();
      session.setSessionId(newId);
      session.setSessionStartTime(msToNs(nowMs));
      session.clearSamplingDecision();
      RumDiagnostics.instance.log(
        '[session-bootstrap] init-time rotation: $reason',
        {'from': previousId, 'to': newId},
      );
    }
  } catch (error) {
    handleError(error);
  }
}
