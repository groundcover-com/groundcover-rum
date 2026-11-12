import type { CoreEventType, PerformanceEventAttributes } from "@groundcover/rum-core";

// The React Native SDK's event vocabulary: the shared core kinds plus "interaction",
// the mobile wire type for taps, gestures and text input. It is deliberately not
// "dom.event" — RN taps carry a native shape (component path from the fiber tree,
// accessibilityLabel or descendant text), not a DOM selector, and minting a distinct
// type lets consumers tell mobile interactions from web DOM events. Threaded through
// every core generic as `TExtra = "interaction"`.
export type RNExtraEventType = "interaction";
// = CoreEventType | "interaction": the kinds every platform shares, plus RN's own.
export type RNEventType = CoreEventType | RNExtraEventType;

/** accessibilityState flags (structural — never masked). */
export type InteractionTargetState = {
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  busy?: boolean;
  expanded?: boolean;
};

/** accessibilityValue. Numeric fields are structural; `text` is masked like a label. */
export type InteractionTargetValue = {
  min?: number;
  max?: number;
  now?: number;
  /** Human-readable value text; "***" when masked. */
  text?: string;
};

/** Which way a gesture went, along its dominant axis. */
export type GestureDirection = "up" | "down" | "left" | "right";

/**
 * How a gesture moved. Present only for gesture kinds — a tap has no
 * kinematics, and an input event has no coordinates at all.
 */
export type InteractionGestureAttributes = {
  /** Omitted for "pinch", where a single axis does not describe the motion. */
  direction?: GestureDirection;
  /** Travel of the primary pointer, device-independent pixels. */
  distance_dp: number;
  /** Speed at the end of the gesture, dp per second. */
  velocity_dp_s: number;
  duration_ms: number;
  /** Max simultaneous touches; 2+ is what makes a gesture a pinch. */
  pointer_count: number;
  /**
   * The JS touch stream was cancelled mid-gesture (Android does this when a
   * ScrollView takes over), so distance and velocity are lower bounds rather
   * than measurements.
   */
  partial?: boolean;
  /** Which side measured it. Native sees a scroll through to its end where the
   *  JS stream was cancelled, so its numbers are the trustworthy ones. */
  capture_source: "js" | "native";
};

/**
 * Attributes for a captured interaction (listener-internal build shape). The wire form is
 * the DOT-FLATTENED version, pinned by the golden wire-format test.
 *
 * Six kinds share it: "tap", a classified touch carrying coordinates; "input", a
 * text-field edit emitted once when editing ends and only if the field changed — the
 * typed VALUE is never captured, and input events carry no coordinates; and the gesture
 * kinds "long_press", "swipe", "scroll" and "pinch", which also carry
 * `interaction_gesture`.
 */
export type InteractionEventAttributes = {
  /** What the user did. Taps and text edits come from JS; the movement kinds
   *  come from the JS classifier or, when it is attached, the native tracker. */
  interaction_type: "tap" | "input" | "long_press" | "swipe" | "scroll" | "pinch";
  /** Touch point in device-independent pixels (pageX/pageY). For a gesture this
   *  is where the finger LANDED — that is what identifies the element, not
   *  where it was lifted. Absent on "input". */
  interaction_coordinates?: { x: number; y: number };
  interaction_target: {
    /** Nearest meaningful component displayName; "" when the fiber walk found none. */
    component: string;
    /** accessibilityLabel / aria-label / text child; "***" when masked. Never the typed value. */
    label: string;
    /** accessibilityRole / role prop; "" when absent. Structural — never masked. */
    role: string;
    /** accessibilityHint; "" when absent. "***" when masked (human-readable text). */
    hint: string;
    /** accessibilityState flags; omitted when the element has none. */
    state?: InteractionTargetState;
    /** accessibilityValue; omitted when absent. `text` masked while masking. */
    value?: InteractionTargetValue;
  };
  /** "CheckoutScreen > Card > Button", outermost→innermost, ≤10 segments, ≤200 chars. */
  interaction_component_path: string;
  /** Kinematics; gesture kinds only. */
  interaction_gesture?: InteractionGestureAttributes;
};

