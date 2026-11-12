// Browser narrowing of the platform-agnostic config types.
//
// Core's config surface is a LEAN BASE: it knows nothing about CSS selectors,
// rrweb, DOM listener names, or HTMLElement. This module re-exports the base
// and adds the browser's extensions — its listener-name union, its
// element-masking selectors, and its replay (rrweb) surfaces — so the
// published `@groundcover/browser` d.ts keeps the exact typed API it always
// had.
import type {
  PrivacyOptions as CorePrivacyOptions,
  SDKOptions as CoreSDKOptions,
  SDKConfigInput as CoreSDKConfigInput,
} from "@groundcover/rum-core/config/types";
import type {
  SessionAttributes as CoreSessionAttributes,
  BaseEvent as CoreBaseEvent,
  ErrorEventAttributes,
  NetworkEventAttributes,
  LogEventAttributes,
  UserDefinedEventAttributes,
  PerformanceEventAttributes,
} from "@groundcover/rum-core/events/types";
import type {
  DomEventAttributes,
  PageLoadEventAttributes,
  NavigationEventAttributes,
  ReplayEventAttributes,
} from "../events/types";

/**
 * The browser's session envelope. Core owns session identity and leaves device metadata
 * unnamed, so this is the browser's contribution — and `getWebDeviceAttributes` always supplies
 * both fields, so they are REQUIRED here even though core cannot say so. The golden
 * wire-format suite pins that promise.
 */
export type BrowserSessionAttributes = CoreSessionAttributes & {
  userAgent: string;
  browser: {
    name: string;
    version: string;
    platform: string;
    language: string;
    mobile: boolean;
  };
};

export type {
  PrivacyLevel,
  RedactKind,
  RedactField,
  Redactor,
  TracingOptions,
  TransportOptions,
} from "@groundcover/rum-core/config/types";

/**
 * The view an event was captured on. Browser-owned: core has no notion of a
 * "current view" — it merges whatever the platform's `enrichAttributes`
 * contributor returns. `makeWebViewProvider` derives these (hash-route
 * detection, query-param redaction) and the SessionManager contributes them
 * under the `location` key.
 */
export type LocationAttributes = {
  path: string;
  url: string;
  title: string;
};

/**
 * The browser's event shape. Identical to core's `Event` plus the `location`
 * this platform stamps during enrichment — which is why `beforeSend` /
 * `enrichEvent` below are re-declared over THIS map rather than core's.
 */
export type Event<T extends string, A> = Omit<CoreBaseEvent<T>, "attributes"> & {
  type: T;
  attributes: A & { location?: LocationAttributes };
};

export type EventTypes = {
  "dom.event": Event<"dom.event", DomEventAttributes>;
  exception: Event<"exception", ErrorEventAttributes>;
  network: Event<"network", NetworkEventAttributes>;
  log: Event<"log", LogEventAttributes>;
  pageload: Event<"pageload", PageLoadEventAttributes>;
  navigation: Event<"navigation", NavigationEventAttributes>;
  custom: Event<"custom", UserDefinedEventAttributes>;
  performance: Event<"performance", PerformanceEventAttributes>;
  replay: Event<"replay", ReplayEventAttributes>;
};

/** The browser SDK's listener names for `enabledEvents`. */
export type BrowserEventName =
  | "dom"
  | "network"
  | "exceptions"
  | "logs"
  | "pageload"
  | "navigation"
  | "performance"
  | "replay";

/**
 * Opt-in canvas capture for session replay. Charts and other `<canvas>`-drawn
 * content (2D or WebGL) are NOT recorded by default; rrweb only serializes the
 * DOM/SVG around them, so canvas-rendered data series replay as empty frames.
 * Enabling this makes rrweb snapshot canvas pixels.
 *
 * ⚠️ HIGH COST — off by default for good reason:
 * - Bandwidth: canvas frames serialize as images, inflating replay payloads.
 * - CPU: snapshotting canvases is costly on the recorded (customer) page.
 * - Privacy: canvas pixels bypass text/input masking entirely — whatever is
 *   drawn is captured verbatim, regardless of the `privacy` config.
 */
