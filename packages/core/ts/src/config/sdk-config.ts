import { SDKConfigInput, SDKOptions } from "./types";
import {
  DEFAULT_SDK_CONFIG_OPTIONS,
  DEFAULT_SESSION_MAX_DURATION_MS,
  MIN_SESSION_MAX_DURATION_MS,
  MAX_SESSION_MAX_DURATION_MS,
} from "./constants";
import { UserIdentifiers } from "../events/types";
import { safeWarn } from "../common/safe-warn";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A platform's additions to the option schema core merges and validates. Core
 * owns the groups every platform shares; a platform declares its own feature
 * slots here instead of core naming them.
 */
export interface ConfigExtension {
  /**
   * Option groups that merge one level deep on a partial update, each with the
   * sub-objects merged one level deeper so a partial update keeps their
   * siblings. Unioned with core's own groups — naming a core group here adds
   * sub-keys to it.
   */
  nestedOptions?: Readonly<Record<string, readonly string[]>>;
  /** Defaults for the platform's own option slots, applied under the caller's options. */
  defaults?: Readonly<Record<string, unknown>>;
  /**
   * Options the platform has removed: the key is stripped from the stored
   * config (never reinterpreted) and its message is warned when it is passed.
   */
  removedOptions?: Readonly<Record<string, string>>;
  /**
   * Host objects privacy redaction must treat as opaque — never walked,
   * redacted wholesale. Surfaced on EffectivePrivacy for every redaction site.
   */
  isOpaqueNode?: (value: unknown) => boolean;
}

// The groups core itself owns. `tracing.origin` is `{name,value}`, so it merges
// one level deeper. The config struct is small and fixed, so the merge is
// spelled out explicitly rather than handled by a generic recursive merge.
const CORE_NESTED_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  privacy: [],
  tracing: ["origin"],
  transport: [],
};

interface ResolvedExtension {
  nestedOptions: Readonly<Record<string, readonly string[]>>;
  removedOptions: Readonly<Record<string, string>>;
}

// Per-instance schema, held OUTSIDE the class so SDKConfig's public shape stays
// exactly its config fields: private members would make the class nominal, and
// platform tests build structural SDKConfig fakes.
const schemas = new WeakMap<SDKConfig, ResolvedExtension>();
const CORE_SCHEMA: ResolvedExtension = { nestedOptions: CORE_NESTED_OPTIONS, removedOptions: {} };

function schemaOf(config: SDKConfig): ResolvedExtension {
  return schemas.get(config) ?? CORE_SCHEMA;
}

// Removed options are ignored, never reinterpreted: mapping them would change
// privacy or sampling behavior without the caller's explicit choice.
//
// Delete removed keys from a merged options object so the stored
// config never carries fields the migration path says are gone (they would be
// inert, but exposing them is misleading). Pairs with warnRemovedOptions.
function stripRemovedOptions(
  options: Partial<SDKOptions>,
  removedOptions: Readonly<Record<string, string>>
): void {
  const raw = options as Record<string, unknown>;
  for (const key of Object.keys(removedOptions)) {
    if (Object.hasOwn(raw, key)) {
      delete raw[key];
    }
  }
}

function warnRemovedOptions(
  options: Partial<SDKOptions> | undefined,
  removedOptions: Readonly<Record<string, string>>
): void {
  if (!options || typeof options !== "object") return;
  const raw = options as Record<string, unknown>;
  for (const [key, message] of Object.entries(removedOptions)) {
    // Own-property check: an inherited key was never actually passed.
    if (Object.hasOwn(raw, key)) {
      safeWarn(message);
    }
  }
}

function resolveNestedOptions(
  extension: ConfigExtension
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, string[]> = {};
  for (const source of [CORE_NESTED_OPTIONS, extension.nestedOptions ?? {}]) {
    for (const [group, subkeys] of Object.entries(source)) {
      out[group] = [...new Set([...(out[group] ?? []), ...subkeys])];
    }
  }
  return out;
}

