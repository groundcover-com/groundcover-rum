import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigManager, EventEnricher, EventsPool, SafeStorage, SessionState, type PlatformStorage } from "@groundcover/rum-core";
import { NetworkEventsListener } from "./network-events-listener";
import type { RNEventType } from "../rn-event-types";

// A minimal fake XMLHttpRequest so the listener's patch/capture logic can be
// exercised in node without a device networking stack.
class FakeXHR {
  static instances: FakeXHR[] = [];
  method = "";
  url = "";
  requestHeaders: Record<string, string> = {};
  responseHeadersRaw = "content-type: application/json\r\ntraceparent: 00-abc-def-01";
  status = 200;
  responseType = "";
  responseText = '{"ok":true}';
  response: unknown = undefined;
  private listeners: Record<string, Array<() => void>> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.requestHeaders[k] = v;
  }
  getAllResponseHeaders() {
    return this.responseHeadersRaw;
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  send() {
    FakeXHR.instances.push(this);
  }
  // Test helper: fire a registered event ("load" / "error" / "timeout").
  __fire(type: string) {
    (this.listeners[type] ?? []).forEach((cb) => cb());
  }
}

function makePool(propagationUrls: string[] = ["*"]) {
  const config = new ConfigManager();
  config.initialize({
    dsn: "ingest.example",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
    options: {
      transport: { batchSize: 0, compression: false },
      tracing: { propagationUrls },
    },
  });
  const map = new Map<string, string>();
  const backing: PlatformStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  const session = new SessionState({ storage: new SafeStorage(backing) });
  const send = vi.fn();
  const pool = new EventsPool<RNEventType>({
    config,
    session,
    transporter: { send } as never,
    getDeviceAttributes: () => ({ source: "mobile-rum" }),
    eventsToSkipFlush: [],
  });
  pool.initialize();
  const enricher = new EventEnricher();
  return { config, pool, enricher, send };
}