export interface ReplayCanvasOptions {
  /**
   * Enable canvas capture. Defaults to `false` (canvas is not recorded). Maps
   * to rrweb's `recordCanvas`.
   */
  enabled?: boolean;
  /**
   * Snapshot frame rate, in frames per second. Defaults to 1 and is clamped to
   * [1, 15]; out-of-range values are clamped with a `console.warn`. Maps to
   * rrweb's `sampling.canvas`. Every canvas is re-encoded on every tick, so a
   * higher rate costs CPU even when nothing changes; frames identical to the
   * previous one are dropped, so it adds bytes only for canvases that change
   * faster than the rate. The rate is also the time resolution: a canvas state
   * shorter than `1/fps` seconds (a brief transition or hover highlight) may not
   * appear in the replay. Raise it for animated canvases.
   */
  fps?: number;
  /**
   * Image format for canvas snapshots. Defaults to `'image/webp'` (much smaller
   * than rrweb's default lossless `image/png`). Maps to rrweb
   * `dataURLOptions.type`.
   */
  imageType?: "image/webp" | "image/jpeg" | "image/png";
  /**
   * Lossy compression quality in [0, 1] for `image/webp` / `image/jpeg`.
   * Defaults to 0.6 (ignored for `image/png`). Maps to rrweb
   * `dataURLOptions.quality`.
   */
  imageQuality?: number;
}

/**
 * Session-replay (rrweb) recording controls. This is NOT a privacy surface —
 * to mask sensitive content use `privacy`.
 */
export interface ReplayOptions {
  /**
   * CSS selectors whose matching elements (and their subtrees) are excluded
   * from session recording. Matching elements appear in the replay as empty
   * placeholders of their original size. Useful for skipping noisy DOM injected
   * by browser extensions (e.g. Grammarly).
   *
   * NOTE: this is a noise-reduction control, NOT a privacy control. To mask
   * sensitive content use `privacy` instead.
   */
  blockedSelectors?: string[];
  /**
   * Opt-in canvas capture (chart data series, WebGL-backed widgets). Off by
   * default. Capturing canvas is bandwidth-, CPU-, and privacy-sensitive — see
   * {@link ReplayCanvasOptions}.
   */
  canvas?: ReplayCanvasOptions;
}

/** Session-recording (rrweb replay) masking — the only place replay can be masked. */
export interface ReplayMaskingOptions {
  /** rrweb `maskTextFn` pass-through. */
  maskTextFn?: (text: string, el: HTMLElement | null) => string;
  /** rrweb `maskInputFn` pass-through. */
  maskInputFn?: (text: string, el: HTMLElement) => string;
}

export interface PrivacyOptions extends CorePrivacyOptions {
  /** CSS selectors whose text/inputs are always masked (replay + DOM), regardless of `level` except `'allow'`. */
  maskSelectors?: string[];
  /** Session-recording (rrweb replay) masking — the only place replay can be masked. */
  replay?: ReplayMaskingOptions;
}

export interface SDKOptions
  extends Omit<
    CoreSDKOptions,
    "privacy" | "enabledEvents" | "beforeSend" | "enrichEvent"
  > {
  /**
   * Inspect each event before it is queued; return false to drop it. Typed
   * over the BROWSER event map, so `attributes.location` is visible here.
   */
  beforeSend?: (event: EventTypes[keyof EventTypes]) => boolean;
  /** Modify each event before it is queued. Typed over the browser event map. */
  enrichEvent?: (event: EventTypes[keyof EventTypes]) => EventTypes[keyof EventTypes];
  /** Which browser listeners to enable. Empty array = all. */
  enabledEvents: BrowserEventName[];
  /**
   * Unified privacy / data-masking config driving replay + non-replay masking.
   * ON by default (`level: 'mask-sensitive'`); see {@link PrivacyOptions}.
   */
  privacy?: PrivacyOptions;
  /**
   * Session-replay recording controls (noise reduction, opt-in canvas capture).
   * For replay MASKING use `privacy` instead. See {@link ReplayOptions}.
   */
  replay?: ReplayOptions;
}

export interface SDKConfigInput extends Omit<CoreSDKConfigInput, "options"> {
  options?: Partial<SDKOptions>;
}

// Runtime config updates accepted by `updateConfig`. Same shape as the init
// input EXCEPT:
//  - `appId` is dropped: application identity is fixed by the first valid init
//    and cannot be changed through runtime config updates.
//  - `sessionId` is dropped: session identity is not a config value and
//    `SDKConfig.updateConfig` ignores it, so accepting it would be a silent
//    no-op. Rebind the live session with the dedicated `setSessionId()`.
//  - `user` additionally accepts `null`: `SDKConfig.updateConfig` treats an
//    explicit `null` as "clear the current identity", so the public type must
//    allow it (the init input never clears, so its `user` has no null).
export type SDKConfigUpdate =
  Partial<Omit<SDKConfigInput, "appId" | "sessionId" | "user">>
  & { user?: SDKConfigInput["user"] | null };