// Copy a nested option group so the result never ALIASES the base's object.
// `base` is the module-level defaults on a fresh config, and ConfigManager is
// not a singleton — without this, every SDKConfig instance would share the
// same default group objects, so one in-place mutation would leak across
// instances. Shallow at the group level plus its known deep sub-objects,
// matching how deep the merge itself goes.
function cloneGroup(value: unknown, deepSubkeys: readonly string[]): unknown {
  if (!isPlainObject(value)) return value;
  const copy: Record<string, unknown> = { ...value };
  for (const deepSubkey of deepSubkeys) {
    if (isPlainObject(copy[deepSubkey])) {
      copy[deepSubkey] = { ...(copy[deepSubkey] as Record<string, unknown>) };
    }
  }
  return copy;
}

// Merge one option group over its base: a one-level spread, plus a one-level
// merge of each known deep sub-object so a partial update keeps that
// sub-object's siblings. Arrays/functions/scalars replace wholesale.
function mergeGroup(
  base: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  deepSubkeys: readonly string[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...incoming };
  for (const deepSubkey of deepSubkeys) {
    const baseSub = base?.[deepSubkey];
    const incSub = incoming[deepSubkey];
    if (isPlainObject(baseSub) && isPlainObject(incSub)) {
      merged[deepSubkey] = { ...baseSub, ...incSub };
    } else if (Object.hasOwn(incoming, deepSubkey) && !isPlainObject(incSub)) {
      // Present but null / non-object — keep the base sub-object instead of
      // letting the top-level spread wipe its siblings.
      merged[deepSubkey] = isPlainObject(baseSub) ? { ...baseSub } : baseSub;
    } else if (isPlainObject(merged[deepSubkey])) {
      // Came straight off the base spread — clone so it isn't shared.
      merged[deepSubkey] = { ...(merged[deepSubkey] as Record<string, unknown>) };
    }
  }
  return merged;
}

// Merge `incoming` options over `base`. Top-level keys and each nested group
// merge one level deep; each group's deep sub-objects merge one deeper.
// Pollution-safe by construction: values are combined with object spread (which
// defines own properties and never invokes the `__proto__` setter), and the
// only bracket-assigned keys are the declared group names — never caller input.
function mergeOptions(
  base: Partial<SDKOptions>,
  incoming: Partial<SDKOptions>,
  nestedOptions: Readonly<Record<string, readonly string[]>>
): Partial<SDKOptions> {
  const merged: Record<string, unknown> = { ...base, ...incoming };
  const inc = incoming as Record<string, unknown>;
  const baseRec = base as Record<string, unknown>;
  for (const [key, deepSubkeys] of Object.entries(nestedOptions)) {
    // Own-property only: an inherited group (e.g. from a polluted prototype) was
    // never passed by the caller and must not override defaults. The top-level
    // spread already ignored it (spread copies own keys only).
    if (!Object.hasOwn(inc, key)) {
      // Not provided: the top-level spread left a REFERENCE to base[key]. Clone
      // it (only when there's actually a group there, so an absent key stays
      // absent rather than becoming an own `undefined`).
      if (isPlainObject(baseRec[key])) {
        merged[key] = cloneGroup(baseRec[key], deepSubkeys);
      }
      continue;
    }
    const incGroup = inc[key];
    if (isPlainObject(incGroup)) {
      merged[key] = mergeGroup(
        baseRec[key] as Record<string, unknown> | undefined,
        incGroup,
        deepSubkeys
      );
    } else {
      // Own but null / non-object (untyped JS caller) → keep the default group
      // instead of letting the top-level spread wipe it.
      merged[key] = cloneGroup(baseRec[key], deepSubkeys);
    }
  }
  return merged as Partial<SDKOptions>;
}

export class SDKConfig {
  dsn: string;
  appId: string;
  cluster: string;
  environment: string;
  namespace?: string;
  releaseId?: string;
  apiKey: string;
  user: Partial<UserIdentifiers> | null;
  options: Partial<SDKOptions>;
  // Raw, pre-defaults user options — lets resolvePrivacy tell an explicit
  // `privacy.level` from an omitted one. Optional for test mocks; the
  // constructor always sets it.
  providedOptions?: Partial<SDKOptions>;

