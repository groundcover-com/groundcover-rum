import type { TracingOptions } from "../../config/types";
import type { EffectivePrivacy } from "../../privacy/config";
import { redactBody, redactHeaders, redactUrl } from "../../privacy/redaction";
import { msToNs } from "../../common/global";
import { truncate } from "../../common/text";
import type { NetworkEventAttributes, RawNetworkEvent } from "../types";
import type { EnrichInput } from "../event-enricher";
import { extractTraceIds } from "./trace";

export interface NetworkShapeContext {
  privacy: EffectivePrivacy;
  maxBodyLength: number;
  tracing?: TracingOptions;
  /**
   * The request's route and full URL. Platform-specific: the browser resolves
   * a relative URL against the page; RN's URLs are always absolute. `path`
   * must not carry the query string unless the URL can't be parsed.
   */
  resolveUrl: (url: string) => { path: string; fullUrl: string };
}

/** Request/response headers as sent on the wire: sensitive values redacted, each value truncated. */
export function formatNetworkHeaders(headers: Record<string, string>, privacy: EffectivePrivacy): Record<string, string> {
  const isAllow = privacy.level === "allow";
  // Built-in sensitive headers (authorization/cookie/token/key/…) are ALWAYS
  // stripped; 'allow' only opts out of the user's sensitiveKeys and redactor.
  const redacted = redactHeaders(headers, {
    sensitiveKeys: isAllow ? undefined : privacy.sensitiveKeys,
    redact: isAllow ? undefined : privacy.redact,
  });
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(redacted)) out[key] = truncate({ text: value });
  return out;
}

/**
 * A captured request/response as the `network` event the backend ingests —
 * everything after interception: URL/route derivation, query/header/body
 * redaction, body truncation, trace ids and the span name. The platform feeds
 * it a RawNetworkEvent from its own interceptor and enriches the result.
 */
export function shapeNetworkEvent(raw: RawNetworkEvent, ctx: NetworkShapeContext): EnrichInput<"network"> {
  const { privacy } = ctx;
  const queryOpts = { sensitiveKeys: privacy.sensitiveKeys, redact: privacy.redact, kind: "query" as const };

  let { path, fullUrl } = ctx.resolveUrl(raw.url);
  if (privacy.shouldMaskNetworkQueryParams) {
    // A parsed route has no query (a no-op); an unparseable URL kept whole does.
    path = redactUrl(path, queryOpts);
    fullUrl = redactUrl(fullUrl, queryOpts);
  }

  const method = raw.method?.toUpperCase() || "UNKNOWN";
  // As sent (the caller's case), or UNKNOWN like every other method field.
  const sentMethod = raw.method || "UNKNOWN";
  const status = raw.status?.toString();
  const { traceId, spanId } = extractTraceIds(raw.request.headers, ctx.tracing);

  // Redact BEFORE truncating so the body stays parseable JSON for key-based
  // redaction. 'allow' / maskNetworkBodies:false skips redaction entirely.
  const body = (text: string, kind: "request-body" | "response-body") =>
    truncate({
      text: privacy.shouldMaskNetworkBodies
        ? redactBody(text, { sensitiveKeys: privacy.sensitiveKeys, redact: privacy.redact, kind })
        : text,
      maxLength: ctx.maxBodyLength,
    });

  const attributes: NetworkEventAttributes = {
    type: "HTTP",
    operation: { name: method },
    resource_name: path,
    status,
    subType: method,
    url: { full: fullUrl },
    http: {
      route: path,
      path,
      method: sentMethod,
      status,
      request: { headers: formatNetworkHeaders(raw.request.headers, privacy), method: sentMethod },
      response: { headers: formatNetworkHeaders(raw.response.headers, privacy), status_code: status },
    },
    error: raw.error?.type ? { type: raw.error.type } : undefined,
    gc: {
      request: { body: body(raw.request.body, "request-body") },
      response: { body: body(raw.response.body, "response-body") },
    },
  };

  const input: EnrichInput<"network"> = {
    type: "network",
    timestamp: observedAt(raw.timestamp),
    end_timestamp: observedAt(raw.end_time),
    // The normalized method, like operation.name: `post` and `POST` are one span.
    span_name: `${method} ${path}`,
    attributes,
  };
  if (traceId) input.traceId = traceId;
  if (spanId) input.spanId = spanId;
  return input;
}

// An interceptor's Date.now() reading, in ns — or undefined when it isn't a
// usable time (absent, 0, negative, NaN, ±Infinity), so the enricher stamps
// the event instead of shipping a non-finite or pre-epoch value.
function observedAt(ms: number | undefined): number | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? msToNs(ms) : undefined;
}
