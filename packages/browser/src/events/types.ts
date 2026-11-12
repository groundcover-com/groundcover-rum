// Browser-only event vocabulary and attribute shapes. Core owns only the kinds
// and shapes every platform shares (see `CoreEventType` and the attribute types
// in `@groundcover/rum-core/events/types`); these describe DOM, page-load,
// URL-based navigation and rrweb replay, which exist only on the web.
import type { CoreEventType } from "@groundcover/rum-core/events/types";

/** Every event kind the browser SDK emits. */
export type BrowserEventType = CoreEventType | "dom.event" | "pageload" | "replay";

export type DomEventAttributes = {
  dom_event_type: string;
  dom_event_coordinates: {
    clientX: number;
    clientY: number;
  };
  dom_event_target: {
    tagName: string;
    id: string;
    className: string;
    text: string;
    role: string;
    accessibleName: string;
    ariaLabel: string;
    title: string;
    alt: string;
    placeholder: string;
    name: string;
    inputType: string;
    href: string;
  };
  dom_event_selector: string;
  dom_event_key_code: string;
};

export type PageLoadEventAttributes = {
  page_url: string;
  page_resources: {
    count: number;
    totalSize: number;
    totalDuration: number;
    byType: {
      [key: string]: {
        count: number;
        size: number;
        duration: number;
      };
    };
  };
  page_referrer: string;
  page_load_time: number;
};

export type NavigationEventAttributes = {
  page_url: string;
  from_url?: string;
  metadata?: Record<string, unknown>;
  duration_ms: number;
  start_timestamp: number;
  end_timestamp: number;
};

export type ReplayEventAttributes = {
  /**
   * Groundcover session replay payload.
   *
   * NOTE: This key is intentionally prefixed to avoid collisions with customer attributes.
   */
  _gc_replay_data: {
    events: string[]; // Array of packed (fflate-compressed) rrweb event strings
  };
  /**
   * Indicates this batch starts with a full DOM snapshot.
   * Full snapshots are taken at regular intervals to allow seeking directly to any point.
   * Queryable for filtering/indexing purposes.
   */
  replay_is_full_snapshot?: boolean;
  /**
   * Timestamp when the full snapshot was taken (if replay_is_full_snapshot is true).
   */
  replay_full_snapshot_timestamp?: number;
};
