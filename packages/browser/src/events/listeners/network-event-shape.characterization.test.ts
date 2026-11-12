import { describe, it, expect, beforeEach } from "vitest";
import { NetworkEventsListener } from "./network-events-listener";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";
import type { RawNetworkEvent } from "@groundcover/rum-core/events/types";
import type { SDKConfigInput } from "@/config/types";

// CHARACTERIZATION — the exact network event the browser shapes from a raw
// observation. These inline snapshots pin the wire shape; a snapshot diff here
// is a wire-format change and must be deliberate.

const BASE: SDKConfigInput = {
  dsn: "ingest.example",
  apiKey: "k",
  cluster: "c",
  environment: "e",
  appId: "a",
};

const FIXED_IDS = {
  generateId: () => "event-id",
  generateSpanId: () => "enricher-span",
  generateTraceId: () => "enricher-trace",
};

function shape(raw: RawNetworkEvent, options: SDKConfigInput["options"] = {}) {
  const config = new ConfigManager();
  config.initialize({ ...BASE, options });
  const listener = new NetworkEventsListener({
    config,
    eventsPool: { addEvent: () => {} } as unknown as EventsPool,
    // Fixed ids: the enricher fills in trace/span ids when the request has
    // none, and those must not make the snapshot nondeterministic.
    enricher: new EventEnricher({ idGenerator: FIXED_IDS }),
  });
  const event = listener.buildEvent(raw);
  return {
    type: event.type,
    span_name: event.span_name,
    start_timestamp: event.start_timestamp,
    end_timestamp: event.end_timestamp,
    traceId: event.traceId,
    spanId: event.spanId,
    attributes: event.attributes,
  };
}

const raw = (over: Partial<RawNetworkEvent> = {}): RawNetworkEvent => ({
  timestamp: 1_700_000_000_000,
  end_time: 1_700_000_000_250,
  method: "GET",
  url: "https://api.example.com/v1/users?token=abc&page=2",
  status: 200,
  request: { headers: {}, body: "" },
  response: { headers: {}, body: "" },
  ...over,
});

