import {
  handleError,
  msToNs,
  redactMetadata,
  type ConfigManager,
  type EventEnricher,
  type EventsPool,
} from "@groundcover/rum-core";
import type { RNEventType, ScreenAttributes, ScreenHolder } from "../rn-event-types";

/**
 * Structural type for a React Navigation container ref. Declared here so the SDK
 * never hard-depends on `@react-navigation/native` (an optional peer) — anything
 * shaped like this works, including expo-router's re-exported ref.
 */
export interface NavigationContainerRefLike {
  isReady(): boolean;
  getCurrentRoute(): { name: string; key?: string; params?: object } | undefined;
  addListener(type: "state", callback: () => void): () => void;
  getRootState?(): unknown;
}

export type { ScreenHolder };

/**
 * First argument that is a non-blank string, or "". The manual navigation API takes untyped
 * caller metadata, so `screen`/`name`/`key` can be anything; coercing with `String(...)` would
 * turn an object into "[object Object]" and ship fabricated screen attribution. Returns the value
 * unchanged (not trimmed) — a real route name is used verbatim elsewhere.
 */
function firstNonBlankString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

export interface NavigationTrackerDeps {
  config: ConfigManager;
  eventsPool: EventsPool<RNEventType>;
  enricher: EventEnricher;
  screenHolder: ScreenHolder;
}

// Emits `navigation` events for React Navigation screen changes (auto), and
// backs the manual startNavigation/endNavigation API. Route PARAMS are never
// captured by default — they routinely hold ids/tokens; use the manual API's
// metadata for anything you explicitly want.
export class NavigationTracker {
  private readonly config: ConfigManager;
  private readonly eventsPool: EventsPool<RNEventType>;
  private readonly enricher: EventEnricher;
  private readonly screenHolder: ScreenHolder;

  private unsubscribe: (() => void) | null = null;
  private lastScreenName = "";
  private lastScreenKey = "";
  private lastScreenChangeMs = 0;
  private activeManual: { screen: ScreenAttributes; metadata?: Record<string, unknown>; startMs: number } | null = null;

  constructor(deps: NavigationTrackerDeps) {
    this.config = deps.config;
    this.eventsPool = deps.eventsPool;
    this.enricher = deps.enricher;
    this.screenHolder = deps.screenHolder;
  }

  // ── Auto tracking (React Navigation) ──
  startTracking(ref: NavigationContainerRefLike): void {
    try {
      this.stopTracking();
      const emitCurrent = () => {
        // This runs as React Navigation's "state" listener too, so it fires
        // OUTSIDE the startTracking try below — self-guard it so a throw from
        // isReady/getCurrentRoute/onScreen never propagates into RN's dispatch.
        try {
          if (!ref.isReady()) return;
          const route = ref.getCurrentRoute();
          if (!route) return;
          this.onScreen(route.name, route.key ?? "");
        } catch (error) {
          handleError(error);
        }
      };
      this.unsubscribe = ref.addListener("state", emitCurrent);
      emitCurrent(); // stamp the initial screen
    } catch (error) {
      handleError(error);
    }
  }

  stopTracking(): void {
    try {
      this.unsubscribe?.();
    } catch (error) {
      handleError(error);
    }
    this.unsubscribe = null;
    // Reset last-screen state so a later re-attach starts a fresh session: the
    // current screen is re-stamped (not deduped against the pre-stop screen) and
    // its dwell doesn't span the stopped interval.
    this.lastScreenName = "";
    this.lastScreenKey = "";
    this.lastScreenChangeMs = 0;
  }

