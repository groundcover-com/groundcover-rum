import type { TracingOptions } from "../../config/types";
import type { IdGenerator } from "../../common/id-generator";

// Distributed-tracing helpers shared by every platform's network capture:
// generate ids, pick the headers a traced request carries, decide whether a
// request is traced at all, and read the ids back off a captured request.
// Setting a header is the one platform step (XHR setRequestHeader, a fetch
// Headers/init merge) — it stays with the caller.

export type TraceIds = {
  traceId: string;
  spanId: string;
  /** W3C `00-<32 hex>-<16 hex>-01`. */
  traceparent: string;
  /** The ids as base-10 strings, for `traceIdHeaderName` / `spanIdHeaderName`. */
  decimalTraceId: string;
  decimalSpanId: string;
};

export function generateTraceIds(idGenerator: IdGenerator): TraceIds {
  const spanId = idGenerator.generateSpanId();
  const traceId = idGenerator.generateTraceId();
  let decimalTraceId: string;
  let decimalSpanId: string;
  try {
    decimalTraceId = BigInt("0x" + traceId).toString(10);
    decimalSpanId = BigInt("0x" + spanId).toString(10);
  } catch {
    decimalTraceId = traceId;
    decimalSpanId = spanId;
  }
  return { traceparent: `00-${traceId}-${spanId}-01`, traceId, spanId, decimalTraceId, decimalSpanId };
}

/** RFC 9110 token: a name a host would refuse (or choke on) never reaches a setter. */
export function isValidHeaderName(name: unknown): name is string {
  return typeof name === "string" && /^[a-zA-Z0-9!#$&'*+\-.^_`|~]+$/.test(name);
}

/**
 * The headers a traced request carries, by name. One map for every transport,
 * so a header added for one is never missing on another. Invalid names are
 * dropped; a name configured twice is set once (last wins), never comma-joined.
 */
export function buildTraceHeaders(tracing: TracingOptions | undefined, ids: TraceIds): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: unknown, value: string) => {
    if (isValidHeaderName(name)) out[name] = value;
  };

  if (tracing?.origin?.name) set(tracing.origin.name, tracing.origin.value);
  if (tracing?.traceIdHeaderName) set(tracing.traceIdHeaderName, ids.decimalTraceId);
  if (tracing?.spanIdHeaderName) set(tracing.spanIdHeaderName, ids.decimalSpanId);

  const propagationHeaders = tracing?.propagationHeaders;
  const names = propagationHeaders?.length ? propagationHeaders : ["traceparent"];
  for (const name of names) set(name, ids.traceparent);
  return out;
}

/**
 * Whether a request is traced: any `propagationUrls` pattern matches any of
 * `candidates` in full. Which strings are candidates is the platform's call —
 * the browser adds a same-origin request's pathname, so a path pattern never
 * matches another host.
 *
 * Only `*` is a wildcard. Every other regex metacharacter is escaped first, or
 * a `.` matches any character and `https://api.example.com/*` sends trace
 * headers to `https://api-example.com/…`.
 */
export function matchesPropagationUrl(candidates: readonly string[], patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length) return false;
  return patterns.some((pattern) => {
    try {
      if (typeof pattern !== "string") return false;
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`);
      return candidates.some((candidate) => regex.test(candidate));
    } catch {
      return false;
    }
  });
}

/**
 * The trace/span ids a captured request was sent with, or "" for each one it
 * lacks. Configured id headers win; otherwise the first propagation header (or
 * `traceparent`) is parsed as W3C traceparent.
 *
 * Header names are matched case-insensitively: a fetch `Headers` list is
 * lowercased by the host, so a configured `X-Trace-Id` would otherwise never
 * be found on a request that carried it.
 */
export function extractTraceIds(
  headers: Record<string, string>,
  tracing: TracingOptions | undefined
): { traceId: string; spanId: string } {
  const lower: Record<string, string> = {};
  for (const key of Object.keys(headers)) lower[key.toLowerCase()] = headers[key] as string;
  const read = (name: string | undefined): string => {
    if (!name) return "";
    const value = lower[name.toLowerCase()];
    return typeof value === "string" ? value : "";
  };

  let traceId = read(tracing?.traceIdHeaderName);
  let spanId = read(tracing?.spanIdHeaderName);

  if (!traceId || !spanId) {
    let traceparent = "";
    for (const name of tracing?.propagationHeaders ?? []) {
      traceparent = read(name);
      if (traceparent) break;
    }
    if (!traceparent) traceparent = read("traceparent");

    const parts = traceparent.split("-");
    if (parts.length === 4 && parts[0] === "00") {
      if (!traceId && parts[1]?.length === 32) traceId = parts[1];
      if (!spanId && parts[2]?.length === 16) spanId = parts[2];
    }
  }
  return { traceId, spanId };
}
