import { SDKConfigInput } from "./types";
import { ConfigExtension, SDKConfig } from "./sdk-config";
import { EffectivePrivacy, resolvePrivacy } from "../privacy/config";
import { Logger } from "../common/logger";

// Configuration only: holds the SDKConfig, memoizes resolved privacy, and
// applies runtime updates. Session identity/activity state lives in
// SessionState (@/session/session-state), so "config" stays configuration.
export class ConfigManager {
  private config: SDKConfig | null = null;
  private logger: Logger = Logger.getInstance();
  // Resolved privacy is read on every captured event. Memoize and
  // invalidate only when config changes (updateConfig). Session rotation does
  // not touch privacy, so it cannot stale this.
  private privacyCache: EffectivePrivacy | null = null;

  // The platform's option-schema additions (see ConfigExtension), applied to
  // the config this manager builds.
  constructor(private readonly extension: ConfigExtension = {}) {}

  initialize(input?: SDKConfigInput) {
    if (this.config) {
      return;
    }

    this.config = new SDKConfig(input, this.extension);
  }

  getConfig() {
    if (!this.config) {
      this.logger.log("[config-manager] configuration not initialized");
      return null;
    }

    return this.config;
  }

  // Normalized privacy config derived from the unified `privacy` options.
  // Memoized; invalidated by updateConfig.
  getPrivacy(): EffectivePrivacy {
    if (!this.privacyCache) {
      const privacy = resolvePrivacy(this.config?.providedOptions);
      if (this.extension.isOpaqueNode) privacy.isOpaqueNode = this.extension.isOpaqueNode;
      this.privacyCache = privacy;
    }
    return this.privacyCache;
  }

  updateConfig(updates: Partial<SDKConfig>) {
    this.logger.log("[config-manager] updateConfig called");

    if (!this.config) {
      this.logger.log("[config-manager] configuration not initialized");
      return;
    }

    if (updates) {
      this.logger.log("[config-manager] updating options");
      // SDKConfig.updateConfig is the single source of truth for merging every
      // field, `user` included — don't re-merge it here.
      this.config.updateConfig(updates);
      // Privacy may have changed — drop the memo so getPrivacy re-resolves.
      this.privacyCache = null;
    }
  }
}
