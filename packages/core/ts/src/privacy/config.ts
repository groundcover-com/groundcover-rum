import { PrivacyLevel, Redactor, SDKOptions } from "../config/types";

/**
 * Normalized privacy config every listener reads — derived from the unified
 * `privacy` block in one place.
 */
export interface EffectivePrivacy {
  level: PrivacyLevel;
  /** Raw per-stream toggles (already false under `allow`). */
  maskNetworkBodies: boolean;
  maskNetworkQueryParams: boolean;
  maskLogs: boolean;
  maskErrors: boolean;
  // Precomputed `level !== 'allow' && maskX` gates — the single source of truth
  // every listener reads, so the "should I redact?" decision isn't re-derived
  // (and re-drifted) inline per listener.
  shouldMaskNetworkBodies: boolean;
  shouldMaskNetworkQueryParams: boolean;
  shouldMaskLogs: boolean;
  shouldMaskErrors: boolean;
  /** User `privacy.sensitiveKeys` (merged with built-in patterns at match time). */
  sensitiveKeys: string[];
  /** Per-leaf custom redaction hook for captured events. */
  redact?: Redactor;
  /**
   * Platform-supplied predicate for host objects redaction never walks into
   * (see RedactOptions.isOpaqueNode). Not a user option — injected by the
   * platform through its ConfigExtension.
   */
  isOpaqueNode?: (value: unknown) => boolean;
}
// NOTE: platform-specific masking surfaces (UI-element selectors, session
// recording masking) are deliberately NOT part of EffectivePrivacy — each
// platform package resolves its own extension of this.

// The public API is typed, but JS callers can pass anything — normalize
// defensively so a bad value can't crash downstream (.toLowerCase(), etc.).
// Exported: platform packages reuse this to normalize their own list-typed
// privacy extensions (e.g. a list of element selectors).
export function normalizeStringList(values?: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function normalizeLevel(level: unknown): PrivacyLevel | undefined {
  return level === "mask-sensitive" || level === "mask-all" || level === "allow"
    ? level
    : undefined;
}

/**
 * Resolve effective privacy from the user-provided options. Defaults to
 * `'mask-sensitive'` when no explicit `privacy.level` is set.
 */
export function resolvePrivacy(
  rawUserOptions?: Partial<SDKOptions>
): EffectivePrivacy {
  const privacy = rawUserOptions?.privacy;

  // Explicit `privacy.level` wins; otherwise mask sensitive input by default.
  const level: PrivacyLevel = normalizeLevel(privacy?.level) ?? "mask-sensitive";

  const isAllow = level === "allow";

  const orDefaultOn = (value: boolean | undefined): boolean =>
    isAllow ? false : value ?? true;

  const maskNetworkBodies = orDefaultOn(privacy?.maskNetworkBodies);
  const maskNetworkQueryParams = orDefaultOn(privacy?.maskNetworkQueryParams);
  const maskLogs = orDefaultOn(privacy?.maskLogs);
  const maskErrors = orDefaultOn(privacy?.maskErrors);

  return {
    level,
    maskNetworkBodies,
    maskNetworkQueryParams,
    maskLogs,
    maskErrors,
    // `maskX` is already false under allow, but compute the gate explicitly so
    // listeners never re-derive `!allow && maskX` themselves.
    shouldMaskNetworkBodies: !isAllow && maskNetworkBodies,
    shouldMaskNetworkQueryParams: !isAllow && maskNetworkQueryParams,
    shouldMaskLogs: !isAllow && maskLogs,
    shouldMaskErrors: !isAllow && maskErrors,
    sensitiveKeys: normalizeStringList(privacy?.sensitiveKeys),
    redact: typeof privacy?.redact === "function" ? privacy.redact : undefined,
  };
}
