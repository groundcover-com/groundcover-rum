import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CallbackEvent, RedactField, SDKConfigInput } from "@groundcover/react-native";

import { E2E_PRESET } from "./e2e-preset";
import {
  DEVICE_PROPAGATION_URLS,
  resolveIngest,
  resolvePreset,
  trim,
  type PresetName,
} from "./config-env";

// Every SDK config the e2e suite needs, keyed by preset name. One config per
// behaviour that can only be chosen at init() — sampling verdicts, privacy
// levels, the beforeSend/enrichEvent callbacks and `enabledEvents` — none of
// which `updateConfig` can change (and two of which it deliberately refuses to
// type).
//
// Plus ONE preset that is not for the e2e suite at all: `device`, for a real phone against a
// real cluster. See its case in `configFor` for why it cannot just be `default`.

// The preset vocabulary and the two decisions that can be silently wrong on a device live in
// `config-env.ts` — unit-testable because it imports no react-native. Re-exported here so
// the whole preset vocabulary is reachable from this module.
export type { PresetName } from "./config-env";
export { PRESET_NAMES } from "./config-env";

/** The label an event must carry to be dropped by the `callbacks` preset. */
export const DROP_MARKER = "DROPME";
/** Attribute the `callbacks` preset's enrichEvent stamps on every event. */
export const ENRICH_KEY = "e2e_enriched";
export const ENRICH_VALUE = "by-enrich-event";
/** What the `custom-redact` preset's hook substitutes for an `email` leaf. */
export const CUSTOM_REDACTION = "e2e-custom-redaction";

// Every `process.env.EXPO_PUBLIC_*` read in this file is a STATIC member access, and has to be:
// babel-preset-expo inlines these by matching that exact source shape at transform time. A
// dynamic `process.env[name]` is not matched and reads back `undefined` on device — so a helper
// taking the variable's NAME would leave every one of these silently empty, with the config
// falling back to its defaults and nothing anywhere saying so.
function baseConfig(preset: string): SDKConfigInput {
  const ingest = resolveIngest(
    preset,
    process.env.EXPO_PUBLIC_GC_DSN,
    process.env.EXPO_PUBLIC_GC_API_KEY
  );
  return {
    dsn: ingest.dsn,
    apiKey: ingest.apiKey,
    appId: "rn-playground",
    cluster: "playground",
    environment: "dev",
    // Overridable so two device builds can be told apart. Without it every APK you
    // ever install reports the same release, and "did the fix land?" becomes
    // unanswerable from the data.
    releaseId: trim(process.env.EXPO_PUBLIC_GC_RELEASE_ID) || "1.0.0",
    // Provide AsyncStorage explicitly so session state persists across restarts.
    // The app resolves the peer from its own node_modules; in this pnpm workspace
    // the bundler can't resolve the SDK's own optional require of it, so injection
    // is the reliable path (see SDKConfigInput.storage).
    storage: AsyncStorage,
    options: {
      debug: true,
      // RN/OkHttp strips the request Content-Encoding header, so a gzipped batch
      // reaches the ingest unlabeled and can't be decoded. Send plain JSON.
      // batchTimeout: flush fast so the e2e specs don't wait out the 10s default.
      transport: { compression: false, batchTimeout: 500 },
      // Send trace headers to everything so the echo replays them back.
      tracing: { propagationUrls: ["*"] },
      native: {
        // Well below Android's 5s default so the hang spec can drive one without
        // waiting out a real ANR (and without the system killing the app first).
        hangThresholdMs: 1_000,
        // The PRODUCTION default, restated so it cannot drift out from under the
        // vitals specs. A frame segment must close only on a navigation or on
        // backgrounding during a test — a short cap would fire `safety` segments
        // mid-assertion and make every attribution test racy. The `vitals-fast`
        // preset is where a short cap is wanted.
        vitalsMaxSegmentMs: 60_000,
      },
    },
  };
}