describe("browser network event shape (characterization)", () => {
  beforeEach(() => {
    globalThis.location = { href: "https://app.example.com/home" } as Location;
  });

  it("absolute URL, default privacy: query + headers + JSON bodies redacted", () => {
    expect(
      shape(
        raw({
          method: "post",
          request: {
            headers: { authorization: "Bearer s3cret", "content-type": "application/json", "x-plain": "v" },
            body: '{"password":"hunter2","name":"ada"}',
          },
          response: { headers: { "set-cookie": "sid=1", "content-type": "application/json" }, body: '{"ok":true}' },
        })
      )
    ).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error": undefined,
          "gc.request.body": "{"password":"[REDACTED]","name":"ada"}",
          "gc.response.body": "{"ok":true}",
          "http.method": "post",
          "http.path": "/v1/users",
          "http.request.headers.authorization": "[REDACTED]",
          "http.request.headers.content-type": "application/json",
          "http.request.headers.x-plain": "v",
          "http.request.method": "post",
          "http.response.headers.content-type": "application/json",
          "http.response.headers.set-cookie": "[REDACTED]",
          "http.response.status_code": "200",
          "http.route": "/v1/users",
          "http.status": "200",
          "operation.name": "POST",
          "resource_name": "/v1/users",
          "status": "200",
          "subType": "POST",
          "type": "HTTP",
          "url.full": "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2",
        },
        "end_timestamp": 1700000000250000000,
        "spanId": "enricher-span",
        "span_name": "POST /v1/users",
        "start_timestamp": 1700000000000000000,
        "traceId": "enricher-trace",
        "type": "network",
      }
    `);
  });

  it("relative URL resolves against location", () => {
    expect(shape(raw({ url: "/api/items?secret=1&q=x" }))).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error": undefined,
          "gc.request.body": "",
          "gc.response.body": "",
          "http.method": "GET",
          "http.path": "/api/items?secret=%5BREDACTED%5D&q=x",
          "http.request.method": "GET",
          "http.response.status_code": "200",
          "http.route": "/api/items?secret=%5BREDACTED%5D&q=x",
          "http.status": "200",
          "operation.name": "GET",
          "resource_name": "/api/items?secret=%5BREDACTED%5D&q=x",
          "status": "200",
          "subType": "GET",
          "type": "HTTP",
          "url.full": "https://app.example.com/api/items?secret=%5BREDACTED%5D&q=x",
        },
        "end_timestamp": 1700000000250000000,
        "spanId": "enricher-span",
        "span_name": "GET /api/items?secret=%5BREDACTED%5D&q=x",
        "start_timestamp": 1700000000000000000,
        "traceId": "enricher-trace",
        "type": "network",
      }
    `);
  });

  it("failed request carries status 0 and the error type", () => {
    expect(shape(raw({ status: 0, error: { type: "ERR_NETWORK_FAILURE" } }))).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error.type": "ERR_NETWORK_FAILURE",
          "gc.request.body": "",
          "gc.response.body": "",
          "http.method": "GET",
          "http.path": "/v1/users",
          "http.request.method": "GET",
          "http.response.status_code": "0",
          "http.route": "/v1/users",
          "http.status": "0",
          "operation.name": "GET",
          "resource_name": "/v1/users",
          "status": "0",
          "subType": "GET",
          "type": "HTTP",
          "url.full": "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2",
        },
        "end_timestamp": 1700000000250000000,
        "spanId": "enricher-span",
        "span_name": "GET /v1/users",
        "start_timestamp": 1700000000000000000,
        "traceId": "enricher-trace",
        "type": "network",
      }
    `);
  });

  it("privacy level allow skips redaction", () => {
    expect(
      shape(
        raw({ request: { headers: { authorization: "Bearer s3cret" }, body: '{"password":"hunter2"}' } }),
        { privacy: { level: "allow" } }
      )
    ).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error": undefined,
          "gc.request.body": "{"password":"hunter2"}",
          "gc.response.body": "",
          "http.method": "GET",
          "http.path": "/v1/users",
          "http.request.headers.authorization": "[REDACTED]",
          "http.request.method": "GET",
          "http.response.status_code": "200",
          "http.route": "/v1/users",
          "http.status": "200",
          "operation.name": "GET",
          "resource_name": "/v1/users",
          "status": "200",
          "subType": "GET",
          "type": "HTTP",
          "url.full": "https://api.example.com/v1/users?token=abc&page=2",
        },
        "end_timestamp": 1700000000250000000,
        "spanId": "enricher-span",
        "span_name": "GET /v1/users",
        "start_timestamp": 1700000000000000000,
        "traceId": "enricher-trace",
        "type": "network",
      }
    `);
  });

  it("trace ids come from traceparent", () => {
    expect(
      shape(
        raw({
          request: {
            headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
            body: "",
          },
        })
      )
    ).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error": undefined,
          "gc.request.body": "",
          "gc.response.body": "",
          "http.method": "GET",
          "http.path": "/v1/users",
          "http.request.headers.traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          "http.request.method": "GET",
          "http.response.status_code": "200",
          "http.route": "/v1/users",
          "http.status": "200",
          "operation.name": "GET",
          "resource_name": "/v1/users",
          "status": "200",
          "subType": "GET",
          "type": "HTTP",
          "url.full": "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2",
        },
        "end_timestamp": 1700000000250000000,
        "spanId": "b7ad6b7169203331",
        "span_name": "GET /v1/users",
        "start_timestamp": 1700000000000000000,
        "traceId": "0af7651916cd43dd8448eb211c80319c",
        "type": "network",
      }
    `);
  });

  it("trace ids from configured id headers and custom propagation headers", () => {
    expect(
      shape(
        raw({
          request: {
            headers: {
              "x-trace-id": "123",
              "x-custom-trace": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            },
            body: "",
          },
        }),
        {
          tracing: {
            traceIdHeaderName: "X-Trace-Id",
            spanIdHeaderName: "X-Span-Id",
            propagationHeaders: ["X-Custom-Trace"],
          },
        }
      )
    ).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error": undefined,
          "gc.request.body": "",
          "gc.response.body": "",
          "http.method": "GET",
          "http.path": "/v1/users",
          "http.request.headers.x-custom-trace": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          "http.request.headers.x-trace-id": "123",
          "http.request.method": "GET",
          "http.response.status_code": "200",
          "http.route": "/v1/users",
          "http.status": "200",
          "operation.name": "GET",
          "resource_name": "/v1/users",
          "status": "200",
          "subType": "GET",
          "type": "HTTP",
          "url.full": "https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2",
        },
        "end_timestamp": 1700000000250000000,
        "spanId": "b7ad6b7169203331",
        "span_name": "GET /v1/users",
        "start_timestamp": 1700000000000000000,
        "traceId": "123",
        "type": "network",
      }
    `);
  });

  it("root URL and a missing method", () => {
    expect(shape(raw({ url: "https://api.example.com", method: undefined as unknown as string }))).toMatchInlineSnapshot(`
      {
        "attributes": {
          "error": undefined,
          "gc.request.body": "",
          "gc.response.body": "",
          "http.method": "UNKNOWN",
          "http.path": "/",
          "http.request.method": "UNKNOWN",
          "http.response.status_code": "200",
          "http.route": "/",
          "http.status": "200",
          "operation.name": "UNKNOWN",
          "resource_name": "/",
          "status": "200",
          "subType": "UNKNOWN",
          "type": "HTTP",
          "url.full": "https://api.example.com",
        },
        "end_timestamp": 1700000000250000000,
        "spanId": "enricher-span",
        "span_name": "UNKNOWN /",
        "start_timestamp": 1700000000000000000,
        "traceId": "enricher-trace",
        "type": "network",
      }
    `);
  });
});
