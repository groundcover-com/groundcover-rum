import { handleError } from "../common/error-handler";
import { Redactor, RedactField, RedactKind } from "../config/types";
import type { EffectivePrivacy } from "./config";

// Single source of truth for sensitive-data patterns and redaction helpers,
// shared by every listener that captures network, log, error or UI data.

export const REDACTED = "[REDACTED]";

/** Header names always redacted, matched case-insensitively in full. */
export const SENSITIVE_HEADER_NAMES = ["authorization", "cookie", "set-cookie"];

// Header NAMES are matched against a broader pattern than body/query keys: these
// headers are always stripped, regardless of any flag, and the pattern keeps the
// bare `key` substring (x-functions-key, x-api-key, …).
export const SENSITIVE_HEADER_REGEX = /(token|key|secret|passwd|password|auth|bearer|credential)/i;

// Substrings marking a key as sensitive. Kept specific to avoid over-redacting
// (a bare `card`/`session` would hit `cardinality`/`session_id`).
export const SENSITIVE_KEY_REGEX =
  /(token|secret|passwd|password|api[_-]?key|access[_-]?key|write[_-]?key|auth|bearer|credential|cvv|ssn|credit[_-]?card|card[_-]?number)/i;

// Query-param / form-field names that are sensitive on their own but too
// generic for the substring regex (`code`/`state` would hit `zipcode`/
// `statename`). Matched ONLY as whole query/form keys — never inside JSON
// bodies, where `code`/`state` legitimately mean HTTP status / UI state.
// Covers the OAuth authorization-code callback (?code=…&state=…).
export const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  "code",
  "state",
  "session_state",
  "id_token",
  "access_token",
  "refresh_token",
  "token",
]);

// Depth bound so a deeply-nested payload can't blow the stack; values beyond it
// are redacted (not passed through) so nothing below the limit leaks.
const MAX_DEPTH = 8;
// Above this length, skip the JSON parse+walk+re-stringify path for a single-pass
// text scrub so a multi-megabyte body can't stall the main thread.
const MAX_BODY_PARSE_LENGTH = 100_000;

/** A primitive leaf value (what the redact visitor receives / returns). */
type Leaf = string | number | boolean | null;

/** Options threaded through every redaction entry point. */
export interface RedactOptions {
  /** Extra case-insensitive sensitive key substrings (merged with built-ins). */
  sensitiveKeys?: string[];
  /** Per-leaf custom redaction hook (see {@link Redactor}). */
  redact?: Redactor;
  /** The event surface, stamped on each {@link RedactField} passed to `redact`. */
  kind?: RedactKind;
  /**
   * Platform-supplied predicate for host objects the walk must never descend
   * into (their graphs are huge or cyclic through cross-edges back-edge-only
   * cycle detection can't bound). A match is redacted wholesale.
   */
  isOpaqueNode?: (value: unknown) => boolean;
}

// A throwing predicate fails closed: the value is treated as opaque (redacted)
// rather than walked or allowed to abort the event.
function isOpaque(opts: RedactOptions, value: object): boolean {
  if (!opts.isOpaqueNode) return false;
  try {
    return opts.isOpaqueNode(value);
  } catch {
    return true;
  }
}

export function isSensitiveKey(key: string, extra?: string[]): boolean {
  if (!key) return false;
  if (SENSITIVE_KEY_REGEX.test(key)) return true;
  if (extra?.length) {
    const lowerKey = key.toLowerCase();
    return extra.some(
      (pattern) => pattern && lowerKey.includes(pattern.toLowerCase())
    );
  }
  return false;
}

// Sensitivity for a query-param / form-field key: substring rules PLUS the
// exact-match generic names (code/state/…) that only apply to query/form keys.
function isSensitiveQueryParam(key: string, extra?: string[]): boolean {
  return (
    SENSITIVE_QUERY_PARAM_NAMES.has(key.toLowerCase()) ||
    isSensitiveKey(key, extra)
  );
}

// Header-style name detection for FREE-TEXT scrubbing. The broad header regex is
// a substring match — correct for real header names (which contain a hyphen:
// x-functions-key, set-cookie) but far too broad for plain prose, where it would
// redact `auth: success` / `API key: …`. Gate it on a hyphen so only header-like
// keys trigger it; plain words fall back to the tighter isSensitiveKey list.
function isHeaderNameKey(key: string): boolean {
  return key.includes("-") && SENSITIVE_HEADER_REGEX.test(key);
}