// Deep-merges would hide mistakes here (a typo'd nested key silently keeping the
// default), so each preset states the block it replaces outright.
export function configFor(preset: string): SDKConfigInput {
  const config = baseConfig(preset);
  const options = config.options!;

  switch (preset as PresetName) {
    case "device":
      // The only preset for a REAL phone against a REAL cluster, and it exists because every
      // other preset here is tuned for the mock ingest in ways that are actively wrong on a
      // device — not merely suboptimal:
      //   batchTimeout 500ms  → a network request every half second, off a battery
      //   propagationUrls "*" → traceparent injected into requests to THIRD-PARTY hosts
      //   hangThresholdMs 1s  → ordinary one-second stalls reported as hangs
      //   debug: true         → a console.log per event, on the JS thread we are measuring
      //
      // The `native` block is dropped entirely, on purpose: the point of a device run is to
      // exercise the SHIPPING defaults (Android's 5s hang threshold, the 60s segment cap), and
      // an override here would mean testing the playground's settings instead of the product's.
      config.environment = "device-test";
      config.options = {
        // Compression stays off, and NOT as a mock-ingest concession: RN/OkHttp strips the
        // request Content-Encoding header, so a gzipped batch reaches a real cluster unlabeled
        // and cannot be decoded. Turning this on ships data nothing can read.
        transport: { compression: false },
        // Scoped to the hosts the Network tab actually calls, as full-URL globs — the SDK
        // anchors each pattern `^…$` against the whole URL, so a bare host matches nothing and
        // no request would carry a `traceparent`. "*" is the other wrong end: it would inject
        // trace headers into every request the app makes, third parties included. See
        // DEVICE_PROPAGATION_URLS / DEVICE_TRACE_TARGETS.
        tracing: { propagationUrls: DEVICE_PROPAGATION_URLS },
        // Off by default because the logging itself perturbs the frame timings a device run is
        // there to measure. Set EXPO_PUBLIC_GC_DEBUG=1 in `.env` to answer "is anything being
        // sent at all?" over `adb logcat` — there is no Metro console in a release build.
        debug: trim(process.env.EXPO_PUBLIC_GC_DEBUG) === "1",
        // The SDK does not special-case the Metro dev server, so a DEBUG device build (where
        // Metro is present, unlike release where `scriptURL` is a file:// path) captures its
        // `POST /symbolicate` traffic as spans — with application source in the bodies. Matched by
        // port because the dev server is localhost under `adb reverse`, the host LAN IP for the iOS
        // simulator, and 10.0.2.2 for a bare emulator: three spellings, all on 8081.
        excludedUrls: ["*:8081/*", "*/symbolicate*"],
      };
      return config;

    case "unsampled":
      // An explicit 0 — NOT undefined, which core reads as "no sampling
      // configured" and folds into sample-everything.
      options.sessionSampleRate = 0;
      return config;

    case "mask-all":
      options.privacy = { level: "mask-all" };
      return config;

    case "allow":
      options.privacy = { level: "allow" };
      return config;

    case "no-body-mask":
      options.privacy = { maskNetworkBodies: false };
      return config;

    case "custom-redact":
      options.privacy = {
        // `order_id` is benign to the built-in rules; naming it here is what
        // proves the extra keys are consulted at all.
        sensitiveKeys: ["order_id"],
        // Overrides one leaf and DEFERS everywhere else by returning undefined —
        // the contract that stops a custom hook from disabling masking wholesale.
        redact: (field: RedactField) =>
          field.key === "email" ? CUSTOM_REDACTION : undefined,
      };
      return config;

    case "callbacks":
      options.beforeSend = (event: CallbackEvent) => {
        // Attributes arrive DOT-FLATTENED (see CallbackEvent) — bracket keys, not
        // `event.attributes.interaction_target.label`, which does not exist at
        // runtime and would throw here and drop every event.
        const label = String(event.attributes["interaction_target.label"] ?? "");
        return !label.includes(DROP_MARKER);
      };
      options.enrichEvent = (event: CallbackEvent) => {
        event.attributes[ENRICH_KEY] = ENRICH_VALUE;
        return event;
      };
      return config;

    case "callbacks-throw":
      // The blast-radius case: a host callback that throws must not take the
      // event stream down with it.
      options.beforeSend = () => {
        throw new Error("e2e beforeSend throws on purpose");
      };
      return config;

    case "crashes-only":
      options.enabledEvents = ["crashes"];
      return config;

    case "tti-manual":
      options.native = { ...options.native, tti: "manual" };
      return config;

    case "slow-flush":
      // The background-flush claim is untestable at the default 500ms batch
      // timeout: everything queued flushes on its own before a spec can press
      // HOME, so the assertion would pass with the AppState handler deleted. A
      // 60s timer means the ONLY thing that can deliver within the test is the
      // backgrounding itself.
      options.transport = { compression: false, batchTimeout: 60_000 };
      return config;

    case "hang-sampling":
      // The one preset that can catch a watchdog which SAMPLES for stalls rather than measuring
      // them; the default cannot.
      //
      // A sampling watchdog detects a stall of D at threshold H with probability
      // `(D - H) / (H + poll)`, and is certain only above `2H + poll`. At the default here —
      // H = 1s, D = 3s — that ratio is already past the certain bound, so the hang spec would pass
      // every time against a sampling watchdog: the parameters, not the assertions, would hide it.
      //
      // H = 2s against the same 3s stall leaves a sampling watchdog a real chance to miss each
      // trial, so a spec that repeats the stall fails one with near-certainty while a measuring
      // watchdog reports every trial. Do not raise this without recomputing that margin.
      options.native = { ...options.native, hangThresholdMs: 2_000 };
      return config;

    case "vitals-fast":
      // The ONLY preset with a short segment cap. The `safety` close is
      // otherwise unreachable in a test: at the 60s production default a spec
      // would have to dwell on one screen for a minute to see one.
      options.native = { ...options.native, vitalsMaxSegmentMs: 2_000 };
      return config;

    case "default":
    default:
      return config;
  }
}

