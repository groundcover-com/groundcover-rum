// React Native narrowing of the platform-agnostic config types.
//
// Core's config surface is a LEAN BASE. This module re-exports the base and
// adds the RN extensions — its listener-name union, its device/OS/app session
// envelope, its `screen` enrichment, and the tap-label masking knob — so the
// published `@groundcover/react-native` d.ts keeps a precise typed API.
import type {
  PrivacyOptions as CorePrivacyOptions,
  SDKOptions as CoreSDKOptions,
  SDKConfigInput as CoreSDKConfigInput,
  SessionAttributes as CoreSessionAttributes,
  BaseEvent as CoreBaseEvent,
  NetworkEventAttributes,
  LogEventAttributes,
  UserDefinedEventAttributes,
  ErrorEventAttributes,
  PerformanceEventAttributes,
} from "@groundcover/rum-core";
// NavigationEventAttributes is RN-native (screen names, not URLs) — core's
// page_url/from_url shape is a browser-ism the RN wire deliberately doesn't use.
import type {
  InteractionEventAttributes,
  NavigationEventAttributes,
  ScreenAttributes,
} from "../events/rn-event-types";
import type { InjectedAsyncStorage } from "../platform/hydrated-storage";

export type {
  PrivacyLevel,
  RedactKind,
  RedactField,
  Redactor,
  TracingOptions,
  TransportOptions,
} from "@groundcover/rum-core";

export type { InteractionEventAttributes, NavigationEventAttributes, ScreenAttributes };
export type { FrameSegmentReason, FrameVitalsEventAttributes } from "../events/rn-event-types";
export type { AppStartMetricName } from "../events/rn-event-types";

/**
 * The RN session envelope. Core owns session identity and deployment coordinates and
 * leaves device metadata unnamed; this is RN's contribution. `source` is a fixed
 * SDK-family stamp consumers key on to tell mobile from web RUM — the platform lives
 * in `os.name`, a separate dimension. `getRNDeviceAttributes` always supplies
 * `source`/`os`/`device`, so they are REQUIRED here even though core cannot say so.
 */
export type RNSessionAttributes = CoreSessionAttributes & {
  source: "mobile-rum";
  // "other" covers RN's non-mobile hosts (web/macos/windows): the SDK targets
  // ios/android, and a host outside that set is reported honestly rather than
  // mislabeled as one of the two — see getOsAndDevice in rn-platform.ts.
  os: { name: "ios" | "android" | "other"; version: string };
  device: {
    model: string;
    brand: string;
    // Android's `Build.DEVICE` (industrial-design codename, e.g. "o1s" for a Galaxy S21). Absent on
    // iOS, whose model IDENTIFIER (`iPhone15,2`) is already the mapping key. It lets a consumer
    // resolve a marketing name from Google's device catalog, which is keyed on codename + model
    // — `Build.MODEL` alone (`SM-G991B`) is ambiguous across regional variants.
    codename?: string;
    screen: { width: number; height: number; scale: number; fontScale: number };
  };
  app?: { version?: string; build?: string; id?: string };
};

/**
 * The RN event shape: core's `Event` plus the `screen` this platform stamps
 * during enrichment — which is why `beforeSend`/`enrichEvent` are re-declared
 * over THIS map rather than core's.
 */
export type Event<T extends string, A> = Omit<CoreBaseEvent<T>, "attributes"> & {
  type: T;
  // `screen` is REQUIRED: the enricher injects it on every event (screenHolder
  // defaults to an empty screen), so it is always present on the wire.
  attributes: A & { screen: ScreenAttributes };
};

export type EventTypes = {
  interaction: Event<"interaction", InteractionEventAttributes>;
  network: Event<"network", NetworkEventAttributes>;
  log: Event<"log", LogEventAttributes>;
  navigation: Event<"navigation", NavigationEventAttributes>;
  custom: Event<"custom", UserDefinedEventAttributes>;
  exception: Event<"exception", ErrorEventAttributes>;
  // App start, TTI and frame vitals — one event per metric, the same shape the
  // browser uses for web vitals.
  performance: Event<"performance", PerformanceEventAttributes>;
};

/**
 * Attributes as `beforeSend` / `enrichEvent` OBSERVE them at runtime — NOT the nested build shape
 * above, because core's enricher DOT-FLATTENS first, so `interaction_target: { label }` arrives as
 * `"interaction_target.label"`. `screen` is the sole exception, merged after flattening.
 *
 * So read with BRACKET keys. This deliberately does not expose the nested path, which does not
 * exist at runtime and would let a type-correct filter throw and silently drop every event.
 */
export type FlattenedEventAttributes = { [key: string]: unknown; screen: ScreenAttributes };

/**
 * An event as `beforeSend` / `enrichEvent` receive it: `type` still discriminates
 * the RN event kinds and the top-level event fields are intact, but `attributes`
 * is the dot-flattened bag core actually hands the callback (see
 * {@link FlattenedEventAttributes}).
 */
