import { UserIdentifiers, BaseEvent } from "../events/types";

// `T extends string`, not a fixed union: each platform package composes its
// own event map from this helper (see the platform `config/types.ts` files),
// which constraining to a shipped name set would have made impossible without
// editing core.
//
// `attributes` is exactly `A`: core does not intersect a view block here,
// because "the current view" is a platform concept (see
// EventEnricherDeps.enrichAttributes). A platform that stamps view attributes
// re-declares this helper adding its own shape.
export type Event<T extends string, A> = Omit<BaseEvent<T>, "attributes"> & {
  type: T;
  attributes: A;
};

export type PrivacyLevel = "mask-sensitive" | "mask-all" | "allow";

/** The event surface a redactor field belongs to. */
export type RedactKind =
  | "request-body"
  | "response-body"
  | "query"
  | "header"
  | "log"
  | "error";

export interface RedactField {
  /** Immediate key of the value; `""` for whole-string fields (log/error message). */
  key: string;
  /** The leaf value — always a primitive, never an object/array. */
  value: string | number | boolean | null;
  /** Full key path to this leaf; `[]` for whole-string fields. */
  path: string[];
  /** Which event surface this field came from (header name is in `key`). */
  kind: RedactKind;
  /** Whether the built-in patterns + `sensitiveKeys` would redact this field. */
  sensitive: boolean;
}

/**
 * Per-field redaction hook. Invoked on each LEAF value during the redaction
 * walk (never on objects/arrays — the SDK recurses those itself and never
 * passes them here). Return a primitive replacement, or `undefined` to defer
 * to the SDK default (`sensitive ? '[REDACTED]' : value`) — so a hook that
 * only cares about one field can't accidentally disable masking elsewhere.
 */
export type Redactor = (
  field: RedactField
) => string | number | boolean | null | undefined;

// LEAN BASE — this file holds only the platform-agnostic option surface.
// Platform packages EXTEND these types in their own `config/types.ts` (narrowing
// `enabledEvents` to their listener names, adding platform-only surfaces) and
// declare any extra option slots through a ConfigExtension.
export interface PrivacyOptions {
  /**
   * Master switch for data masking. `'mask-sensitive'` (default) masks only
   * SENSITIVE data (sensitive-key matches, platform-flagged UI elements) and
   * redacts network/log/error payloads while capturing the rest;
   * `'mask-all'` also masks all captured input/text; `'allow'` opts out.
   * Platform packages define what "sensitive UI element" means on their host.
   */
  level?: PrivacyLevel;
  /** Redact network request/response bodies. Default on unless `level` is `'allow'`. */
  maskNetworkBodies?: boolean;
  /** Redact network URL query params. Default on unless `level` is `'allow'`. */
  maskNetworkQueryParams?: boolean;
  /** Redact console log messages and attributes. Default on unless `level` is `'allow'`. */
  maskLogs?: boolean;
  /** Redact error messages and metadata (not stack frames). Default on unless `level` is `'allow'`. */
  maskErrors?: boolean;
  /** Extra case-insensitive key substrings treated as sensitive, merged with the built-in patterns. */
  sensitiveKeys?: string[];
  /**
   * Per-field custom redaction hook for captured events. Called on each leaf
   * value during the redaction walk with the original typed value; see
   * {@link Redactor}. For arbitrary whole-event changes use `enrichEvent`.
   */
  redact?: Redactor;
}

/** Distributed-tracing header propagation for outgoing network requests. */
export interface TracingOptions {
  /**
   * Request URLs that receive injected tracing headers: whole-URL matches where
   * only `*` is a wildcard. Which strings a pattern is matched against is the
   * platform's (the browser adds a same-origin request's path).
   */
  propagationUrls?: string[];
  /** Inbound header names to read/propagate onto traced requests. */
  propagationHeaders?: string[];
  /** Header name carrying the trace id. */
  traceIdHeaderName?: string;
  /** Header name carrying the span id. */
  spanIdHeaderName?: string;
  /** Origin tag stamped on injected trace headers. */
  origin?: {
    name: string;
    value: string;
  };
}

