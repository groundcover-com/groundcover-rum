/**
 * The session envelope every batch carries. Core owns session identity, deployment coordinates
 * and the configured `user` / `service.name`. DEVICE metadata is the one part it does not own,
 * and is deliberately unnamed — it is whatever the platform's DeviceAttributesProvider
 * contributes, and naming one platform's shape here would make the others' look like
 * second-class extras. Each platform declares its own narrowing.
 */
export type SessionAttributes = {
  session_id: string;
  session_start_time: number;
  /** Optional cluster identifier */
  cluster?: string;
  /** Optional environment identifier */
  env?: string;
  /** Optional namespace identifier */
  namespace?: string;
  /** Optional release identifier */
  releaseId?: string;
  /** Optional service name */
  "service.name"?: string;
  /** Optional user identifier */
  user?: Record<string, unknown>;
  /** Platform-contributed device metadata. */
  [key: string]: unknown;
};

/**
 * The event kinds every platform emits under the same name. Core itself only
 * produces "log" and "custom"; the rest are shared vocabulary whose attribute
 * shapes may still be platform-specific. A platform adds its own kinds on top
 * (see `BaseEvent`) — this is deliberately not the full set any one ships.
 */
export type CoreEventType =
  | "exception"
  | "network"
  | "log"
  | "navigation"
  | "custom"
  | "performance";

/**
 * `TType` lets a platform name its own event kinds without editing core, and every core class
 * flows it through. Defaults to `string`, because the set of NAMES is open — a platform that
 * wants a closed union passes its own. Shared shapes stay shared; only the vocabulary is open.
 */
export type BaseEvent<TType extends string = string> = {
  type: TType;
  timestamp?: number;
  end_timestamp?: number;
  start_timestamp?: number;
  span_name?: string;
  id: string;
  spanId: string;
  parentSpanId: string | undefined;
  traceId: string | undefined;
  attributes?: Record<string, unknown>;
};

/**
 * How an event merges with its identical repeats in a batch
 * (errors.deduplication): what the event's producer says makes two of them the
 * same, plus where it happened (see EventEnricher).
 */
export type DedupInfo = {
  /** Equal keys are repeats of one another. */
  key: number;
  /** The attribute a merged event carries its count in. */
  countAttribute: string;
};

/**
 * An event that can merge with its identical repeats: one whose producer gave
 * it `dedup` (exceptions, error-level logs; never hangs or crashes). The
 * enricher sets `dedup` as a hidden, frozen property: never serialized, not
 * seen when a hook logs or spreads the event, and not changed by one. The pool
 * reads it before the hooks run, so a hook can't change how the event groups.
 */
export interface DedupeableEvent<TType extends string = string> extends BaseEvent<TType> {
  dedup?: DedupInfo;
}

export type UserIdentifiers = {
  id: string;
  email: string;
  role: string;
  name: string;
  organization: string;
  properties: Record<string, unknown>;
};

// A request/response as a platform interceptor observed it, before shaping
// (see events/network/shape.ts). Times are epoch ms.
export type RawNetworkEvent = {
  timestamp?: number;
  end_time?: number;
  method: string;
  url: string;
  status: number;
  request: {
    headers: Record<string, string>;
    body: string;
  };
  response: {
    headers: Record<string, string>;
    body: string;
  };
  error?: {
    type: string;
  };
};

export type NetworkEventAttributes = {
  type: "HTTP";
  resource_name: string;
  status: string;
  subType: string;
  level?: string;
  timestamp?: number;
  operation: {
    name: string;
    startTime?: number;
    endTime?: number;
  };
  url: {
    full: string;
  };
  http: {
    route: string;
    path: string;
    status: string;
    method: string;
    request: {
      headers: Record<string, string>;
      method: string;
    };
    response: {
      headers: Record<string, string>;
      status_code: string;
    };
    duration_ms?: number;
  };
  gc: {
    request: {
      body: string;
    };
    response: {
      body: string;
    };
  };
  error?: {
    type: string;
  };
};
type Stacktrace = {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
};

export type ErrorEventAttributes = {
  error_type: string;
  error_message: string;
  error_stacktrace?: Array<Stacktrace>;
  error_fingerprint: string;
  error_handled: boolean;
  error_metadata?: Record<string, unknown>;
  /**
   * How many occurrences this event stands for, itself included, when repeats
   * in the same batch were merged into it (errors.deduplication). Absent means
   * one; the true count of an error is the sum of this (or 1) over its events.
   * Set on a copy when the batch is sent, so `beforeSend` and `enrichEvent`
   * never see it: they see every occurrence instead.
   */
  error_repeat_count?: number;
};

export const LOG_LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogEventAttributes = {
  message: string;
  level: string;
  /**
   * On an error-level log: how many occurrences it stands for, like an
   * exception's `error_repeat_count` (errors.deduplication). Absent means one.
   */
  log_repeat_count?: number;
} & Record<string, unknown>;

export type UserDefinedEventAttributes = {
  custom_event_name: string;
  custom_event_attributes?: Record<string, unknown>;
};

export type PerformanceEventAttributes = {
  performance_metric_name: string;
  performance_metric_value: number;
  performance_metric_id: string;
  performance_metric_navigation_type: string;
};

export type EnrichedEvent<TType extends string = string> = BaseEvent<TType>;

export type Batch<TType extends string = string> = {
  sessionAttributes: SessionAttributes;
  events: Array<EnrichedEvent<TType>>;
};