export type CallbackEvent = {
  [K in keyof EventTypes]: Omit<EventTypes[K], "attributes"> & {
    attributes: FlattenedEventAttributes;
  };
}[keyof EventTypes];

/**
 * The RN SDK's listener names for `enabledEvents`.
 *
 * The last four need the native module (a dev build); in Expo Go they simply
 * never arm. They are separate gates rather than one "native" switch so a host
 * can keep crash reporting while opting out of, say, frame vitals.
 */
export type RNEventName =
  | "interaction"
  | "network"
  | "logs"
  | "navigation"
  | "exceptions"
  | "crashes"
  | "hangs"
  | "vitals"
  | "appStart";

export interface PrivacyOptions extends Omit<CorePrivacyOptions, "replay"> {
  /**
   * Mask tap labels (accessibilityLabel / text). Defaults to on only when
   * `level` is `'mask-all'`; role / component path stay (structural).
   */
  maskInteractionLabels?: boolean;
}

export interface SDKOptions
  extends Omit<
    CoreSDKOptions,
    "privacy" | "replay" | "enabledEvents" | "beforeSend" | "enrichEvent"
  > {
  /**
   * Inspect each event before it is queued; return false to drop it. Receives
   * the event with DOT-FLATTENED attributes — see {@link CallbackEvent}.
   */
  beforeSend?: (event: CallbackEvent) => boolean;
  /**
   * Modify each event before it is queued. Receives (and returns) the event with
   * DOT-FLATTENED attributes — see {@link CallbackEvent}.
   */
  enrichEvent?: (event: CallbackEvent) => CallbackEvent;
  /** Which RN listeners to enable. Empty array = all. */
  enabledEvents: RNEventName[];
  /** Unified privacy / data-masking config. ON by default (`level: 'mask-sensitive'`). */
  privacy?: PrivacyOptions;
  /** App version, stamped on session attributes when expo-constants is not present. */
  appVersion?: string;
  /** App build number, stamped on session attributes when expo-constants is not present. */
  appBuild?: string;
  /** Tuning for the native module. Enabling/disabling lives in `enabledEvents`. */
  native?: NativeOptions;
}

/**
 * Knobs for the native features — tuning only. There is exactly one way to turn
 * a feature off (`enabledEvents`), so these never gate capture.
 */
export interface NativeOptions {
  /**
   * How long the main thread must be blocked before a hang is reported. Defaults to 2s on
   * iOS and 5s on Android, deliberately: iOS has no system hang bar, Android's own ANR
   * threshold is 5s. A bare number applies to BOTH platforms — prefer `{ ios, android }`
   * when tuning. Out-of-range or non-finite falls back to the default.
   */
  hangThresholdMs?: number | { ios?: number; android?: number };
  /**
   * Longest a frame-vitals segment may run before it is force-closed; defaults to 60s.
   * Segments normally end on a screen change or backgrounding, so this is a safety valve
   * rather than a cadence — lowering it fragments one screen's stats into partial segments.
   */
  vitalsMaxSegmentMs?: number;
  /**
   * Which moment counts as "interactive" for TTI.
   * - `"auto"` (default): the first screen landing. A floor, not a promise —
   *   it fires before the screen's own data loads.
   * - `"manual"`: whenever the app calls `groundcover.markAppInteractive()`.
   *   The honest measure; call it once the first screen is genuinely usable.
   */
  tti?: "auto" | "manual";
}

export interface SDKConfigInput extends Omit<CoreSDKConfigInput, "options"> {
  options?: Partial<SDKOptions>;
  /**
   * AsyncStorage for session persistence across restarts — pass the package's default
   * export. Optional: the SDK auto-requires the peer, but provide it explicitly in
   * monorepo setups where the bundler cannot resolve that require. Without either,
   * session state is memory-only (a fresh session each launch).
   */
  storage?: InjectedAsyncStorage;
}

// Runtime config updates accepted by `updateConfig`. Same shape as init EXCEPT:
//  - `appId` dropped (application identity is fixed at initialization).
//  - `sessionId` dropped (session identity is not a config value; use setSessionId).
//  - `storage` dropped (bound once during init via HydratedStorage.hydrate and
//    never rebound at runtime — keeping it here would type-check a swap that the
//    runtime silently ignores).
//  - `options.enabledEvents` dropped — see below.
//  - `user` additionally accepts `null` ("clear the current identity").
export type SDKConfigUpdate = Partial<
  Omit<SDKConfigInput, "appId" | "sessionId" | "user" | "storage" | "options">
> & {
  /**
   * Runtime options, minus the ones that can only be chosen once. `enabledEvents` is
   * absent because listeners are installed once during init, and both native engines are
   * idempotent by contract. Accepting the key would type-check a call that changes
   * nothing — the caller believes a signal is off and it keeps reporting.
   */
  options?: Partial<Omit<SDKOptions, "enabledEvents">>;
  user?: SDKConfigInput["user"] | null;
};
