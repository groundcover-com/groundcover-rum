import { describe, it, expect } from "vitest";
import {
  buildTraceHeaders,
  extractTraceIds,
  generateTraceIds,
  isValidHeaderName,
  matchesPropagationUrl,
  type TraceIds,
} from "./trace";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";
const TRACEPARENT = `00-${TRACE}-${SPAN}-01`;

const fixedIds = {
  generateTraceId: () => TRACE,
  generateSpanId: () => SPAN,
  generateId: () => "id",
};

describe("generateTraceIds", () => {
  it("builds the W3C traceparent and base-10 ids", () => {
    expect(generateTraceIds(fixedIds)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      traceparent: TRACEPARENT,
      decimalTraceId: BigInt("0x" + TRACE).toString(10),
      decimalSpanId: BigInt("0x" + SPAN).toString(10),
    });
  });

  it("falls back to the hex ids when they don't parse", () => {
    const ids = generateTraceIds({ ...fixedIds, generateTraceId: () => "not-hex" });
    expect(ids.decimalTraceId).toBe("not-hex");
    expect(ids.decimalSpanId).toBe(SPAN);
  });
});

describe("isValidHeaderName", () => {
  it("accepts RFC 9110 tokens", () => {
    for (const name of ["x-trace-id", "content-type", "Authorization", "traceparent", "x_underscore_header", "header123"]) {
      expect(isValidHeaderName(name)).toBe(true);
    }
  });

  it("rejects separators, whitespace and control characters", () => {
    for (const name of [
      "",
      "header with spaces",
      "header:with:colons",
      "header(with)parens",
      "header[with]brackets",
      "header{with}braces",
      "header@with@at",
      "header,with,comma",
      "header;with;semicolon",
      "header=with=equals",
      'header"with"quotes',
      "header/with/slash",
      "header\\with\\backslash",
      "header\twith\ttab",
      "header\nwith\nnewline",
    ]) {
      expect(isValidHeaderName(name)).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    for (const value of [null, undefined, 123, {}, []]) expect(isValidHeaderName(value)).toBe(false);
  });
});

describe("buildTraceHeaders", () => {
  const ids: TraceIds = generateTraceIds(fixedIds);

  it("defaults to a single traceparent", () => {
    expect(buildTraceHeaders(undefined, ids)).toEqual({ traceparent: TRACEPARENT });
    expect(buildTraceHeaders({ propagationHeaders: [] }, ids)).toEqual({ traceparent: TRACEPARENT });
  });

  it("carries origin, the decimal id headers and every custom propagation header", () => {
    expect(
      buildTraceHeaders(
        {
          origin: { name: "x-origin", value: "rum" },
          traceIdHeaderName: "x-trace-id",
          spanIdHeaderName: "x-span-id",
          propagationHeaders: ["x-a", "x-b"],
        },
        ids
      )
    ).toEqual({
      "x-origin": "rum",
      "x-trace-id": ids.decimalTraceId,
      "x-span-id": ids.decimalSpanId,
      "x-a": TRACEPARENT,
      "x-b": TRACEPARENT,
    });
  });

  it("drops invalid names instead of handing them to a setter", () => {
    expect(
      buildTraceHeaders({ traceIdHeaderName: "bad name", propagationHeaders: ["ok", "also bad"] }, ids)
    ).toEqual({ ok: TRACEPARENT });
  });
});

describe("matchesPropagationUrl", () => {
  it("is false without patterns", () => {
    expect(matchesPropagationUrl(["https://api.example.com"], undefined)).toBe(false);
    expect(matchesPropagationUrl(["https://api.example.com"], [])).toBe(false);
  });

  it("matches exactly, anchored at both ends", () => {
    const patterns = ["https://api.example.com"];
    expect(matchesPropagationUrl(["https://api.example.com"], patterns)).toBe(true);
    expect(matchesPropagationUrl(["https://other.example.com"], patterns)).toBe(false);
    expect(matchesPropagationUrl(["https://api.example.com/x"], patterns)).toBe(false);
  });

  it("treats `*` as a wildcard", () => {
    const patterns = ["*.example.com", "/api/*"];
    expect(matchesPropagationUrl(["https://api.example.com"], patterns)).toBe(true);
    expect(matchesPropagationUrl(["/api/users"], patterns)).toBe(true);
    expect(matchesPropagationUrl(["https://example.org"], patterns)).toBe(false);
  });

  it("treats every other metacharacter literally — no lookalike-host match", () => {
    const patterns = ["https://api.example.com/*", "https://v1+api.example.com/*", "https://x.test/a?b"];
    expect(matchesPropagationUrl(["https://api.example.com/users"], patterns)).toBe(true);
    expect(matchesPropagationUrl(["https://v1+api.example.com/users"], patterns)).toBe(true);
    expect(matchesPropagationUrl(["https://x.test/a?b"], patterns)).toBe(true);
    expect(matchesPropagationUrl(["https://api-example.com/steal"], patterns)).toBe(false);
    expect(matchesPropagationUrl(["https://v11api.example.com/users"], patterns)).toBe(false);
    expect(matchesPropagationUrl(["https://x.test/ab"], patterns)).toBe(false);
  });

  it("matches when any candidate does", () => {
    expect(matchesPropagationUrl(["https://app.example.com/api/x", "/api/x"], ["/api/*"])).toBe(true);
  });

  it("skips a non-string pattern instead of throwing", () => {
    expect(matchesPropagationUrl(["/api/x"], [42 as unknown as string, "/api/*"])).toBe(true);
  });
});

describe("extractTraceIds", () => {
  it("parses traceparent", () => {
    expect(extractTraceIds({ traceparent: TRACEPARENT }, undefined)).toEqual({ traceId: TRACE, spanId: SPAN });
  });

  it("returns empty ids for a missing or malformed traceparent", () => {
    expect(extractTraceIds({}, undefined)).toEqual({ traceId: "", spanId: "" });
    expect(extractTraceIds({ traceparent: "01-abc-def-01" }, undefined)).toEqual({ traceId: "", spanId: "" });
    expect(extractTraceIds({ traceparent: `00-${TRACE}-short-01` }, undefined)).toEqual({ traceId: TRACE, spanId: "" });
  });

  it("prefers the configured id headers", () => {
    expect(
      extractTraceIds(
        { "x-trace-id": "123", "x-span-id": "456", traceparent: TRACEPARENT },
        { traceIdHeaderName: "x-trace-id", spanIdHeaderName: "x-span-id" }
      )
    ).toEqual({ traceId: "123", spanId: "456" });
  });

  it("reads traceparent from a custom propagation header", () => {
    expect(extractTraceIds({ "x-custom": TRACEPARENT }, { propagationHeaders: ["x-custom"] })).toEqual({
      traceId: TRACE,
      spanId: SPAN,
    });
  });

  it("matches header names case-insensitively (fetch lowercases them)", () => {
    expect(
      extractTraceIds(
        { "x-trace-id": "123", "x-custom-trace": TRACEPARENT },
        { traceIdHeaderName: "X-Trace-Id", spanIdHeaderName: "X-Span-Id", propagationHeaders: ["X-Custom-Trace"] }
      )
    ).toEqual({ traceId: "123", spanId: SPAN });
    expect(extractTraceIds({ Traceparent: TRACEPARENT }, undefined)).toEqual({ traceId: TRACE, spanId: SPAN });
  });
});
