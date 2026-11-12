import '../config/types.dart';

/// The privacy settings every capture path reads, resolved once from the
/// `privacy` options.
final class EffectivePrivacy {
  const EffectivePrivacy({
    required this.level,
    required this.maskNetworkBodies,
    required this.maskNetworkQueryParams,
    required this.maskLogs,
    required this.maskErrors,
    required this.sensitiveKeys,
    this.redact,
    this.maskInteractionLabels = false,
  });

  final PrivacyLevel level;

  /// The per-surface toggles, already false under [PrivacyLevel.allow].
  final bool maskNetworkBodies;
  final bool maskNetworkQueryParams;
  final bool maskLogs;
  final bool maskErrors;

  final List<String> sensitiveKeys;
  final Redactor? redact;

  /// Mask interaction labels, hints and values. Defaults on only under
  /// [PrivacyLevel.maskAll].
  final bool maskInteractionLabels;

  // The `level != allow && maskX` gates, computed in one place so no capture
  // path re-derives (and re-drifts) them.
  bool get shouldMaskNetworkBodies =>
      level != PrivacyLevel.allow && maskNetworkBodies;
  bool get shouldMaskNetworkQueryParams =>
      level != PrivacyLevel.allow && maskNetworkQueryParams;
  bool get shouldMaskLogs => level != PrivacyLevel.allow && maskLogs;
  bool get shouldMaskErrors => level != PrivacyLevel.allow && maskErrors;
}

/// Trimmed, non-empty strings only.
List<String> normalizeStringList(List<String>? values) => [
  for (final value in values ?? const <String>[])
    if (value.trim().isNotEmpty) value.trim(),
];

/// Effective privacy from the provided options. An omitted level means
/// [PrivacyLevel.maskSensitive], and every per-surface toggle defaults on
/// unless the level is [PrivacyLevel.allow].
EffectivePrivacy resolvePrivacy(PrivacyOptions? privacy) {
  final level = privacy?.level ?? PrivacyLevel.maskSensitive;
  final isAllow = level == PrivacyLevel.allow;
  bool orDefaultOn(bool? value) => isAllow ? false : value ?? true;

  return EffectivePrivacy(
    level: level,
    maskNetworkBodies: orDefaultOn(privacy?.maskNetworkBodies),
    maskNetworkQueryParams: orDefaultOn(privacy?.maskNetworkQueryParams),
    maskLogs: orDefaultOn(privacy?.maskLogs),
    maskErrors: orDefaultOn(privacy?.maskErrors),
    sensitiveKeys: normalizeStringList(privacy?.sensitiveKeys),
    redact: privacy?.redact,
    // As RN: mask-all always masks labels; the toggle only adds masking.
    maskInteractionLabels:
        level == PrivacyLevel.maskAll || privacy?.maskInteractionLabels == true,
  );
}
