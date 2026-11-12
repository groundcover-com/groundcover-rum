// React Native's extension of core's EffectivePrivacy: interaction-label
// masking. Core resolves the platform-agnostic surface; this layers the RN-only
// option on top, as the browser's resolveWebPrivacy does for maskSelectors.
import type { ConfigManager, EffectivePrivacy } from "@groundcover/rum-core";
import type { PrivacyOptions } from "../config/types";

export interface RNEffectivePrivacy extends EffectivePrivacy {
  /**
   * Mask human-readable interaction fields (label, hint, value text): on under
   * `mask-all`, or when `privacy.maskInteractionLabels` is set.
   */
  maskInteractionLabels: boolean;
}

export function resolveRNPrivacy(config: ConfigManager): RNEffectivePrivacy {
  // Core's resolution is memoized on the ConfigManager; only the RN extension
  // is derived here. Read through the RN option type: core's config is not
  // typed with the platform's options.
  const privacy = config.getPrivacy();
  const rawPrivacy = config.getConfig()?.providedOptions?.privacy as Partial<PrivacyOptions> | undefined;
  return {
    ...privacy,
    maskInteractionLabels: privacy.level === "mask-all" || rawPrivacy?.maskInteractionLabels === true,
  };
}
