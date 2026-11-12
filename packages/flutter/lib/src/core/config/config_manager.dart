// The pipeline creates one only when it starts, so the configuration is never
// missing.
import '../privacy/privacy_config.dart';
import 'sdk_config.dart';
import 'types.dart';

/// Holds the configuration, memoises the resolved privacy, and applies
/// runtime updates. Session identity lives in SessionState.
final class ConfigManager {
  ConfigManager(GroundcoverConfig input) : config = SdkConfig(input);

  final SdkConfig config;
  EffectivePrivacy? _privacy;

  /// Read on every captured event, so memoised; an update drops the memo.
  EffectivePrivacy get privacy =>
      _privacy ??= resolvePrivacy(config.options.privacy);

  void update(GroundcoverConfigUpdate update) {
    config.update(update);
    _privacy = null;
  }
}