/** Batching and delivery of outgoing event batches. */
export interface TransportOptions {
  /**
   * Max events buffered before a batch is flushed (default 10). A merged error
   * (see {@link ErrorDeduplicationOptions}) is one event, however often it repeated.
   */
  batchSize?: number;
  /** Max ms a batch waits before flushing regardless of size (default 10000). */
  batchTimeout?: number;
  /** Gzip-compress outgoing batches; offloaded to the platform's async encoder when it has one (default true). */
  compression?: boolean;
}

/**
 * Merging repeats of the same error, so an error loop doesn't send an event per
 * occurrence. Within each batch, a repeat of an exception or error-level log
 * already waiting to be sent is counted on that event (`error_repeat_count` /
 * `log_repeat_count`, the occurrences it stands for) instead of sent again, so a
 * batch carries one event per distinct error, with the first occurrence's
 * context. A merged event counts as one toward `transport.batchSize`, so a
 * loop alone doesn't fill a batch: it goes out with the batch, on
 * `transport.batchTimeout`, when other events fill it, or on a lifecycle flush.
 * "The same" means the same page or screen, and for an exception the same type,
 * message (first 400 characters, after redaction), handled flag and stack; for a
 * log, the same message.
 */
export interface ErrorDeduplicationOptions {
  /** Merge repeated errors within a batch (default true). `false` sends every occurrence. */
  enabled?: boolean;
}

/** How errors are reported. */
export interface ErrorReportingOptions {
  /**
   * Merging repeated identical errors; see {@link ErrorDeduplicationOptions}.
   * `false` / `true` is shorthand for `{ enabled: false }` / `{ enabled: true }`.
   */
  deduplication?: ErrorDeduplicationOptions | boolean;
}

// `TEvent` is the platform's event type — the shape `beforeSend` / `enrichEvent`
// see. Core has no event map of its own, so the default is the open envelope; a
// platform instantiates `SDKOptions<ItsEvent>` (or redeclares the two hooks) to
// type them over its own events.
//
// The hooks are METHOD signatures on purpose: core only ever hands them a
// `BaseEvent`, and method parameters are checked bivariantly, so a platform's
// config — whose hooks take its narrower event type — passes into the core
// `ConfigManager` without a boundary cast. A property signature would demand
// contravariance and force every platform to cast at the seam.
export interface SDKOptions<
  TEvent extends BaseEvent<string> = BaseEvent<string>,
> {
  /**
   * Which signal listeners to enable, by name. Empty array = all. The NAMES
   * are platform-defined (each platform ships its own listener set) — the
   * platform package narrows this to its literal union.
   */
  enabledEvents: string[];
  sessionSampleRate: number;
  debug: boolean;
  excludedUrls?: Array<string | RegExp>;
  beforeSend?(event: TEvent): boolean;
  enrichEvent?(event: TEvent): TEvent;
  /**
   * Unified privacy / data-masking config for every captured surface.
   * ON by default (`level: 'mask-sensitive'`); see {@link PrivacyOptions}.
   */
  privacy?: PrivacyOptions;
  /** Distributed-tracing header propagation; see {@link TracingOptions}. */
  tracing?: TracingOptions;
  /** Batching & delivery of outgoing events; see {@link TransportOptions}. */
  transport?: TransportOptions;
  /** How errors are reported: merging of repeated exceptions and error-level logs; see {@link ErrorReportingOptions}. */
  errors?: ErrorReportingOptions;
  /**
   * Target maximum wall-clock duration of a session, in ms. Enforced LAZILY on activity, so NOT
   * a hard bound — an idle session keeps its id past the cap, which deliberately avoids minting
   * phantom sessions. Also bounded by a 30-minute inactivity gap, counting raw input as
   * presence so passive reading does not end a session.
   *
   * Defaults to 4 hours; must be 1 minute to 8 hours, else falls back with a warning.
   */
  sessionMaxDuration?: number;
}

export interface SDKConfigInput<
  TEvent extends BaseEvent<string> = BaseEvent<string>,
> {
  apiKey: string;
  cluster: string;
  environment: string;
  dsn: string;
  appId: string;
  namespace?: string;
  releaseId?: string;
  user?: Partial<UserIdentifiers>;
  options?: Partial<SDKOptions<TEvent>>;
  sessionId?: string;
}