  private onScreen(name: string, key: string): void {
    // Dedupe by route INSTANCE (name + key): a duplicate "state" event for the
    // same live screen is ignored, but a new instance of the same-named screen
    // (same name, different key) is a real navigation.
    if (name === this.lastScreenName && key === this.lastScreenKey) return;
    const now = Date.now();
    const fromName = this.lastScreenName;
    const fromKey = this.lastScreenKey;
    const durationMs = this.lastScreenChangeMs ? now - this.lastScreenChangeMs : 0;

    // Update the current-screen holder BEFORE emitting, so the navigation event
    // itself already carries the new screen (name + key — never a URL/path).
    this.screenHolder.set({ name, key });
    this.lastScreenName = name;
    this.lastScreenKey = key;
    this.lastScreenChangeMs = now;

    this.emit({
      screenName: name,
      from_screen: fromName || undefined,
      from_key: fromKey || undefined,
      duration_ms: durationMs,
      startMs: now - durationMs,
      endMs: now,
    });
  }

  // ── Manual API ──
  startNavigation(metadata?: Record<string, unknown>): void {
    try {
      // Accept only a non-blank STRING, and fall back through `screen` → `name`. A bare
      // `String(screen ?? name)` fabricates attribution: an object `screen` stringifies to
      // "[object Object]" (truthy, so it emits AND is never rejected in favour of `name`), and a
      // whitespace-only value passes the downstream truthiness check the same way a real name does.
      const name = firstNonBlankString(metadata?.screen, metadata?.name);
      // Manual navigations have no React Navigation instance key. Honor a caller-
      // supplied string `key` if given, else leave it blank (same coercion trap as the name).
      const key = firstNonBlankString(metadata?.key);
      const screen: ScreenAttributes = { name, key };
      this.activeManual = { screen, metadata, startMs: Date.now() };
      if (name) this.screenHolder.set(screen);
    } catch (error) {
      handleError(error);
    }
  }

  endNavigation(metadata?: Record<string, unknown>): void {
    try {
      const active = this.activeManual;
      // No matching startNavigation → nothing to end. Emitting here would ship a
      // screenless, duration_ms:0 navigation record to the wire; mirror the browser
      // navigation-listener's `if (!activeNavigation) return`.
      if (!active) return;
      this.activeManual = null;
      const now = Date.now();
      const mergedMeta = { ...active.metadata, ...(metadata ?? {}) };
      if (active.screen.name) this.screenHolder.set(active.screen);

      this.emit({
        screenName: active.screen.name || "",
        duration_ms: now - active.startMs,
        metadata: mergedMeta,
        startMs: active.startMs,
        endMs: now,
      });
    } catch (error) {
      handleError(error);
    }
  }

  destroy(): void {
    this.stopTracking();
    this.activeManual = null;
  }

  private emit(input: {
    /**
     * INTERNAL ONLY — the guard below, never a wire field. The screen navigated to reaches the
     * wire through the ambient `screen` block the enricher stamps, which the callers set before
     * emitting. Named in camelCase like `startMs`/`endMs` to keep that distinction visible.
     */
    screenName: string;
    from_screen?: string;
    from_key?: string;
    duration_ms: number;
    metadata?: Record<string, unknown>;
    startMs: number;
    endMs: number;
  }): void {
    try {
      // Never ship an empty-screen record (e.g. a manual startNavigation({}) with
      // no screen name) — it's garbage on the wire.
      if (!input.screenName) return;
      const privacy = this.config.getPrivacy();

      // Mobile navigations are SCREENS, not URLs — screen names carry no query
      // string, so there's nothing URL-shaped to redact here (unlike the browser's
      // page_url). Metadata is arbitrary caller data with no dedicated toggle, so
      // it is still key-redacted while masking.
      const metadata = redactMetadata(input.metadata, privacy);

      const event = this.enricher.enrich({
        type: "navigation",
        attributes: {
          from_screen: input.from_screen,
          from_key: input.from_key,
          metadata,
          duration_ms: input.duration_ms,
          start_timestamp: msToNs(input.startMs),
          end_timestamp: msToNs(input.endMs),
        },
      });
      this.eventsPool.addEvent(event);
    } catch (error) {
      handleError(error);
    }
  }
}