describe("NetworkEventsListener (XHR-only)", () => {
  let OriginalXHR: unknown;

  beforeEach(() => {
    OriginalXHR = (globalThis as Record<string, unknown>).XMLHttpRequest;
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR as never;
    FakeXHR.instances = [];
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = OriginalXHR as never;
    vi.restoreAllMocks();
  });

  it("injects a traceparent header on a traced request", () => {
    const { config, pool, enricher } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/things");
    xhr.send();

    expect(xhr.requestHeaders).toHaveProperty("traceparent");
    listener.destroy();
  });

  it("treats propagationUrls metacharacters literally (no header leak to look-alike hosts)", () => {
    // Only `*` is a wildcard; the `.` in the pattern must be literal.
    const { config, pool, enricher } = makePool(["https://api.example.com/*"]);
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    // A look-alike host that would match if `.` were an unescaped wildcard —
    // must NOT receive trace headers (or the origin tag).
    const evil = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    evil.open("GET", "https://apiXexampleYcom.evil.test/things");
    evil.send();
    expect(evil.requestHeaders).not.toHaveProperty("traceparent");

    // The genuine host still gets traced.
    const ok = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    ok.open("GET", "https://api.example.com/things");
    ok.send();
    expect(ok.requestHeaders).toHaveProperty("traceparent");

    listener.destroy();
  });

  it("matches propagationUrls against the full URL only — a path pattern traces nothing, and warns", () => {
    // RN has no page origin to scope a path pattern to: matching `/api/*`
    // against the path would send trace headers to every host with that path.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config, pool, enricher } = makePool(["/api/*"]);
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://third-party.test/api/things");
    xhr.send();

    expect(xhr.requestHeaders).not.toHaveProperty("traceparent");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("path-only pattern"));
    listener.destroy();
  });

  it("emits a network event with the HTTP shape after the response loads", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("POST", "https://api.example.com/orders");
    xhr.send();
    xhr.__fire("load");

    const events = send.mock.calls.flatMap((c) => (c[0] as { events: { type: string }[] }).events);
    const net = events.find((e) => e.type === "network");
    expect(net).toBeDefined();
    listener.destroy();
  });

  it("captures a responseType:json body by serializing the parsed response", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/data");
    xhr.responseType = "json"; // axios default: response is already parsed
    xhr.response = { answer: 42 };
    xhr.responseText = "";
    xhr.send();
    xhr.__fire("load");

    // Robust to attribute dot-flattening: the serialized body must be in the batch.
    const payload = JSON.stringify(send.mock.calls);
    expect(payload).toContain("answer");
    expect(payload).toContain("42");
    listener.destroy();
  });

  const netEvent = (send: ReturnType<typeof vi.fn>) => {
    const events = send.mock.calls.flatMap(
      (c) => (c[0] as { events: Array<Record<string, unknown>> }).events
    );
    return events.find((e) => e.type === "network");
  };

  it("records an empty response body (not '[binary data]') for a FAILED request", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/data");
    xhr.responseHeadersRaw = ""; // a failed request has no response headers
    xhr.responseText = "";
    xhr.status = 0;
    xhr.send();
    xhr.__fire("error");

    const net = netEvent(send)!;
    expect(net).toBeDefined();
    expect((net.attributes as Record<string, unknown>)["gc.response.body"]).toBe("");
    expect(JSON.stringify(net)).not.toContain("[binary data]");
    listener.destroy();
  });

  it("records an empty body (not '[binary data]') for a response with no content-type", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/ping");
    xhr.responseHeadersRaw = ""; // 204 / empty — no content-type
    xhr.responseText = "";
    xhr.status = 204;
    xhr.send();
    xhr.__fire("load");

    expect((netEvent(send)!.attributes as Record<string, unknown>)["gc.response.body"]).toBe("");
    listener.destroy();
  });

  it("labels a non-empty response with no content-type as binary instead of reading it", () => {
    // Fail closed, as the browser does: an unidentified payload is not decoded
    // into telemetry. Only a known-empty response (see above) records "".
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/blob");
    xhr.responseHeadersRaw = "";
    xhr.responseText = "opaque-payload";
    xhr.send();
    xhr.__fire("load");

    expect((netEvent(send)!.attributes as Record<string, unknown>)["gc.response.body"]).toBe("[binary data]");
    listener.destroy();
  });

  it("labels binary families the browser labels (fonts, archives, wasm, protobuf)", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/font.woff2");
    xhr.responseHeadersRaw = "content-type: font/woff2";
    xhr.responseText = "wOF2";
    xhr.send();
    xhr.__fire("load");

    expect((netEvent(send)!.attributes as Record<string, unknown>)["gc.response.body"]).toBe("[font data]");
    listener.destroy();
  });

  it("extracts '/' for a root URL, never the whole URL or its query", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com?q=findme"); // root path + query
    xhr.send();
    xhr.__fire("load");

    const a = netEvent(send)!.attributes as Record<string, unknown>;
    expect(a["resource_name"]).toBe("/");
    expect(a["http.path"]).toBe("/");
    expect(String(a["resource_name"])).not.toContain("findme"); // query never in the path
    listener.destroy();
  });

  it("treats application/ecmascript as a textual response body", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/app.js");
    xhr.responseHeadersRaw = "content-type: application/ecmascript";
    xhr.responseText = "const x = 1;";
    xhr.send();
    xhr.__fire("load");

    expect(String((netEvent(send)!.attributes as Record<string, unknown>)["gc.response.body"])).toContain(
      "const x = 1;"
    );
    listener.destroy();
  });

  it("reads a textual Blob response body asynchronously via FileReader (RN fetch polyfill)", async () => {
    // Stub FileReader to deliver blob text synchronously into the async path.
    class FakeFileReader {
      result: string | null = null;
      error: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText() {
        this.result = "blob-text-body";
        this.onload?.();
      }
      abort() {}
    }
    const prevFR = (globalThis as Record<string, unknown>).FileReader;
    (globalThis as Record<string, unknown>).FileReader = FakeFileReader as never;

    try {
      const { config, pool, enricher, send } = makePool();
      const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
      listener.initialize();

      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
      xhr.open("GET", "https://api.example.com/blob");
      xhr.responseHeadersRaw = "content-type: text/plain";
      xhr.responseType = "blob";
      xhr.response = { size: 14 }; // blob-like (numeric size)
      xhr.responseText = "";
      xhr.send();
      xhr.__fire("load");

      // Read + emit happen on a microtask (the FileReader Promise) — let it settle.
      await new Promise((r) => setTimeout(r, 0));

      const payload = JSON.stringify(send.mock.calls);
      expect(payload).toContain("blob-text-body");
      listener.destroy();
    } finally {
      (globalThis as Record<string, unknown>).FileReader = prevFR;
    }
  });

  it("stamps a blob request's end_time at load, not after the async FileReader read", async () => {
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    // Delivers on a microtask so the test can advance the clock between the XHR
    // load and the read completing.
    class DelayedFileReader {
      result: string | null = null;
      error: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText() {
        Promise.resolve().then(() => {
          this.result = "blob-body";
          this.onload?.();
        });
      }
      abort() {}
    }
    const prevFR = (globalThis as Record<string, unknown>).FileReader;
    (globalThis as Record<string, unknown>).FileReader = DelayedFileReader as never;

    try {
      const { config, pool, enricher, send } = makePool();
      const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
      listener.initialize();

      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
      xhr.open("GET", "https://api.example.com/blob"); // _gcStart stamped at now=1000
      xhr.responseHeadersRaw = "content-type: text/plain";
      xhr.responseType = "blob";
      xhr.response = { size: 9 };
      xhr.responseText = "";
      xhr.send();
      xhr.__fire("load"); // finish() runs at now=1000; blob read queued as a microtask

      now = 5000; // the clock advances while the FileReader is "reading"
      await new Promise((r) => setTimeout(r, 0)); // let the read + emit run

      const events = send.mock.calls.flatMap(
        (c) => (c[0] as { events: Array<Record<string, unknown>> }).events
      );
      const net = events.find((e) => e.type === "network");
      expect(net).toBeTruthy();
      // Duration must reflect the network (load at 1000), NOT the FileReader read
      // (completed at 5000): end_time == start_time for this instantaneous request.
      expect(net!.end_timestamp).toBe(net!.start_timestamp);
      listener.destroy();
    } finally {
      (globalThis as Record<string, unknown>).FileReader = prevFR;
      dateSpy.mockRestore();
    }
  });

  it("clears the blob-read timeout when FileReader.readAsText throws synchronously", () => {
    vi.useFakeTimers();
    const abortSpy = vi.fn();
    class ThrowingFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText() {
        throw new Error("sync boom");
      }
      abort() {
        abortSpy();
      }
    }
    const prevFR = (globalThis as Record<string, unknown>).FileReader;
    (globalThis as Record<string, unknown>).FileReader = ThrowingFileReader as never;
    try {
      const { config, pool, enricher } = makePool();
      const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
      listener.initialize();

      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
      xhr.open("GET", "https://api.example.com/blob");
      xhr.responseHeadersRaw = "content-type: text/plain";
      xhr.responseType = "blob";
      xhr.response = { size: 9 };
      xhr.send();
      xhr.__fire("load"); // readAsText throws synchronously → promise rejects

      // If the 3s timeout wasn't cleared on the sync throw, advancing past it
      // fires the timeout callback's reader.abort().
      vi.advanceTimersByTime(5000);
      expect(abortSpy).not.toHaveBeenCalled();
      listener.destroy();
    } finally {
      (globalThis as Record<string, unknown>).FileReader = prevFR;
      vi.useRealTimers();
    }
  });

  it("does not capture the SDK's own ingest endpoint", () => {
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    xhr.open("POST", "https://ingest.example/json/rum");
    xhr.send();
    xhr.__fire("load");

    const events = send.mock.calls.flatMap((c) => (c[0] as { events: { type: string }[] }).events);
    expect(events.find((e) => e.type === "network")).toBeUndefined();
    listener.destroy();
  });

  it("still sends the host request even if instrumentation throws during send", () => {
    const { config, pool, enricher } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    // Simulate a broken/exotic XHR whose addEventListener throws: our patch must
    // NOT let that abort the actual request — originalSend (FakeXHR.send, which
    // records the instance) must still run.
    xhr.addEventListener = () => {
      throw new Error("addEventListener boom");
    };
    xhr.open("GET", "https://api.example.com/x");

    expect(() => xhr.send()).not.toThrow();
    expect(FakeXHR.instances).toContain(xhr); // originalSend ran → host request went out
    listener.destroy();
  });

  it("calls originalSend exactly once even when the host send throws on an ignored/early-return path", () => {
    // A host XHR whose real send() throws synchronously, on the SDK's own-ingest
    // (ignored) path. The patch must not catch that throw and then re-invoke
    // originalSend a second time (duplicate request / masked host error).
    let sendCalls = 0;
    class ThrowingSendXHR {
      static instances: unknown[] = [];
      _gcUrl?: string;
      open(_method: string, url: string) {
        this._gcUrl = url;
      }
      setRequestHeader() {}
      getAllResponseHeaders() {
        return "";
      }
      addEventListener() {}
      send() {
        sendCalls++;
        throw new Error("host send boom");
      }
    }
    const prev = (globalThis as Record<string, unknown>).XMLHttpRequest;
    (globalThis as Record<string, unknown>).XMLHttpRequest = ThrowingSendXHR as never;
    try {
      const { config, pool, enricher } = makePool();
      const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
      listener.initialize();

      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof ThrowingSendXHR }).XMLHttpRequest();
      xhr.open("POST", "https://ingest.example/json/rum"); // own ingest → ignored path

      expect(() => xhr.send()).toThrow("host send boom");
      expect(sendCalls).toBe(1);
      listener.destroy();
    } finally {
      (globalThis as Record<string, unknown>).XMLHttpRequest = prev;
    }
  });

  it("restores the original XMLHttpRequest methods on destroy", () => {
    const before = FakeXHR.prototype.open;
    const { config, pool, enricher } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();
    expect(FakeXHR.prototype.open).not.toBe(before);
    listener.destroy();
    expect(FakeXHR.prototype.open).toBe(before);
  });
});