function isSensitiveTextKey(key: string, extra?: string[]): boolean {
  return isSensitiveKey(key, extra) || isHeaderNameKey(key);
}

function isSensitiveFormTextKey(key: string, extra?: string[]): boolean {
  return isSensitiveQueryParam(key, extra) || isHeaderNameKey(key);
}

// Resolve a single leaf: built-in default is `sensitive ? REDACTED : value`; a
// custom redact hook may override it, but returning `undefined` (or throwing)
// defers to the default so one hook can't silently disable masking elsewhere.
function applyLeaf(field: RedactField, redact?: Redactor): Leaf {
  const fallback: Leaf = field.sensitive ? REDACTED : field.value;
  if (!redact) return fallback;
  try {
    const out = redact(field);
    return out === undefined ? fallback : out;
  } catch (error) {
    handleError(error);
    return fallback;
  }
}

export function redactHeaders(
  headers: Record<string, string>,
  opts: RedactOptions = {}
): Record<string, string> {
  if (!headers) return headers;

  return Object.entries(headers).reduce((acc, [key, value]) => {
    const lowerKey = key.toLowerCase();
    const sensitive =
      SENSITIVE_HEADER_NAMES.includes(lowerKey) ||
      SENSITIVE_HEADER_REGEX.test(lowerKey) ||
      isSensitiveKey(key, opts.sensitiveKeys);
    const out = applyLeaf(
      { key, value, path: [key], kind: "header", sensitive },
      opts.redact
    );
    acc[key] = out === null ? "" : String(out);
    return acc;
  }, {} as Record<string, string>);
}

/** Redact sensitive values in a `key=value&...` query string (no leading `?`); preserves order/duplicates. */
export function redactQueryString(search: string, opts: RedactOptions = {}): string {
  if (!search) return search;
  try {
    // Rebuild pair-by-pair (rather than a parse-and-set, which collapses
    // repeated keys) so order and duplicate params are preserved.
    return search
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq === -1) return pair;
        const rawKey = pair.slice(0, eq);
        const rawVal = pair.slice(eq + 1);
        let key = rawKey;
        try {
          key = decodeURIComponent(rawKey);
        } catch {
          // keep raw key for matching if it isn't valid percent-encoding
        }
        let value = rawVal;
        try {
          value = decodeURIComponent(rawVal);
        } catch {
          // keep raw value if not valid percent-encoding
        }
        const sensitive = isSensitiveQueryParam(key, opts.sensitiveKeys);
        const out = applyLeaf(
          { key, value, path: [key], kind: opts.kind ?? "query", sensitive },
          opts.redact
        );
        // Unchanged → keep the original pair verbatim (no decode/re-encode drift).
        if (out === value) return pair;
        return `${rawKey}=${encodeURIComponent(out === null ? "" : String(out))}`;
      })
      .join("&");
  } catch {
    return search;
  }
}

