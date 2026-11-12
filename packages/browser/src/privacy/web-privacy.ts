// The browser's extension of core's EffectivePrivacy: element masking by CSS
// selector. Core resolves the platform-agnostic privacy surface (levels,
// per-stream toggles, sensitive keys, redactor); this module layers the
// browser-only maskSelectors on top for the DOM/replay element-masking gate
// (privacy/element.ts, common/accessibility.ts).
import {
  EffectivePrivacy,
  normalizeStringList,
} from "@groundcover/rum-core/privacy/config";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { PrivacyOptions } from "@/config/types";

export interface WebEffectivePrivacy extends EffectivePrivacy {
  /** Parsed CSS mask selectors (for `element.matches`/`closest`). */
  maskSelectors: string[];
}

export function resolveWebPrivacy(config: ConfigManager): WebEffectivePrivacy {
  // Core's resolution is memoized on the ConfigManager; only the browser
  // extension is derived here (cheap: one normalize over a short list).
  const privacy = config.getPrivacy();
  const rawPrivacy = config.getConfig()?.providedOptions?.privacy as
    | Partial<PrivacyOptions>
    | undefined;

  return {
    ...privacy,
    maskSelectors: normalizeStringList(rawPrivacy?.maskSelectors),
  };
}