  constructor(input?: SDKConfigInput, extension: ConfigExtension = {}) {
    const schema: ResolvedExtension = {
      nestedOptions: resolveNestedOptions(extension),
      removedOptions: extension.removedOptions ?? {},
    };
    schemas.set(this, schema);
    const { nestedOptions, removedOptions } = schema;
    const defaults = mergeOptions(
      DEFAULT_SDK_CONFIG_OPTIONS,
      (extension.defaults ?? {}) as Partial<SDKOptions>,
      nestedOptions
    );
    this.dsn = input?.dsn || "";
    this.appId = input?.appId || "";
    this.cluster = input?.cluster || "";
    this.apiKey = input?.apiKey || "";
    this.environment = input?.environment || "";
    this.namespace = input?.namespace || "";
    this.releaseId = input?.releaseId;
    this.user = input?.user || null;
    this.providedOptions = { ...(input?.options || {}) };
    this.options = mergeOptions(defaults, input?.options || {}, nestedOptions);
    this.options.sessionMaxDuration = SDKConfig.normalizeSessionMaxDuration(
      input?.options?.sessionMaxDuration
    );
    warnRemovedOptions(input?.options, removedOptions);
    stripRemovedOptions(this.providedOptions, removedOptions);
    stripRemovedOptions(this.options, removedOptions);
  }

  private static normalizeSessionMaxDuration(value: unknown): number {
    // Only `undefined` (the documented "omit" case) silently uses the default.
    // `null` and every other bad input goes through the warn branch — the
    // public type is `?: number` so anything else is unsupported.
    if (value === undefined) return DEFAULT_SESSION_MAX_DURATION_MS;
    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || value < MIN_SESSION_MAX_DURATION_MS
      || value > MAX_SESSION_MAX_DURATION_MS
    ) {
      safeWarn(
        `[groundcover] sessionMaxDuration must be a finite number between ${MIN_SESSION_MAX_DURATION_MS} ms (1 minute) and ${MAX_SESSION_MAX_DURATION_MS} ms (8 hours); falling back to the 4-hour default`
      );
      return DEFAULT_SESSION_MAX_DURATION_MS;
    }
    return value;
  }

  getEndpoint(): string {
    return this.dsn?.startsWith("http") ? this.dsn : `https://${this.dsn}`;
  }

  updateConfig(updates: Partial<SDKConfig>) {
    if (updates.options) {
      const { nestedOptions, removedOptions } = schemaOf(this);
      warnRemovedOptions(updates.options, removedOptions);
      // Nested groups merge one level deep so a partial update merges in rather
      // than replacing the whole group — and, for providedOptions, so the
      // explicit-vs-default distinction used by resolvePrivacy survives runtime
      // updates.
      this.providedOptions = mergeOptions(
        this.providedOptions || {},
        updates.options,
        nestedOptions
      );
      this.options = mergeOptions(this.options, updates.options, nestedOptions);
      if (updates.options.sessionMaxDuration !== undefined) {
        this.options.sessionMaxDuration = SDKConfig.normalizeSessionMaxDuration(
          updates.options.sessionMaxDuration
        );
      }
      stripRemovedOptions(this.providedOptions, removedOptions);
      stripRemovedOptions(this.options, removedOptions);
    }

    // Distinguish an omitted user (no change) from an explicit `null` (clear
    // identity) — the type allows `null`, so honor it instead of silently
    // ignoring it. An object merges into the current identity.
    if (updates.user !== undefined) {
      this.user = updates.user === null
        ? null
        : { ...this.user, ...updates.user };
    }

    if (updates.appId) {
      this.appId = updates.appId;
    }

    if (updates.dsn) {
      this.dsn = updates.dsn;
    }

    if (updates.apiKey) {
      this.apiKey = updates.apiKey;
    }

    if (updates.cluster) {
      this.cluster = updates.cluster;
    }

    if (updates.environment) {
      this.environment = updates.environment;
    }

    if (updates.namespace) {
      this.namespace = updates.namespace;
    }

    if (updates.releaseId) {
      this.releaseId = updates.releaseId;
    }
  }
}