// Strip userinfo (`user:pass@`) from a URL's authority so embedded basic-auth
// credentials never ship in a captured URL. Only matches an absolute URL's
// authority (anchored after `scheme://`, before the first `/?#`), so an `@` in
// a path/query (e.g. `?email=a@b.com`) is untouched.
function redactUserinfo(url: string): string {
  return url.replace(
    /^([a-zA-Z][\w+.-]*:\/\/)[^/?#@]*@/,
    (_m, scheme) => `${scheme}${REDACTED}@`
  );
}

// Redact sensitive query params in a single `path?query` segment (no fragment).
function redactUrlSegment(segment: string, opts: RedactOptions): string {
  const queryIndex = segment.indexOf("?");
  if (queryIndex === -1) return segment;
  return `${segment.slice(0, queryIndex)}?${redactQueryString(
    segment.slice(queryIndex + 1),
    opts
  )}`;
}

/**
 * Redact sensitive query params in a full or relative URL — including a query
 * string that lives inside the fragment (e.g. `…#/reset?token=…`, a
 * fragment-routed path) — and strip any embedded userinfo credentials.
 */
export function redactUrl(url: string, opts: RedactOptions = {}): string {
  if (!url) return url;
  const queryOpts = { ...opts, kind: opts.kind ?? "query" };

  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  // The fragment may itself be a routed path carrying its own query string.
  const fragment = hashIndex === -1 ? "" : url.slice(hashIndex + 1);

  const safeBase = redactUrlSegment(redactUserinfo(beforeHash), queryOpts);
  if (hashIndex === -1) return safeBase;
  return `${safeBase}#${redactUrlSegment(fragment, queryOpts)}`;
}

// Walk a parsed value, redacting leaves. Containers are recursed (never passed
// to the hook); a sensitive KEY whose value is an object redacts the whole
// subtree without descending (so the hook never sees its leaves).
function redactValueAt(
  key: string,
  value: unknown,
  path: string[],
  opts: RedactOptions,
  depth: number,
  seen: WeakSet<object>
): unknown {
  const sensitive = key ? isSensitiveKey(key, opts.sensitiveKeys) : false;

  if (value !== null && typeof value === "object") {
    // Sensitive key → redact subtree wholesale; past the depth cap → redact so
    // nothing below the limit leaks.
    if (sensitive || depth > MAX_DEPTH) return REDACTED;
    // Platform host objects whose cross-edges blow up the walk — never
    // descend into them (mirrors formatEventObject).
    if (isOpaque(opts, value)) return REDACTED;
    // Stack-based cycle guard (mirrors formatEventObject): mark on enter, unmark
    // in `finally`. Only true back-edges (real cycles) are redacted — a value
    // legitimately shared across sibling keys/array items is still walked.
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    // Defensive: a throwing getter / hostile Proxy in user-supplied metadata
    // must not propagate (it would drop the whole event). Fail closed.
    try {
      if (Array.isArray(value)) {
        // Items inherit the array's key/path; length/shape preserved.
        return value.map((item) =>
          redactValueAt(key, item, path, opts, depth + 1, seen)
        );
      }
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = redactValueAt(k, v, [...path, k], opts, depth + 1, seen);
      }
      return result;
    } catch (error) {
      handleError(error);
      return REDACTED;
    } finally {
      seen.delete(value);
    }
  }

  return applyLeaf(
    { key, value: value as Leaf, path, kind: opts.kind ?? "log", sensitive },
    opts.redact
  );
}

/**
 * Free-text scrub for non-JSON strings (log/error messages, form bodies):
 * redacts the value in sensitive `key=value` / `key: value` / `"key":"value"`
 * pairs, then hands the whole (original) string to a custom redact hook once
 * (`key: ""`). Never throws.
 */