export const ACTIVE_PRESET: string = resolvePreset(
  process.env.EXPO_PUBLIC_GC_PRESET,
  E2E_PRESET
);

// ---------------------------------------------------------------------------
// Debug hooks for session-lifecycle specs. Rotation is driven by the PERSISTED anchors, so
// backdating one is the on-device equivalent of the browser suite's mocked clock, driving the
// same values `bootstrapSession` reads on a real launch. The keys mirror core's SessionState
// under HydratedStorage's `@groundcover:` prefix and are read at bootstrap, so a spec must
// RELAUNCH after calling these — which is exactly the production scenario.
// ---------------------------------------------------------------------------

const KEY_PREFIX = "@groundcover:";

/** Backdate the activity clock past SESSION_INACTIVITY_TIMEOUT_MS (30 min). */
export async function backdateLastActivity(byMs = 31 * 60 * 1000): Promise<void> {
  await AsyncStorage.setItem(`${KEY_PREFIX}gcLastActivity`, String(Date.now() - byMs));
}

/** Backdate the session start past the default 4h cap. */
export async function backdateSessionStart(byMs = 5 * 60 * 60 * 1000): Promise<void> {
  await AsyncStorage.setItem(`${KEY_PREFIX}gcStartTime`, String(Date.now() - byMs));
}

export async function readPersistedSessionId(): Promise<string> {
  return (await AsyncStorage.getItem(`${KEY_PREFIX}gcId`)) ?? "";
}

/**
 * Forget every persisted SDK key: session id, start time, activity clock, sampling verdict.
 * This is what makes a NEVER-CONFIRMED session reachable on device — the presence gate is a
 * property of the session and the session survives a relaunch, so a plain relaunch reattaches
 * to one an earlier test confirmed and ships immediately. The browser suite gets this free
 * from a fresh context per test.
 */
export async function clearSdkStorage(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const ours = keys.filter((key) => key.startsWith(KEY_PREFIX));
  if (ours.length) await AsyncStorage.multiRemove(ours);
}
