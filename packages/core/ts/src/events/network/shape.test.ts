import { describe, it, expect } from "vitest";
import { resolvePrivacy } from "../../privacy/config";
import type { NetworkEventAttributes, RawNetworkEvent } from "../types";
import { formatNetworkHeaders, shapeNetworkEvent, type NetworkShapeContext } from "./shape";

const raw = (over: Partial<RawNetworkEvent> = {}): RawNetworkEvent => ({
  timestamp: 1_700_000_000_000,
  end_time: 1_700_000_000_250,
  method: "GET",
  url: "https://api.example.com/v1/users?token=abc",
  status: 200,
  request: { headers: {}, body: "" },
  response: { headers: {}, body: "" },
  ...over,
});

const attrs = (input: { attributes?: unknown }) => input.attributes as NetworkEventAttributes;

const ctx = (over: Partial<NetworkShapeContext> = {}): NetworkShapeContext => ({
  privacy: resolvePrivacy(undefined),
  maxBodyLength: 5000,
  resolveUrl: (url) => ({ path: "/v1/users", fullUrl: url }),
  ...over,
});

describe("shapeNetworkEvent", () => {
  it("shapes the HTTP attributes from the platform-resolved URL", () => {
    const input = shapeNetworkEvent(raw(), ctx());
    expect(input.type).toBe("network");
    expect(input.span_name).toBe("GET /v1/users");
    expect(input.timestamp).toBe(1_700_000_000_000_000_000);
    expect(input.end_timestamp).toBe(1_700_000_000_250_000_000);
    expect(input.attributes).toMatchObject({
      type: "HTTP",
      operation: { name: "GET" },
      resource_name: "/v1/users",
      status: "200",
      url: { full: "https://api.example.com/v1/users?token=%5BREDACTED%5D" },
      http: { route: "/v1/users", path: "/v1/users", method: "GET", status: "200" },
    });
  });

  it("upper-cases the method in span_name and operation, keeping http.method as sent", () => {
    const input = shapeNetworkEvent(raw({ method: "post" }), ctx());
    expect(input.span_name).toBe("POST /v1/users");
    expect(attrs(input).operation.name).toBe("POST");
    expect(attrs(input).http.method).toBe("post");
  });

  it("labels a missing method UNKNOWN in every method field", () => {
    const input = shapeNetworkEvent(raw({ method: undefined as unknown as string }), ctx());
    expect(input.span_name).toBe("UNKNOWN /v1/users");
    expect(attrs(input).operation.name).toBe("UNKNOWN");
    expect(attrs(input).http.method).toBe("UNKNOWN");
    expect(attrs(input).http.request.method).toBe("UNKNOWN");
  });

  it("keeps only finite, positive observation times — the enricher stamps the rest", () => {
    for (const bad of [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5]) {
      const input = shapeNetworkEvent(raw({ timestamp: bad, end_time: bad }), ctx());
      expect(input.timestamp).toBeUndefined();
      expect(input.end_timestamp).toBeUndefined();
    }
  });

  it("redacts a query left in the path by an unparseable URL", () => {
    const input = shapeNetworkEvent(
      raw({ url: "/api?token=abc" }),
      ctx({ resolveUrl: (url) => ({ path: url, fullUrl: url }) })
    );
    expect(attrs(input).resource_name).toBe("/api?token=%5BREDACTED%5D");
  });

  it("leaves the URL alone under privacy level allow", () => {
    const input = shapeNetworkEvent(raw(), ctx({ privacy: resolvePrivacy({ privacy: { level: "allow" } }) }));
    expect(attrs(input).url.full).toBe("https://api.example.com/v1/users?token=abc");
  });

  it("redacts then truncates bodies", () => {
    const input = shapeNetworkEvent(
      raw({ request: { headers: {}, body: '{"password":"x","name":"ada"}' }, response: { headers: {}, body: "b".repeat(20) } }),
      ctx({ maxBodyLength: 10 })
    );
    expect(attrs(input).gc?.request.body).toBe('{"password":"[REDACTED]","name":"ada"}'.slice(0, 10));
    expect(attrs(input).gc?.response.body).toBe("b".repeat(10));
  });

  it("carries the request's trace ids, and the error type on a failure", () => {
    const input = shapeNetworkEvent(
      raw({
        status: 0,
        error: { type: "ERR_NETWORK_FAILURE" },
        request: { headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }, body: "" },
      }),
      ctx()
    );
    expect(input.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(input.spanId).toBe("b7ad6b7169203331");
    expect(attrs(input).error).toEqual({ type: "ERR_NETWORK_FAILURE" });
    expect(attrs(input).status).toBe("0");
  });

  it("omits trace ids the request lacks, so the enricher generates them", () => {
    const input = shapeNetworkEvent(raw(), ctx());
    expect("traceId" in input).toBe(false);
    expect("spanId" in input).toBe(false);
  });
});

describe("formatNetworkHeaders", () => {
  it("always strips built-in sensitive headers, even under allow", () => {
    const headers = { authorization: "Bearer x", "x-plain": "v" };
    expect(formatNetworkHeaders(headers, resolvePrivacy(undefined))).toEqual({
      authorization: "[REDACTED]",
      "x-plain": "v",
    });
    expect(formatNetworkHeaders(headers, resolvePrivacy({ privacy: { level: "allow" } }))).toEqual({
      authorization: "[REDACTED]",
      "x-plain": "v",
    });
  });

  it("applies the user's sensitive keys unless allow", () => {
    const headers = { "x-tenant": "acme" };
    expect(formatNetworkHeaders(headers, resolvePrivacy({ privacy: { sensitiveKeys: ["x-tenant"] } }))).toEqual({
      "x-tenant": "[REDACTED]",
    });
  });
});