// The fetch patch, exercised over the runtime's REAL Request/Response/Headers.
// Using the real classes is the point: the failure mode being pinned here is a
// Fetch-spec rule (`new Request(input, init)` REPLACES the header list when
// `init.headers` is present), so a hand-rolled fake would hide it.
describe("NetworkEventsListener (fetch)", () => {
  let originalFetch: unknown;
  // What the wrapper handed to the real fetch, per call.
  let calls: Array<{ input: unknown; init: unknown }>;

  // The headers the platform will actually put on the wire for a captured call.
  // This is the same construction the runtime performs, so it reflects the
  // caller's Request plus whatever `init` the wrapper substituted.
  function outgoingHeaders(call: { input: unknown; init: unknown }): Headers {
    return new Request(call.input as Request, call.init as RequestInit).headers;
  }

  // The response body is read from a promise chain the wrapper does not expose,
  // so yield the microtask queue until it has settled before asserting.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Event attributes arrive FLATTENED into dotted keys ("gc.response.body"),
  // not as a nested object — assert against the shape that actually ships.
  function networkAttributes(send: ReturnType<typeof vi.fn>): Record<string, string> | undefined {
    for (const [batch] of send.mock.calls) {
      const events = (batch as { events?: Array<{ type?: string; attributes?: Record<string, string> }> })?.events ?? [];
      const hit = events.find((e) => e?.type === "network");
      if (hit) return hit.attributes;
    }
    return undefined;
  }

  function installFetch(response: () => Response) {
    calls = [];
    const fake = vi.fn((input: unknown, init?: unknown) => {
      calls.push({ input, init });
      return Promise.resolve(response());
    });
    (globalThis as Record<string, unknown>).fetch = fake as never;
  }

  let originalXHR: unknown;

  beforeEach(() => {
    originalFetch = (globalThis as Record<string, unknown>).fetch;
    // `initialize()` bails before it ever installs the fetch patch when there is no
    // XMLHttpRequest global, so the fetch patch is only reachable with one
    // present — as it always is on a device.
    originalXHR = (globalThis as Record<string, unknown>).XMLHttpRequest;
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR as never;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch as never;
    (globalThis as Record<string, unknown>).XMLHttpRequest = originalXHR as never;
    vi.restoreAllMocks();
  });

  it("keeps the caller's own headers when the request is a Request object and tracing is on", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher } = makePool(["https://api.example.com/*"]);
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    // The `fetch(new Request(...))` call style: headers live on the Request, and
    // the caller passes no `init` at all. openapi-fetch and every generated API
    // client does this.
    await (globalThis as unknown as { fetch: typeof fetch }).fetch(
      new Request("https://api.example.com/me", {
        headers: { Authorization: "Bearer secret-token", "X-Api-Version": "3" },
      })
    );

    expect(calls).toHaveLength(1);
    const sent = outgoingHeaders(calls[0]!);
    // Instrumentation must be additive: the trace header goes on, and nothing
    // the caller set comes off. Dropping Authorization turns a working request
    // into a 401 in the host app.
    expect(sent.get("authorization")).toBe("Bearer secret-token");
    expect(sent.get("x-api-version")).toBe("3");
    expect(sent.get("traceparent")).toBeTruthy();

    listener.destroy();
  });

  /**
   * The mirror of the test above.
   *
   * A present `init.headers` REPLACES the Request's list — Expo resolves them as
   * `init?.headers ?? request.headers`, and the Fetch standard says the same — so
   * `fetch(req, { headers })` is how a caller DROPS a credential before a retry or a
   * cross-host redirect. Using the Request's headers as an unconditional merge base puts it
   * back, and with tracing on that merged map becomes the `init` handed to the real fetch:
   * the Authorization the caller deliberately removed goes out on the wire.
   */
  it("does not restore a header the caller removed by passing init.headers", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher, send } = makePool(["https://api.example.com/*"]);
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch(
      new Request("https://api.example.com/me", {
        headers: { Authorization: "Bearer secret-token", "X-Api-Version": "3" },
      }),
      { headers: { "X-Api-Version": "4" } }
    );
    await settle();
    await pool.flush({ lifecycle: true });

    const sent = outgoingHeaders(calls[0]!);
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("x-api-version")).toBe("4");
    // Still additive for our OWN header — dropping the merge must not disarm tracing.
    expect(sent.get("traceparent")).toBeTruthy();

    // …and telemetry must not claim a header that never went out.
    expect(networkAttributes(send)).not.toHaveProperty("http.request.headers.authorization");

    listener.destroy();
  });

  it("reports the caller's Request headers on the captured event", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher, send } = makePool(["https://api.example.com/*"]);
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch(
      new Request("https://api.example.com/me", { headers: { "X-Api-Version": "3" } })
    );
    await settle();
    await pool.flush({ lifecycle: true });

    // Telemetry that omits the headers the request actually carried is
    // misleading, not merely incomplete.
    expect(networkAttributes(send)).toHaveProperty("http.request.headers.x-api-version", "3");

    listener.destroy();
  });

  /**
   * React Native's `whatwg-fetch` response exposes no `body.getReader()`, so the
   * streaming path never runs there — the fallback IS the RN path, not an edge
   * case. An unrestricted `text()` there would decode the whole body into a JS
   * string before the 5 KB cap is applied: a 50 MB download buffered on the JS
   * thread to keep 5 KB of it.
   *
   * `blob()` moves the bytes without decoding them, so `size` answers "is this
   * worth reading?" for free.
   */
  function noStreamResponse(body: string, opts: { blob?: boolean; size?: number } = {}) {
    const text = vi.fn(() => Promise.resolve(body));
    const clone: Record<string, unknown> = { text, body: null };
    if (opts.blob !== false) {
      // A REAL Blob where the body is meant to be read (FileReader rejects
      // anything else); a size-only stand-in for the oversized case, which is
      // answered from `size` and must never reach a reader — allocating 6 MB to
      // prove we do not read it would be self-defeating.
      clone.blob = () =>
        Promise.resolve(opts.size === undefined ? new Blob([body]) : ({ size: opts.size } as never));
    }
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      clone: () => clone,
    } as unknown as Response;
    return { response, text };
  }

  it("reports an oversized no-stream body as too large without decoding it", async () => {
    // 6 MB, well past the 5000-char cap.
    const { response, text } = noStreamResponse("x".repeat(64), { size: 6_000_000 });
    installFetch(() => response);
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/huge");
    await settle();
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)?.["gc.response.body"]).toBe("[response body too large]");
    // The point of the bound: the body is never decoded at all.
    expect(text).not.toHaveBeenCalled();

    listener.destroy();
  });

  it("still captures a small no-stream body", async () => {
    // The bound must not cost RN its response bodies — this is the ordinary case.
    // FileReader is stubbed for the same reason the XHR blob test above stubs it:
    // node has no such global, while the RN runtime this path exists for does.
    class FakeFileReader {
      result: string | null = null;
      error: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText() {
        this.result = '{"ok":true}';
        this.onload?.();
      }
      abort() {}
    }
    const prevFR = (globalThis as Record<string, unknown>).FileReader;
    (globalThis as Record<string, unknown>).FileReader = FakeFileReader as never;

    try {
      const { response } = noStreamResponse('{"ok":true}');
      installFetch(() => response);
      const { config, pool, enricher, send } = makePool();
      const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
      listener.initialize();

      await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/small");
      await settle();
      await settle();
      await pool.flush({ lifecycle: true });

      expect(String(networkAttributes(send)?.["gc.response.body"] ?? "")).toContain('"ok"');

      listener.destroy();
    } finally {
      (globalThis as Record<string, unknown>).FileReader = prevFR;
    }
  });

  it("reports the body unavailable when there is neither a stream nor a blob", async () => {
    const { response, text } = noStreamResponse('{"ok":true}', { blob: false });
    installFetch(() => response);
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/opaque");
    await settle();
    await settle();
    await pool.flush({ lifecycle: true });

    // No bounded read exists on such a runtime, so nothing is read.
    expect(networkAttributes(send)?.["gc.response.body"]).toBe("[response body unavailable]");
    expect(text).not.toHaveBeenCalled();

    listener.destroy();
  });

  it("does not decode a binary response body, matching the XHR path", async () => {
    installFetch(
      () => new Response("\x89PNG\r\n\x1a\nbinary-pixels", { status: 200, headers: { "content-type": "image/png" } })
    );
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/avatar.png");
    await settle();
    await pool.flush({ lifecycle: true });

    // The XHR path classifies by content-type before reading (see
    // core's classifyBody). fetch must not be the transport that quietly
    // decodes image bytes into telemetry.
    const attrs = networkAttributes(send);
    expect(attrs).toBeDefined();
    expect(attrs?.["gc.response.body"]).not.toContain("binary-pixels");

    listener.destroy();
  });

  /**
   * Treating case-insensitive header names as case-SENSITIVE corrupts the request rather
   * than merely mis-reporting it: a caller's `Traceparent` and our `traceparent` are two JS
   * keys, which the runtime folds into one comma-joined value that is not a valid traceparent.
   */
  it("does not put two traceparents on the wire when the caller used a different casing", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher, send } = makePool(["https://api.example.com/*"]);
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/me", {
      headers: { Traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
    });
    await settle();
    await pool.flush({ lifecycle: true });

    const sent = outgoingHeaders(calls[0]!).get("traceparent") ?? "";
    expect(sent).not.toContain(",");

    // …and the captured event has to be able to find it, which a case-sensitive
    // lookup against a `Traceparent` key cannot.
    expect(networkAttributes(send)).toHaveProperty("http.request.headers.traceparent");

    listener.destroy();
  });

  it("reports an event-stream response without waiting on a stream that never closes", async () => {
    // A server-sent-events body stays open, so a capped read would hold the
    // event forever on a runtime with response streams (Expo).
    installFetch(
      () =>
        new Response(new ReadableStream({ start() {} }) as never, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    );
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/events");
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)?.["gc.response.body"]).toBe("[unreadable response body]");

    listener.destroy();
  });

  it("labels a binary Request body by its content-type instead of decoding it", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch(
      new Request("https://api.example.com/upload", {
        method: "POST",
        body: "raw-bytes",
        headers: { "content-type": "application/octet-stream" },
      })
    );
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)?.["gc.request.body"]).toBe("[binary data]");

    listener.destroy();
  });

  /**
   * `fetch(new Request(url, { body }))` — the shape every generated API client
   * produces — would put an empty string in telemetry if the body were only read
   * from `init`. Per the Fetch standard it lives on the Request when one is
   * passed as `input`, exactly as the headers do.
   */
  it("reports the body of a Request passed as fetch input", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch(
      new Request("https://api.example.com/orders", { method: "POST", body: '{"sku":"A1"}' })
    );
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)?.["gc.request.body"]).toContain("A1");

    listener.destroy();
  });

  /**
   * The same rule for the body, and the same asymmetry of consequences.
   *
   * An empty string is an explicit override, not a missing body: Expo resolves it as
   * `init.body ?? request.body`, and `??` keeps `""`. Reading `""` as "no body given" falls
   * through to the Request and reports a payload the server never received. (Bare RN's
   * whatwg-fetch disagrees — its falsy test would send the Request's body — but under-reporting
   * there is the safer half of that disagreement than publishing a body that was blanked.)
   */
  it("treats an empty init.body as the effective body, not as a missing one", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch(
      new Request("https://api.example.com/orders", { method: "POST", body: '{"sku":"A1"}' }),
      { method: "POST", body: "" }
    );
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)?.["gc.request.body"] ?? "").not.toContain("A1");

    listener.destroy();
  });

  /**
   * `maxBodyLength` has to bound the WORK, not just the string.
   *
   * Reading the whole body and then truncating means a 50 MB download is fully
   * buffered and decoded into a JS string on the JS thread before the cap is
   * applied — which is the cost the cap exists to avoid. Where the runtime gives
   * us a stream, stop pulling once we have enough.
   */
  it("stops pulling a streamed response body once the cap is reached", async () => {
    const chunk = "x".repeat(1000);
    let pulled = 0;
    installFetch(
      () =>
        new Response(
          // `as never`: React Native's own DOM types do not admit a stream as a
          // BodyInit, which is the same reason `readCappedText` keeps `text()` as
          // its fallback. Node's Response accepts one, so the streaming path is
          // still genuinely exercised here.
          new ReadableStream({
            pull(controller) {
              pulled += 1;
              if (pulled > 60) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode(chunk));
            },
          }) as never,
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const { config, pool, enricher } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/big");
    await settle();
    await settle();

    // The cap is 5000 characters, so ~6 chunks is all that is ever needed. The
    // bound is loose on purpose — a stream implementation is entitled to read
    // ahead — but reading all 60 means nothing bounded the decode at all.
    expect(pulled).toBeLessThan(30);

    listener.destroy();
  });

  // A fetch that REJECTS, which `installFetch` cannot express.
  function installFailingFetch(reject: () => unknown) {
    calls = [];
    const fake = vi.fn((input: unknown, init?: unknown) => {
      calls.push({ input, init });
      return Promise.reject(reject());
    });
    (globalThis as Record<string, unknown>).fetch = fake as never;
  }

  /**
   * Expo's fetch — the global `fetch` under Expo 57, which is what Expo apps run — rejects an
   * abort with its own `FetchError`. That class extends Error and assigns only `cause` and
   * `stack`, so `err.name` is the inherited `"Error"`:
   *
   *   export class FetchError extends Error {
   *     constructor(message, { cause, stack } = {}) { super(`fetch failed: ${message}`); … }
   *
   * Keying the abort check on the NAME therefore never matches on that runtime, and every
   * cancelled request ships as a network failure. A name-only check matches on no runtime that
   * reaches it: the runtime whose aborts DO carry `name: "AbortError"` is RN's XHR-backed
   * whatwg-fetch — which sets `usedXhr` and returns before this handler is ever attached.
   *
   * The signal is the transport-independent fact. It is also the same contract the XHR path
   * keeps by construction: it listens for load/error/timeout and never for abort.
   */
  it("does not report a cancelled request when the runtime's error carries no AbortError name", async () => {
    class FetchError extends Error {
      constructor(message: string) {
        super(`fetch failed: ${message}`);
      }
    }
    installFailingFetch(() => new FetchError("The operation was aborted."));
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const controller = new AbortController();
    controller.abort();
    await (globalThis as unknown as { fetch: typeof fetch })
      .fetch("https://api.example.com/search", { signal: controller.signal })
      .catch(() => {});
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)).toBeUndefined();

    listener.destroy();
  });

  /**
   * Same cancellation, expressed the other way round — the signal on a Request rather than on
   * `init`. React Query and friends build the Request themselves.
   */
  it("does not report a cancelled request when the signal rides on the Request", async () => {
    installFailingFetch(() => new Error("fetch failed: The operation was aborted."));
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const controller = new AbortController();
    controller.abort();
    const request = new Request("https://api.example.com/search", { signal: controller.signal });
    await (globalThis as unknown as { fetch: typeof fetch }).fetch(request).catch(() => {});
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)).toBeUndefined();

    listener.destroy();
  });

  /**
   * The line the abort suppression must not cross. A genuine transport failure — DNS, refused
   * connection, TLS — also rejects with a bare Error and no name, and it is the case the
   * ERR_NETWORK_FAILURE event exists for. Suppressing on the error alone would silence it.
   */
  it("still reports a genuine network failure, which rejects the same way", async () => {
    installFailingFetch(() => new Error("Network request failed"));
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch })
      .fetch("https://api.example.com/orders")
      .catch(() => {});
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)?.["error.type"]).toBe("ERR_NETWORK_FAILURE");

    listener.destroy();
  });

  /**
   * React Native's global `Request` is whatwg-fetch's, and its Body mixin defines only
   * `_bodyInit` / `_bodyText` / `bodyUsed` — there is no `body` accessor at all. So a guard of
   * `req.body == null` is unconditionally true there and the body read is skipped, on the exact
   * runtime the fetch patch exists for. Expo reaches for the same hidden property in its own
   * `dangerouslyGetBodyFromRequest`, with the comment "whatwg-fetch has a hidden property for
   * the body input".
   *
   * The `clone().text()` that the guard skips works perfectly well there —
   * `Request.prototype.clone` passes `{body: this._bodyInit}`, so it neither throws nor consumes
   * the original. This test stands in the RN shape because vitest runs on node, where `Request`
   * is undici's with a real `body` stream — so the node-based Request-body test above does not
   * cover this shape.
   */
  it("reports the body of a Request whose body is a hidden property, as on React Native", async () => {
    installFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    // whatwg-fetch's Request, reduced to the properties that matter: headers (so the wrapper
    // recognises it), no `body`, the body behind `_bodyInit`, and a working clone.
    const rnRequest = {
      url: "https://api.example.com/orders",
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      _bodyInit: '{"sku":"A1"}',
      bodyUsed: false,
      clone: () => ({ text: () => Promise.resolve('{"sku":"A1"}') }),
    };

    await (globalThis as unknown as { fetch: (i: unknown) => Promise<unknown> }).fetch(rnRequest);
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkAttributes(send)?.["gc.request.body"]).toContain("A1");

    listener.destroy();
  });
});