/**
 * The current screen, RN's answer to the browser's `location`. Contributed through
 * `enrichAttributes` under the `screen` key (merged last, so it wins) and stamped on
 * every event. Identified by React Navigation's route `name` plus `key`, a per-INSTANCE
 * id disambiguating two live instances of one screen. Deliberately NOT a URL: mobile
 * screens are not URLs, and a resolved deep-link path can carry tokens. `key` is "" when
 * unknown or for the manual API.
 */
export type ScreenAttributes = {
  name: string;
  key: string;
};

/**
 * Mutable holder for "the current screen" — written by the navigation tracker,
 * read by the enricher (via `platform/rn-platform.ts`) to stamp `screen` on
 * every event. Lives beside `ScreenAttributes` because "the current view" is a
 * platform concept: the dependency runs platform → listeners, never the reverse.
 */
/** A screen transition, delivered to {@link ScreenHolder} subscribers after the new screen
 *  is already current. */
export interface ScreenChange {
  /** The screen being left; `{ name: "", key: "" }` on the very first landing. */
  outgoing: ScreenAttributes;
  /** The screen just made current. */
  incoming: ScreenAttributes;
  /** No prior named screen — the app's first landing. */
  isFirstScreen: boolean;
}

export interface ScreenHolder {
  get(): ScreenAttributes;
  set(screen: ScreenAttributes): void;
  /**
   * Observe screen changes; returns an unsubscribe. Listeners fire in subscription order, AFTER
   * the new screen is current (so `get()` inside a listener already returns `incoming`). Lets a
   * consumer react to navigation — re-push the crash envelope, close a frame segment — without
   * the composition root hand-wiring a decorator around a late-bound reference.
   */
  subscribe(listener: (change: ScreenChange) => void): () => void;
}

/**
 * A screen-navigation event. Mobile apps have SCREENS, not URLs — this keys on
 * the route name + key, never the browser's `page_url`/`from_url`. The wire form
 * is the dot-flattened version — core's enricher flattens nested attribute
 * objects.
 */
/*
 * The screen navigated TO is NOT declared here. It rides on the ambient `screen` block that
 * `enrichAttributes` stamps on every event — see {@link ScreenAttributes} — and the tracker
 * updates the holder before emitting, so a navigation event already carries it.
 *
 * Declaring it here as well — `screen_name`/`screen_key` written by the tracker while the enricher
 * stamps `screen` independently — would mean two writers for each value and four keys on the wire
 * for two values. `screen.*` is the convention every other event type follows, so it is the only
 * one.
 */
export type NavigationEventAttributes = {
  /** Route name of the screen navigated FROM; omitted on the first screen / manual navigations. */
  from_screen?: string;
  /** Route key of the origin screen; omitted when there is no origin. */
  from_key?: string;
  /** Arbitrary caller metadata (manual API) or transition context (auto). Key-redacted while masking. */
  metadata?: Record<string, unknown>;
  duration_ms: number;
  start_timestamp: number;
  end_timestamp: number;
};

/**
 * The app-start metrics, as `performance_metric_name` values.
 *
 * Declared here rather than in the listener that emits them: this is PUBLIC API — `config/types.ts`
 * re-exports it and `index.ts` puts it on the package surface — and every other public type in this
 * package is declared in this file or in `config/types.ts`. A customer's only path to a public type
 * should not run through a module that also holds one signal's enrichment and buffering.
 */
export type AppStartMetricName =
  | "app_start_cold"
  /** The Activity/scene was rebuilt while the process lived. */
  | "app_start_warm"
  /** The app returned to the foreground with its UI intact — a different population from a
   *  warm start, and the one a user produces dozens of times a day. */
  | "app_start_hot"
  | "app_start_tti";

/**
 * Why native closed a frame segment. Same three values as the native enums —
 * plus, like `NativeFrameSegmentReason` it is copied from, whatever a NEWER
 * installed binary sends a JS bundle that predates it. See that type for why the
 * alternative (rejecting the segment) discards valid frame data over a label.
 */
export type FrameSegmentReason = "navigation" | "background" | "safety" | (string & {});