export function redactText(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;

  // Circuit breaker (mirrors redactBody's MAX_BODY_PARSE_LENGTH cap): on a very
  // large string, scrub only the head and drop the tail (fail-closed) so a
  // multi-megabyte log/error message can't stall the main thread with three
  // full-string regex scans. The downstream truncate would drop the tail anyway.
  if (text.length > MAX_BODY_PARSE_LENGTH) {
    return `${redactText(text.slice(0, MAX_BODY_PARSE_LENGTH), opts)}…`;
  }

  let out = text;
  try {
    // Key groups are length-bounded ({1,64}) so a long run of word chars can't
    // trigger catastrophic backtracking on large inputs (keys are short).
    // `"key":"value"` and `"key": value` (JSON-ish embedded in free text)
    out = out.replace(
      /"([\w.-]{1,64})"\s*:\s*("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/g,
      (match, key) =>
        isSensitiveTextKey(key, opts.sensitiveKeys) ? `"${key}":"${REDACTED}"` : match
    );
    // `key=value` (query / form encoded): value ends at the next pair separator.
    // `?` is also a separator so an embedded query (`next=/p?token=secret`) is
    // split — otherwise the greedy value would swallow `token=secret` whole and
    // leave it unredacted under the non-sensitive outer key.
    out = out.replace(
      /([\w.-]{1,64})=([^\s&,;?]+)/g,
      (match, key) =>
        isSensitiveFormTextKey(key, opts.sensitiveKeys) ? `${key}=${REDACTED}` : match
    );
    // `key: value` (headers / plain text): value can contain spaces, so redact
    // through the end of the segment (one line, stopping at `,`/`;`/`&`).
    out = out.replace(
      /([\w.-]{1,64}):[ \t]*([^\n,;&]{1,4096})/g,
      (match, key) =>
        isSensitiveTextKey(key, opts.sensitiveKeys) ? `${key}: ${REDACTED}` : match
    );
  } catch (error) {
    handleError(error);
    out = text;
  }

  // Unstructured field: the visitor sees the whole ORIGINAL string once. Match
  // applyLeaf's semantics — any non-undefined primitive overrides the built-in
  // scrub (null → "", number/boolean → its string form); undefined defers to it.
  if (opts.redact) {
    try {
      const result = opts.redact({
        key: "",
        value: text,
        path: [],
        kind: opts.kind ?? "log",
        sensitive: false,
      });
      if (result !== undefined) return result === null ? "" : String(result);
    } catch (error) {
      handleError(error);
    }
  }
  return out;
}

/**
 * Redact a (already-stringified) request/response body: try JSON deep-redaction,
 * then form-encoded, then a free-text scrub. Never throws.
 */
export function redactBody(body: string, opts: RedactOptions = {}): string {
  if (!body) return body;

  // Try structured JSON — but only for bounded inputs, so an oversized body
  // can't trigger an expensive synchronous parse + deep walk on the main
  // thread. Larger bodies fall through to the single-pass text scrub below.
  const trimmed = body.trim();
  if (
    trimmed.length <= MAX_BODY_PARSE_LENGTH &&
    (trimmed.startsWith("{") || trimmed.startsWith("["))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(redactValueAt("", parsed, [], opts, 0, new WeakSet()));
    } catch {
      // fall through
    }
  }

  // Form-encoded `a=b&c=d` with no JSON braces.
  if (body.includes("=") && !body.includes("{")) {
    return redactQueryString(body, opts);
  }

  // Anything else (free text, partial JSON).
  return redactText(body, opts);
}

/**
 * Deep redaction for a structured attributes object (e.g. log attributes, error
 * metadata). Returns a new object; never mutates the input.
 */
export function redactObject(
  obj: Record<string, unknown>,
  opts: RedactOptions = {}
): Record<string, unknown> {
  try {
    const result = redactValueAt("", obj, [], opts, 0, new WeakSet());
    // Guarantee an object shape: callers spread `...safeAttributes`, so the
    // fail-closed sentinel (a string) for a hostile or opaque top-level object
    // would otherwise spread into {0:'[',1:'R',…}.
    return result !== null && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  } catch (error) {
    // Fail closed: never throw out of redaction (drops the event) and never
    // emit the un-redacted input.
    handleError(error);
    return {};
  }
}

/**
 * Caller-supplied navigation metadata as it may be sent: key-redacted while
 * masking is on, untouched under 'allow'. Arbitrary structured data has no
 * dedicated toggle, so it is always redacted while masking — tying it to the
 * URL flag would be wrong.
 */
export function redactMetadata<T extends Record<string, unknown> | undefined>(
  metadata: T,
  privacy: EffectivePrivacy
): T {
  if (privacy.level === "allow" || !metadata) return metadata;
  return redactObject(metadata, {
    sensitiveKeys: privacy.sensitiveKeys,
    redact: privacy.redact,
    isOpaqueNode: privacy.isOpaqueNode,
  }) as T;
}

/**
 * Apply log-surface redaction (free-text `message` + structured `attributes`) in
 * one place, so the console-capture listener and the explicit `groundcover.logger.*`
 * path follow the same contract. No-op when `shouldMaskLogs` is off.
 */
export function redactLogFields(
  privacy: {
    shouldMaskLogs: boolean;
    sensitiveKeys?: string[];
    redact?: Redactor;
    isOpaqueNode?: (value: unknown) => boolean;
  },
  message: string,
  attributes?: Record<string, unknown>
): { message: string; attributes?: Record<string, unknown> } {
  if (!privacy.shouldMaskLogs) return { message, attributes };
  const opts: RedactOptions = {
    sensitiveKeys: privacy.sensitiveKeys,
    redact: privacy.redact,
    kind: "log",
    isOpaqueNode: privacy.isOpaqueNode,
  };
  return {
    message: redactText(message, opts),
    attributes: attributes ? redactObject(attributes, opts) : attributes,
  };
}