// Which of the two transports actually reports a request.
//
// The listener patches both XHR and fetch, so on any runtime where fetch is
// implemented OVER XMLHttpRequest one request passes through both patches.
// Getting that judgement wrong is not cosmetic: too eager and every request is
// billed and charted twice, too shy and a whole runtime reports no network at
// all. `fetch.polyfill` cannot be the signal — it is set by exactly one
// implementation (whatwg-fetch) out of several that behave this way — so the
// decision is made per call.
describe("NetworkEventsListener (fetch / XHR overlap)", () => {
  let originalFetch: unknown;
  let originalXHR: unknown;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Every reported URL, in order, so a test can say WHICH request went missing
   *  or got counted twice rather than only how many did. */
  function reportedUrls(send: ReturnType<typeof vi.fn>): string[] {
    const urls: string[] = [];
    for (const [batch] of send.mock.calls) {
      // Attributes reach the transporter dot-flattened, so `url: { full }` is
      // read back as "url.full".
      const events =
        (batch as { events?: Array<{ type?: string; attributes?: Record<string, unknown> }> })?.events ?? [];
      for (const event of events) {
        if (event?.type === "network") urls.push(String(event.attributes?.["url.full"] ?? ""));
      }
    }
    return urls;
  }

  function networkEventCount(send: ReturnType<typeof vi.fn>): number {
    let n = 0;
    for (const [batch] of send.mock.calls) {
      const events = (batch as { events?: Array<{ type?: string }> })?.events ?? [];
      n += events.filter((e) => e?.type === "network").length;
    }
    return n;
  }

  beforeEach(() => {
    originalFetch = (globalThis as Record<string, unknown>).fetch;
    originalXHR = (globalThis as Record<string, unknown>).XMLHttpRequest;
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR as never;
    FakeXHR.instances = [];
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch as never;
    (globalThis as Record<string, unknown>).XMLHttpRequest = originalXHR as never;
    vi.restoreAllMocks();
  });

  /**
   * A fetch built on XMLHttpRequest — which is what React Native's own
   * `whatwg-fetch` is, and what several vendored replacements are too — but
   * WITHOUT the `polyfill` marker. Every request then goes through both patches.
   */
  function installXhrBackedFetch(marked: boolean) {
    const fake = function (input: unknown) {
      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
      xhr.open("GET", String(input));
      xhr.send();
      // The real thing resolves once the XHR completes; firing "load" is what
      // makes the XHR path emit.
      return Promise.resolve().then(() => {
        xhr.__fire("load");
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
      });
    } as unknown as { polyfill?: boolean };
    if (marked) fake.polyfill = true;
    (globalThis as Record<string, unknown>).fetch = fake as never;
  }

  it("reports one event, not two, when fetch is XHR-backed but unmarked", async () => {
    installXhrBackedFetch(false);
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/things");
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkEventCount(send)).toBe(1);

    listener.destroy();
  });

  /**
   * The other direction. A runtime that sets the marker but does NOT go through
   * XMLHttpRequest — an Expo/WinterCG native fetch shimmed under the same name —
   * would be skipped by a marker check and captured by nobody, so the SDK would
   * report no network traffic whatsoever and look merely quiet.
   */
  it("reports a marked fetch that does not actually use XMLHttpRequest", async () => {
    const fake = function () {
      return Promise.resolve(
        new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
      );
    } as unknown as { polyfill?: boolean };
    fake.polyfill = true;
    (globalThis as Record<string, unknown>).fetch = fake as never;

    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/things");
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkEventCount(send)).toBe(1);

    listener.destroy();
  });

  /**
   * The two patches are independent captures and must fail independently.
   *
   * A fetch that cannot be wrapped must not cost the XHR capture, and the
   * reverse: if the XHR path returned early, a host that has made
   * XMLHttpRequest.prototype non-writable — a hardening shim, another SDK's
   * frozen patch — would lose fetch capture as well, and with it every network
   * event.
   */
  it("still captures XHR, and does not throw, when reading the global fetch throws", async () => {
    // A host can put `fetch` behind a throwing accessor. Discovering it must be
    // as contained as installing it: the XHR group is already on by then.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      get: () => {
        throw new Error("fetch accessor blew up");
      },
    });
    try {
      const { config, pool, enricher, send } = makePool();
      const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
      expect(() => listener.initialize()).not.toThrow();

      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
      xhr.open("GET", "https://api.example.com/things");
      xhr.send();
      xhr.__fire("load");
      await pool.flush({ lifecycle: true });

      expect(networkEventCount(send)).toBe(1);
      listener.destroy();
    } finally {
      // Restore the own property, or drop our accessor if fetch was inherited.
      if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
      else delete (globalThis as { fetch?: unknown }).fetch;
    }
  });

  it("still captures fetch when the XHR patch cannot be installed", async () => {
    class FrozenXHR extends FakeXHR {}
    Object.defineProperty(FrozenXHR.prototype, "open", {
      value: FakeXHR.prototype.open,
      writable: false,
      configurable: false,
    });
    (globalThis as Record<string, unknown>).XMLHttpRequest = FrozenXHR as never;

    const fake = vi.fn(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }))
    );
    (globalThis as Record<string, unknown>).fetch = fake as never;

    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/things");
    await settle();
    await pool.flush({ lifecycle: true });

    expect(networkEventCount(send)).toBe(1);

    listener.destroy();
    // ...and the fetch wrapper must come off too. A `destroy()` that skipped the
    // fetch restore because the XHR patch failed — exactly the state this test
    // creates — would leave the wrapper on the global for the life of the process.
    expect((globalThis as Record<string, unknown>).fetch).toBe(fake);
  });

  /**
   * `fetch(url, { headers: [["Authorization", "Bearer x"]] })` is a shape the spec
   * allows and RN apps use. Arrays have `forEach`, so testing the Headers-like
   * shape first would send it down the iterable branch with `value` = the pair
   * and `key` = the index, producing `{ "0": "Authorization,Bearer x" }`.
   *
   * Not cosmetic: with tracing on, the outgoing `init.headers` is rebuilt from
   * this map, so the caller's real Authorization would never reach the wire and
   * the request would get a 401.
   */
  it("preserves tuple-array request headers when tracing rewrites them", async () => {
    const seen: Array<Record<string, string>> = [];
    const fake = vi.fn((_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ ...(init?.headers ?? {}) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    (globalThis as Record<string, unknown>).fetch = fake as never;

    const { config, pool, enricher } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: (u: string, i: unknown) => Promise<unknown> }).fetch(
      "https://api.example.com/things",
      {
        headers: [
          ["Authorization", "Bearer secret"],
          ["X-Custom", "kept"],
        ],
      }
    );
    await settle();

    const sent = seen[0] ?? {};
    expect(sent["authorization"]).toBe("Bearer secret");
    expect(sent["x-custom"]).toBe("kept");
    expect(sent["0"]).toBeUndefined(); // the shape the wrong branch order produces
    expect(sent["traceparent"]).toBeDefined(); // tracing still injected

    listener.destroy();
  });

  /**
   * The fetch teardown has to run even when the XHR patch never installed, and
   * that puts a host-controlled assignment in the teardown path. A `fetch` with
   * a throwing setter must not strand the XHR restore behind it — that would
   * trade one leaked wrapper for a worse one. Teardown must complete either way.
   */
  it("still restores XHR when the host's fetch cannot be assigned back", async () => {
    const openBefore = FakeXHR.prototype.open;

    const { config, pool, enricher } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    // Only now make the global hostile, so initialize() could still install.
    // The getter must return OUR wrapper: `destroy()` only assigns where it is
    // still the installed wrapper, so a getter returning anything else short-
    // circuits before the setter and the test proves nothing.
    // Restored in `finally` — a throwing setter left in place would defeat
    // afterEach's plain assignment and break every test after this one.
    const installed = (globalThis as Record<string, unknown>).fetch;
    const before = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", {
      get: () => installed,
      set: () => {
        throw new Error("fetch is not assignable here");
      },
      configurable: true,
    });

    try {
      expect(() => listener.destroy()).not.toThrow();
      expect(FakeXHR.prototype.open).toBe(openBefore);
    } finally {
      if (before) Object.defineProperty(globalThis, "fetch", before);
      else delete (globalThis as Record<string, unknown>).fetch;
    }
  });

  /**
   * Whether a request went through XMLHttpRequest is a fact about the CALL, not the runtime.
   * The two cases above are uniform, so a latch would serve them — but not a `fetch` that
   * tunnels only SOME requests (a layered SDK patch falling back for one host, a streaming
   * request taking another path): the first tunnelled request would set the latch, and every
   * native-path request after it would be captured by nobody.
   *
   * The same silent-total-loss failure as a `fetch.polyfill` marker check. A doubled request
   * is visible in the product; a missing one looks like a quiet app.
   */
  function installConditionallyTunnelledFetch() {
    const fake = function (input: unknown) {
      const url = String(input);
      const json = { status: 200, headers: { "content-type": "application/json" } };
      if (!url.includes("/tunnelled")) return Promise.resolve(new Response('{"ok":true}', json));
      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
      xhr.open("GET", url);
      xhr.send();
      return Promise.resolve().then(() => {
        xhr.__fire("load");
        return new Response('{"ok":true}', json);
      });
    };
    (globalThis as Record<string, unknown>).fetch = fake as never;
  }

  it("keeps capturing native-path fetches after one request tunnels through XHR", async () => {
    installConditionallyTunnelledFetch();
    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    const g = globalThis as unknown as { fetch: typeof fetch };
    await g.fetch("https://api.example.com/tunnelled");
    await settle();
    await g.fetch("https://api.example.com/native");
    await settle();
    await pool.flush({ lifecycle: true });

    // One event each, from whichever transport actually carried it.
    expect(reportedUrls(send).sort()).toEqual([
      "https://api.example.com/native",
      "https://api.example.com/tunnelled",
    ]);

    listener.destroy();
  });

  /**
   * The per-call answer has to nest, because `fetch` implementations call `fetch`.
   *
   * Here the host's fetch delegates a sub-request to the global (our wrapper)
   * and only then opens its own XHR. If the inner call clears the probe on the
   * way out instead of restoring the outer one, that XHR is attributed to
   * nothing, the outer call believes it was native, and the tunnelled request is
   * reported twice — once by the XHR patch and once by the fetch wrapper.
   */
  it("attributes an XHR opened after a nested fetch to the outer call", async () => {
    const json = { status: 200, headers: { "content-type": "application/json" } };
    const fake = function (input: unknown) {
      const url = String(input);
      if (!url.includes("/outer")) return Promise.resolve(new Response('{"ok":true}', json));
      // A sub-request through the PATCHED global, resolved before this one
      // opens its own transport.
      void (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/inner");
      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
      xhr.open("GET", url);
      xhr.send();
      return Promise.resolve().then(() => {
        xhr.__fire("load");
        return new Response('{"ok":true}', json);
      });
    };
    (globalThis as Record<string, unknown>).fetch = fake as never;

    const { config, pool, enricher, send } = makePool();
    const listener = new NetworkEventsListener({ config, eventsPool: pool, enricher });
    listener.initialize();

    await (globalThis as unknown as { fetch: typeof fetch }).fetch("https://api.example.com/outer");
    await settle();
    await pool.flush({ lifecycle: true });

    expect(reportedUrls(send).sort()).toEqual(["https://api.example.com/inner", "https://api.example.com/outer"]);

    listener.destroy();
  });
});