/**
 * Frame-vitals `performance` attributes: core's metric shape plus what only a segment
 * has. The metric value is `frames_delay_total` — milliseconds lost, absolute — and the
 * slow/frozen COUNTS and the segment's bounds ship alongside, so segments of different
 * lengths can be summed and normalized by time. Declared here because core's shape is
 * shared with web vitals, which have no frames.
 */
export type FrameVitalsEventAttributes = PerformanceEventAttributes & {
  /**
   * How many frames in this segment were bad, absolutely. These are comparable across platforms —
   * a frame that missed its budget is a frame that missed its budget — which a frame TOTAL is not.
   *
   * THE TOTAL IS DELIBERATELY ABSENT. The two platforms do not count the same event: Android's
   * FrameMetrics fires only on a real draw, iOS's CADisplayLink on every display refresh whether
   * the app drew or not. iOS's frames-per-second is therefore the refresh rate handed straight
   * back, carrying nothing the segment bounds do not already have, while Android's is genuine
   * render activity — so `slow / total` would read near zero on iOS and high on Android for the
   * same class of app. A comment saying it is not a denominator is not a guard, so it is not sent.
   *
   * Normalize these by TIME. `start_timestamp` and `end_timestamp` ship on every segment, and a
   * second is a second on both platforms.
   */
  // Present on the `frames_delay_total` event, the only one a segment emits. They are absolute
  // counts, so they must appear on exactly one event per segment — on two, a consumer summing
  // across rows would double-count every frame.
  performance_frames_slow?: number;
  performance_frames_frozen?: number;
  /**
   * The budget each frame was judged against, in milliseconds — the bar that produced
   * `performance_frames_slow` and `frames_delay_total`.
   *
   * Ships because `performance_refresh_rate_hz` alone does not determine it. iOS judges an adaptive
   * panel against the cadence the display is ACTUALLY running at, so on an idle 120Hz screen the
   * budget is ~16.7ms while the nominal rate implies 8.33ms. Without this nobody downstream can
   * reproduce our slow count or our lost-time total, or tell which of the two bars was used.
   */
  performance_frame_budget_ms?: number;
  /**
   * The display's NOMINAL rate — what the panel can do. NOT necessarily the bar `slow` was derived
   * from — see `performance_frame_budget_ms`.
   *
   * NOT a measured rate — in particular, not derived from the worst frame observed.
   * Device-dependent, so a consumer comparing two devices needs it.
   */
  performance_refresh_rate_hz: number;
  performance_segment_reason: FrameSegmentReason;
  /**
   * Segment bounds, epoch NANOSECONDS.
   *
   * Deliberately the same key names and scale RN `navigation` events ship (see
   * {@link NavigationEventAttributes}), so a consumer can intersect a segment
   * with the navigations around it without a unit conversion or a name mapping.
   * No `duration_ms`: it is end − start.
   */
  start_timestamp: number;
  end_timestamp: number;
};

// ── Session-lifecycle / pool policy sets (platform-owned; passed into core) ──

// A tap proves a human is present — it drives session confirmation + rotation
// via SessionLifecycle. (AppState "active" transitions are the other presence
// source, fed to reconcile() directly by the presence monitor.)
export const RN_ACTIVITY_EVENT_TYPES: ReadonlySet<RNEventType> = new Set<RNEventType>([
  "interaction",
]);

// `performance` (app start, TTI, frame vitals) does not prove a human is there.
// A frame segment can close with nobody present — the safety cap fires purely on
// elapsed time — so letting these drive reconcile would keep a
// forgotten-but-foregrounded app (a kiosk, a phone left on a desk) rotating
// sessions forever. The segments that DO follow a user action are already
// preceded by the interaction or navigation event that caused them, which
// reconciles on its own. Same role the browser's "replay" plays in its ignored set.
export const RN_IGNORED_EVENT_TYPES: ReadonlySet<RNEventType> = new Set<RNEventType>([
  "performance",
]);

// These ride along in the batch but never trigger a size-based flush on their
// own (mirrors the browser's "navigation"/"dom.event"). `exception` is
// deliberately absent — a crash or hang is time-critical.
export const RN_EVENTS_TO_SKIP_FLUSH: ReadonlyArray<RNEventType> = [
  "navigation",
  "interaction",
  "performance",
];
