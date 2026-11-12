// Takes the options as stored by SDKConfig — core-typed, so `privacy` reaches
// here without the browser's replay fields declared — and narrows the replay
// masking surface structurally: the typeof guards below are the real validation.
import { PrivacyLevel } from "@groundcover/rum-core/config/types";
import { normalizeStringList } from "@groundcover/rum-core/privacy/config";
import { PrivacyOptions, ReplayMaskingOptions } from "@/config/types";

// rrweb-specific masking options, resolved from the unified `privacy` block.
// Browser-only by design: session replay is a browser feature, so its masking
// surface (CSS selectors, HTMLElement callbacks) lives outside the
// platform-agnostic EffectivePrivacy that every other listener reads.
// Computed at record() time — rrweb fixes these options when recording
// starts, and the restart-on-change path re-resolves them.
export interface ReplayMasking {
  /** rrweb `maskTextSelector` (undefined if nothing should be masked). */
  maskTextSelector?: string;
  /** rrweb `maskAllInputs` — kept ON for both mask levels (see below). */
  maskAllInputs: boolean;
  /** User `maskTextFn` pass-through. */
  maskTextFn?: (text: string, el: HTMLElement | null) => string;
  /** User `maskInputFn` pass-through. */
  maskInputFn?: (text: string, el: HTMLElement) => string;
}

function normalizeLevel(level: unknown): PrivacyLevel | undefined {
  return level === "mask-sensitive" || level === "mask-all" || level === "allow"
    ? level
    : undefined;
}

export function resolveReplayMasking(
  rawUserOptions?: { privacy?: PrivacyOptions }
): ReplayMasking {
  const privacy = rawUserOptions?.privacy;
  const level: PrivacyLevel = normalizeLevel(privacy?.level) ?? "mask-sensitive";
  const isAllow = level === "allow";

  const maskSelectors = normalizeStringList(privacy?.maskSelectors);
  const replay = privacy?.replay as Partial<ReplayMaskingOptions> | undefined;
  // Guarded: a non-function here would reach rrweb and crash replay recording.
  const maskTextFn =
    typeof replay?.maskTextFn === "function" ? replay.maskTextFn : undefined;
  const maskInputFn =
    typeof replay?.maskInputFn === "function" ? replay.maskInputFn : undefined;
  const hasMaskTextFn = maskTextFn !== undefined;

  // rrweb maskTextSelector: 'mask-all' masks all text ("*"); 'mask-sensitive'
  // masks text under data-private subtrees + explicitly-listed selectors;
  // 'allow' masks nothing. rrweb evaluates this ancestor-aware (closest), so a
  // data-private wrapper masks its descendant text too — matching the DOM
  // stream's shouldMaskElement. rrweb only invokes maskTextFn on text matched by
  // maskTextSelector, so when the user supplies maskTextFn (and isn't opting
  // out) we select all text with "*" — otherwise their callback would never fire.
  let maskTextSelector: string | undefined;
  if (level === "mask-all" || (!isAllow && hasMaskTextFn)) {
    maskTextSelector = ["*", ...maskSelectors].join(", ");
  } else if (level === "mask-sensitive") {
    // "*" (mask-all) already covers data-private; only mask-sensitive needs it
    // listed explicitly alongside any user selectors.
    maskTextSelector = ["[data-private]", ...maskSelectors].join(", ");
  } else {
    maskTextSelector = undefined;
  }

  return {
    maskTextSelector,
    // Kept ON for both mask levels so rrweb invokes the selective maskInputFn
    // gate for every input; actual per-input masking is decided by element
    // sensitivity (see privacy/element), not by this flag. False only under
    // 'allow'.
    maskAllInputs: !isAllow,
    maskTextFn,
    maskInputFn,
  };
}
