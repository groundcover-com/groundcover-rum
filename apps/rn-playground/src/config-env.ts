/**
 * How the app decides WHICH config to boot on and WHERE to send events — separated from
 * `config-presets.ts` for one reason: that module imports AsyncStorage and cannot be loaded
 * outside a React Native runtime, so nothing in it is reachable from a unit test.
 *
 * These two decisions are the ones that can be silently WRONG on a phone. A misresolved
 * preset or a defaulted DSN produces an app that launches, runs, reports no error and
 * measures nothing — so they live here, as pure functions over their inputs, the same way
 * `GCRumHangRules` and `GcRumFrameAggregator` are kept apart from their plumbing.
 *
 * Deliberately free of react-native imports. Adding one puts this out of a unit test's reach.
 */

export type PresetName =
  | "default"
  | "unsampled"
  | "mask-all"
  | "allow"
  | "no-body-mask"
  | "custom-redact"
  | "callbacks"
  | "callbacks-throw"
  | "crashes-only"
  | "tti-manual"
  | "slow-flush"
  | "vitals-fast"
  | "hang-sampling"
  | "device";

export const PRESET_NAMES: PresetName[] = [
  "default",
  "unsampled",
  "mask-all",
  "allow",
  "no-body-mask",
  "custom-redact",
  "callbacks",
  "callbacks-throw",
  "crashes-only",
  "tti-manual",
  "slow-flush",
  "vitals-fast",
  "hang-sampling",
  "device",
];

export const trim = (value: string | undefined) => (value ?? "").trim();

/** Mock-ingest fallbacks, so a fresh checkout with no `.env` still boots. */
export const MOCK_DSN = "localhost:9999";
export const MOCK_API_KEY = "dev-key";

/**
 * The URLs a `device` build actually calls that must carry a `traceparent` (the two hosts
 * NetworkScreen hits for a full request+response span), and the propagation patterns that have
 * to cover them — kept in one place because a mismatch between them is invisible until you
 * inspect a stored request.
 *
 * The SDK matches each pattern as `^<pattern, every * widened to .*>$` against the FULL request
 * URL (`network-events-listener.ts` → `shouldAddTraceHeader`). So a bare host like `"httpbin.org"`
 * compiles to `^httpbin.org$`, matches no real URL, and every request ships WITHOUT a trace
 * header — no error, no dropped span, just no `traceparent` anywhere. Patterns must be globs that
 * bracket the whole URL, and `matchesPropagationUrl` below (a mirror of that SDK method) is what
 * the unit test uses to prove every target is covered without a running RN runtime.
 */
export const DEVICE_TRACE_TARGETS = {
  echo: "https://httpbin.org/anything",
  classic: "https://jsonplaceholder.typicode.com/posts",
} as const;

// Anchored past the host with a trailing `/`, which stops a SUFFIX lookalike
// (`httpbin.org.evil.example`) — after the host the pattern needs a literal `/`, and the lookalike
// has more host there. It is not a strict host match: the SDK widens only `*` and does NOT escape
// the other regex metacharacters, so the `.` in `httpbin.org` matches any character and a
// single-glyph substitution (`httpbinXorg`) still matches. That looseness is inherited from
// production's `shouldAddTraceHeader`, which this must mirror — and it is harmless here because the
// app only ever calls the two literal DEVICE_TRACE_TARGETS, never a lookalike.
export const DEVICE_PROPAGATION_URLS = [
  "https://httpbin.org/*",
  "https://jsonplaceholder.typicode.com/*",
];

/**
 * Mirror of the SDK's `shouldAddTraceHeader` match, faithful for the absolute https targets
 * above (its relative-path branch never applies to them). Kept in lockstep with that method: if
 * the SDK's matching changes, this must change with it.
 */
export function matchesPropagationUrl(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(url));
}

/**
 * Which preset the app boots on.
 *
 * The env var wins so a real-cluster build can select `device` from a gitignored `.env`
 * without editing `e2e-preset.ts` — a tracked file the e2e harness rewrites and restores per
 * spec, which a build-time edit would race. The e2e app scripts pass an EMPTY
 * `EXPO_PUBLIC_GC_PRESET`, which Expo's loader lets win over `.env`, so a developer's device
 * `.env` cannot hijack a suite run.
 *
 * An unrecognised name THROWS rather than falling back to `default`. A typo that silently
 * boots the mock-ingest config is the exact failure this module exists to prevent, and on a
 * phone it is invisible: the app looks healthy and the only symptom is data you never see.
 */
export function resolvePreset(fromEnv: string | undefined, compiledIn: string): string {
  const requested = trim(fromEnv);
  if (!requested) return compiledIn;
  if (!(PRESET_NAMES as string[]).includes(requested)) {
    throw new Error(
      `EXPO_PUBLIC_GC_PRESET="${requested}" is not a known preset. ` +
        `Known presets: ${PRESET_NAMES.join(", ")}`
    );
  }
  return requested;
}

/**
 * Where events go, and the one place a build is allowed to refuse to boot.
 *
 * Every e2e preset falls back to the mock ingest, on purpose. `device` must not: its whole
 * purpose is a real cluster, and the fallback would leave a phone posting to its own
 * localhost — which raises no error, drops no events and produces no data. A run that looks
 * successful and measured nothing is worse than one that failed at launch.
 */
export function resolveIngest(
  preset: string,
  dsn: string | undefined,
  apiKey: string | undefined
): { dsn: string; apiKey: string } {
  const host = trim(dsn);
  const key = trim(apiKey);

  if (preset === "device") {
    const missing = [!host && "EXPO_PUBLIC_GC_DSN", !key && "EXPO_PUBLIC_GC_API_KEY"].filter(
      Boolean
    );
    if (missing.length) {
      throw new Error(
        `the "device" preset needs ${missing.join(" and ")} set in apps/rn-playground/.env`
      );
    }
    // The transporter builds `${endpoint}/json/rum` itself, so a DSN carrying the ingest path
    // posts to /json/rum/json/rum. That 404s with no other symptom, and copying the full
    // ingest URL out of a cluster's setup page is the obvious way to arrive here.
    if (/\/json\/rum\/?$/.test(host)) {
      throw new Error(
        `EXPO_PUBLIC_GC_DSN must be the HOST only — the SDK appends /json/rum. Got "${host}".`
      );
    }
  }

  return { dsn: host || MOCK_DSN, apiKey: key || MOCK_API_KEY };
}
