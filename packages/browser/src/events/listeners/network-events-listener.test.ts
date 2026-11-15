import { describe, it, expect, beforeEach, vi, type Mock, type MockedFunction } from "vitest";
import { NetworkEventsListener } from "./network-events-listener";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";
import { DEFAULT_SDK_CONFIG_OPTIONS } from "@groundcover/rum-core/config/constants";

const createConfigMock = (
  tracePropagationUrls: string[] = [],
  excludedUrls: Array<string | RegExp> = [],
  tracePropagationTraceIdHeaderName?: string,
  tracePropagationSpanIdHeaderName?: string,
  tracePropagationHeaders?: string[]
) => ({
  dsn: "test-dsn",
  appId: "test-app-id",
  cluster: "test-cluster",
  environment: "test-environment",
  apiKey: "test-api-key",
  user: {
    id: "test-user-id",
    email: "test-user-email",
  },
  getEndpoint: () => "test-endpoint",
  updateConfig: vi.fn(),
  options: {
    ...DEFAULT_SDK_CONFIG_OPTIONS,
    excludedUrls,
    tracing: {
      propagationUrls: tracePropagationUrls,
      traceIdHeaderName: tracePropagationTraceIdHeaderName || "",
      spanIdHeaderName: tracePropagationSpanIdHeaderName || "",
      propagationHeaders: tracePropagationHeaders, // Don't default to empty array
    },
  },
});

describe("NetworkEventsListener", () => {
  let listener: NetworkEventsListener;
  let configManager: ConfigManager;

  beforeEach(() => {
    // Mock the global location
    global.location = {
      href: "https://example.com",
    } as Location;

    // Fresh DI graph per test: a real ConfigManager the tests spy on, a real
    // enricher (so buildEvent enriches as in production), and a stub pool.
    configManager = new ConfigManager();
    listener = new NetworkEventsListener({
      config: configManager,
      eventsPool: { addEvent: vi.fn() } as unknown as EventsPool,
      enricher: new EventEnricher(),
    });
  });

  describe("destroy() restores patched globals", () => {
    // A no-op destroy() (e.g. `globalThis.fetch = globalThis.fetch`) would leave
    // the fetch/XHR wrappers installed, and on re-init the stale wrapper would
    // keep applying its old tracing config. destroy() must restore the exact
    // originals captured at initialize().
    it("restores the original fetch", () => {
      const before = globalThis.fetch;
      listener.initialize();
      expect(globalThis.fetch).not.toBe(before); // wrapped
      listener.destroy();
      expect(globalThis.fetch).toBe(before); // restored
    });

    it("restores XMLHttpRequest.prototype open/send/setRequestHeader", () => {
      const open = globalThis.XMLHttpRequest.prototype.open;
      const send = globalThis.XMLHttpRequest.prototype.send;
      const setHeader = globalThis.XMLHttpRequest.prototype.setRequestHeader;
      listener.initialize();
      expect(globalThis.XMLHttpRequest.prototype.open).not.toBe(open); // wrapped
      listener.destroy();
      expect(globalThis.XMLHttpRequest.prototype.open).toBe(open);
      expect(globalThis.XMLHttpRequest.prototype.send).toBe(send);
      expect(globalThis.XMLHttpRequest.prototype.setRequestHeader).toBe(setHeader);
    });

    it("keeps the XHR capture when fetch can't be wrapped — no orphaned wrapper, no crash", () => {
      // The transports fail independently: a host that made fetch non-writable
      // loses the fetch capture only. Per CONTRIBUTING.md ("Never break the
      // host app"), initialize() must not throw, and nothing it
      // could not install may be left half-wrapped.
      const openBefore = globalThis.XMLHttpRequest.prototype.open;
      const fetchBefore = globalThis.fetch;
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        get: () => fetchBefore,
        set: () => {
          throw new TypeError("fetch is read-only");
        },
      });
      try {
        expect(() => listener.initialize()).not.toThrow();
        expect(globalThis.fetch).toBe(fetchBefore);
        expect(globalThis.XMLHttpRequest.prototype.open).not.toBe(openBefore);

        expect(() => listener.destroy()).not.toThrow();
        expect(globalThis.XMLHttpRequest.prototype.open).toBe(openBefore);
      } finally {
        // Restore the own property, or drop our accessor if fetch was inherited.
        if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
        else delete (globalThis as { fetch?: unknown }).fetch;
      }
    });

    it("rolls the XHR group back whole when one of its methods can't be wrapped", () => {
      // open/setRequestHeader/send only work together: a wrapped send without
      // its open never has a URL to report.
      const proto = globalThis.XMLHttpRequest.prototype;
      const openBefore = proto.open;
      const sendBefore = proto.send;
      const fetchBefore = globalThis.fetch;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "send");
      Object.defineProperty(proto, "send", {
        configurable: true,
        get: () => sendBefore,
        set: () => {
          throw new TypeError("send is read-only");
        },
      });
      try {
        expect(() => listener.initialize()).not.toThrow();
        expect(proto.open).toBe(openBefore);
        // …while fetch, a separate group, is still captured.
        expect(globalThis.fetch).not.toBe(fetchBefore);
      } finally {
        if (descriptor) Object.defineProperty(proto, "send", descriptor);
        else delete (proto as unknown as Record<string, unknown>).send;
        listener.destroy();
      }
    });

    it("a fresh listener under a host wrapper captures once — the retired wrapper stays inert", async () => {
      // Re-instrumentation builds a NEW listener (see InstrumentationManager);
      // the retired one's wrapper, still reachable through the host's, keeps its
      // own `active` false, so it neither captures nor adds trace headers.
      const native = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(() =>
        Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
      );
      globalThis.fetch = native as unknown as typeof fetch;
      vi.spyOn(configManager, "getConfig").mockReturnValue(createConfigMock(["*"]));

      listener.initialize();
      const retiredAddEvent = (listener as unknown as { eventsPool: { addEvent: ReturnType<typeof vi.fn> } })
        .eventsPool.addEvent;
      const retired = globalThis.fetch;
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => retired(...args)) as typeof fetch;
      listener.destroy();

      const addEvent = vi.fn();
      const fresh = new NetworkEventsListener({
        config: configManager,
        eventsPool: { addEvent } as unknown as EventsPool,
        enricher: new EventEnricher(),
      });
      fresh.initialize();
      await globalThis.fetch("https://api.example.com/things");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(addEvent).toHaveBeenCalledTimes(1);
      expect(retiredAddEvent).not.toHaveBeenCalled();
      const [, init] = native.mock.calls[0] as [unknown, RequestInit];
      expect(new Headers(init.headers).get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      fresh.destroy();
    });

    it("does NOT clobber a host fetch wrapper layered on top of ours", () => {
      // destroy() must only unwrap OUR layer. If a host (or another lib)
      // wraps fetch AFTER our initialize(), a blind restore to the pre-SDK
      // original would discard the host's wrapper entirely.
      const before = globalThis.fetch;
      listener.initialize();
      const ourWrapper = globalThis.fetch;
      expect(ourWrapper).not.toBe(before);
      const hostWrapper = ((...args: Parameters<typeof fetch>) =>
        ourWrapper(...args)) as typeof fetch;
      globalThis.fetch = hostWrapper;
      listener.destroy();
      expect(globalThis.fetch).toBe(hostWrapper); // host wrapper preserved
    });

    it("stays inert via a host delegation chain after destroy (no stale tracing)", async () => {
      // A guarded restore correctly declines to restore when a host wrapped us
      // and still DELEGATES to our retired wrapper. But that leaves the chain
      // host → old SDK wrapper → native alive. A destroyed wrapper must add NO
      // tracing headers (and capture nothing), else the previous graph's tracing
      // config keeps mutating requests across a re-init.
      const prev = globalThis.fetch;
      const nativeFetch = vi.fn().mockResolvedValue({
        status: 200,
        clone: () => ({
          text: () => Promise.resolve(""),
          headers: new Headers(),
        }),
        headers: new Headers(),
      });
      globalThis.fetch = nativeFetch as unknown as typeof fetch;

      try {
        // Tracing enabled for every URL, with custom trace/span headers.
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id", "x-span-id") as unknown as ReturnType<
            ConfigManager["getConfig"]
          >
        );

        listener.initialize();
        const ourWrapper = globalThis.fetch;
        expect(ourWrapper).not.toBe(nativeFetch); // wrapped

        // Host wraps us AFTER init, delegating to the current (our) fetch.
        const hostWrapper = ((...args: Parameters<typeof fetch>) =>
          ourWrapper(...args)) as typeof fetch;
        globalThis.fetch = hostWrapper;

        listener.destroy();

        // Drive a request through host → retired SDK wrapper → native.
        await globalThis.fetch("https://api.example.com/orders");

        expect(nativeFetch).toHaveBeenCalledTimes(1);
        const init = nativeFetch.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers);
        expect(headers.has("x-trace-id")).toBe(false);
        expect(headers.has("x-span-id")).toBe(false);
        expect(headers.has("traceparent")).toBe(false);
      } finally {
        globalThis.fetch = prev;
      }
    });

    it("handleEvent drops an in-flight completion that fires after destroy()", () => {
      // The `active` entry-guard stops NEW wrapper calls, but a
      // fetch/XHR that STARTED while active can complete AFTER destroy() and its
      // continuation (fetch `emit()` / XHR `load`) still calls handleEvent —
      // enqueuing telemetry into the torn-down graph. Gate handleEvent itself.
      const addEvent = vi.fn();
      const enricher = new EventEnricher();
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock([], []) as unknown as ReturnType<ConfigManager["getConfig"]>
      );
      const l = new NetworkEventsListener({
        config: configManager,
        eventsPool: { addEvent } as unknown as EventsPool,
        enricher,
      });

      l.initialize();
      l.destroy();
      // Simulate an in-flight callback firing after teardown.
      l.handleEvent({
        method: "GET",
        url: "https://api.example.com/orders",
        timestamp: 1,
        end_time: 2,
        status: 200,
        request: { headers: {}, body: "" },
        response: { headers: {}, body: "" },
      });

      expect(addEvent).not.toHaveBeenCalled();
    });
  });

  describe("shouldIgnoreRequest", () => {
    it("should ignore requests with specific file extensions", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(createConfigMock());

      expect(
        listener["shouldIgnoreRequest"]("https://example.com/file.tsx")
      ).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/file.jsx")
      ).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/file.css")
      ).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/file.js")
      ).toBe(false);
    });

    it("should handle case-insensitive file extensions", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(createConfigMock());

      expect(
        listener["shouldIgnoreRequest"]("https://example.com/file.TSX")
      ).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/file.Jsx")
      ).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/file.CSS")
      ).toBe(true);
    });

    it("should ignore exact URL matches from excludedUrls", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock([], ["/api/health", "https://example.com/metrics"])
      );

      expect(listener["shouldIgnoreRequest"]("/api/health")).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/metrics")
      ).toBe(true);
      expect(listener["shouldIgnoreRequest"]("/api/health/details")).toBe(
        false
      );
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/metrics/daily")
      ).toBe(false);
    });

    it("should ignore URLs matching RegExp patterns from excludedUrls", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock([], [/^\/api\/v[0-9]+\//, /\.(jpg|png|gif)$/i])
      );

      expect(listener["shouldIgnoreRequest"]("/api/v1/users")).toBe(true);
      expect(listener["shouldIgnoreRequest"]("/api/v2/orders")).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/image.jpg")
      ).toBe(true);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/image.PNG")
      ).toBe(true);
      expect(listener["shouldIgnoreRequest"]("/api/users")).toBe(false);
      expect(
        listener["shouldIgnoreRequest"]("https://example.com/image.svg")
      ).toBe(false);
    });

    it("should handle null config gracefully", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(null);

      expect(listener["shouldIgnoreRequest"]("/api/health")).toBe(false);
    });

    it("should handle errors gracefully", () => {
      vi.spyOn(configManager, "getConfig").mockImplementation(() => {
        throw new Error("Config error");
      });

      expect(listener["shouldIgnoreRequest"]("/api/health")).toBe(false);
    });

    it("should ignore requests to the getEndpoint URL", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock([], [])
      );

      expect(listener["shouldIgnoreRequest"]("test-endpoint")).toBe(true);
    });
  });

  describe("shouldAddTraceHeader", () => {
    it("should return false when no config is available", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(null);

      expect(listener.shouldAddTraceHeader("https://api.example.com")).toBe(
        false
      );
    });

    it("should return false when tracePropagationUrls is empty", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(createConfigMock());

      expect(listener.shouldAddTraceHeader("https://api.example.com")).toBe(
        false
      );
    });

    it("should match exact URLs", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock(["https://api.example.com"])
      );

      expect(listener.shouldAddTraceHeader("https://api.example.com")).toBe(
        true
      );
      expect(listener.shouldAddTraceHeader("https://other.example.com")).toBe(
        false
      );
    });

    it("should match wildcard patterns", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock(["*.example.com"])
      );

      expect(listener.shouldAddTraceHeader("https://api.example.com")).toBe(
        true
      );
      expect(listener.shouldAddTraceHeader("https://test.example.com")).toBe(
        true
      );
      expect(listener.shouldAddTraceHeader("https://example.org")).toBe(false);
    });

    it("should handle relative paths correctly", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock(["/api/*", "http://localhost:8080/api/*"])
      );

      expect(listener.shouldAddTraceHeader("/api/users")).toBe(true);
      expect(
        listener.shouldAddTraceHeader("http://localhost:8080/api/users")
      ).toBe(true);
      expect(listener.shouldAddTraceHeader("/api/orders")).toBe(true);
      expect(listener.shouldAddTraceHeader("/other/path")).toBe(false);
    });

    it("should match multiple patterns", () => {
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock(["/api/*", "*.example.com"])
      );

      expect(listener.shouldAddTraceHeader("/api/users")).toBe(true);
      expect(listener.shouldAddTraceHeader("https://api.example.com")).toBe(
        true
      );
      expect(listener.shouldAddTraceHeader("https://example.org")).toBe(false);
    });

    it("treats only `*` as a wildcard — a `.` in the pattern never matches a lookalike host", () => {
      // Unescaped, `https://api.example.com/*` would compile to a regex whose
      // `.` matches any character, injecting trace headers (and
      // `tracing.origin`) into requests to attacker-registrable lookalike hosts.
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock(["https://api.example.com/*", "https://v1+api.example.com/*"])
      );

      expect(listener.shouldAddTraceHeader("https://api.example.com/users")).toBe(true);
      expect(listener.shouldAddTraceHeader("https://v1+api.example.com/users")).toBe(true);
      expect(listener.shouldAddTraceHeader("https://api-example.com/steal")).toBe(false);
      expect(listener.shouldAddTraceHeader("https://apiXexampleYcom/steal")).toBe(false);
      expect(listener.shouldAddTraceHeader("https://v11api.example.com/users")).toBe(false);
    });

    it("matches the URL the browser will actually request, not the string as written", () => {
      // location is https://example.com (see beforeEach). Dot segments resolve
      // away, so "/api/../private" is a request for /private — matched on the
      // raw string it would get trace headers that XHR and Request inputs
      // (which arrive resolved) never do.
      vi.spyOn(configManager, "getConfig").mockReturnValue(
        createConfigMock(["/api/*", "https://example.com/api/*"])
      );

      expect(listener.shouldAddTraceHeader("/api/../private")).toBe(false);
      expect(listener.shouldAddTraceHeader("https://example.com/api/../private")).toBe(false);
      expect(listener.shouldAddTraceHeader("/private/../api/users")).toBe(true);
    });

    it("matches a path pattern against same-origin requests only, relative or absolute", () => {
      // location is https://example.com (see beforeEach).
      vi.spyOn(configManager, "getConfig").mockReturnValue(createConfigMock(["/api/*"]));

      expect(listener.shouldAddTraceHeader("/api/users")).toBe(true);
      // XHR stores the resolved URL, so a relative open() arrives absolute.
      expect(listener.shouldAddTraceHeader("https://example.com/api/users")).toBe(true);
      // Another host with the same path never gets our trace headers.
      expect(listener.shouldAddTraceHeader("https://third-party.test/api/users")).toBe(false);
      // Protocol-relative starts with "/" but is cross-origin.
      expect(listener.shouldAddTraceHeader("//third-party.test/api/users")).toBe(false);
    });
  });

  describe("buildEvent", () => {
    it("should truncate request and response bodies", () => {
      const event = {
        method: "GET",
        url: "https://example.com",
        body: "a".repeat(10000),
        status: 200,
        request: {
          body: "a".repeat(10000),
          headers: {},
        },
        response: {
          body: "b".repeat(10000),
          headers: {},
        },
      };

      const truncatedEvent = listener["buildEvent"](event);

      expect(truncatedEvent?.attributes?.["gc.request.body"]).toBe("a".repeat(5000));
      expect(truncatedEvent?.attributes?.["gc.response.body"]).toBe("b".repeat(5000));
    });

    it("should not truncate request and response bodies if they are less than maxBodyLength", () => {
      const event = {
        method: "GET",
        url: "https://example.com",
        body: "a".repeat(1000),
        status: 200,
        request: {
          body: "a".repeat(1000),
          headers: {},
        },
        response: {
          body: "b".repeat(1000),
          headers: {},
        },
      };

      const truncatedEvent = listener["buildEvent"](event);

      expect(truncatedEvent?.attributes?.["gc.request.body"]).toBe("a".repeat(1000));
      expect(truncatedEvent?.attributes?.["gc.response.body"]).toBe("b".repeat(1000));
  });

  it("should set correct headers", () => {
    const event = {
      method: "GET",
      url: "https://example.com",
      body: "a".repeat(1000),
      status: 200,
      request: {
        headers: {
          "ground": "cover",
        },
        body: '',
      },
      response: {
        headers: {  
          'cover': 'ground',
        },
        body: '',
      },
    };

    const truncatedEvent = listener["buildEvent"](event);

    expect(truncatedEvent?.attributes?.["http.request.headers.ground"]).toBe(
      'cover'
    );
    expect(truncatedEvent?.attributes?.["http.response.headers.cover"]).toBe(
      'ground'
    );
  });
  });

  describe("privacy redaction", () => {
    const REDACTED = "[REDACTED]";

    it("redacts sensitive keys in request/response bodies by default", () => {
      const event = {
        method: "POST",
        url: "https://example.com/token",
        body: "",
        status: 200,
        request: {
          headers: {},
          body: JSON.stringify({ user: "bob", password: "hunter2" }),
        },
        response: {
          headers: {},
          body: JSON.stringify({ access_token: "abc", ok: true }),
        },
      };

      const built = listener["buildEvent"](event);
      const reqBody = JSON.parse(built?.attributes?.["gc.request.body"] as string);
      const resBody = JSON.parse(built?.attributes?.["gc.response.body"] as string);

      expect(reqBody.user).toBe("bob");
      expect(reqBody.password).toBe(REDACTED);
      expect(resBody.access_token).toBe(REDACTED);
      expect(resBody.ok).toBe(true);
    });

    it("redacts a form-encoded body (an OAuth /token request)", () => {
      const event = {
        method: "POST",
        url: "https://example.com/token",
        body: "",
        status: 200,
        request: {
          headers: {},
          body: "grant_type=password&password=secret&user=bob",
        },
        response: { headers: {}, body: "" },
      };

      const built = listener["buildEvent"](event);
      const params = new URLSearchParams(
        built?.attributes?.["gc.request.body"] as string
      );
      expect(params.get("password")).toBe(REDACTED);
      expect(params.get("user")).toBe("bob");
    });

    it("redacts sensitive query params in url.full by default", () => {
      const event = {
        method: "GET",
        url: "https://example.com/api?token=abc123&page=2",
        body: "",
        status: 200,
        request: { headers: {}, body: "" },
        response: { headers: {}, body: "" },
      };

      const built = listener["buildEvent"](event);
      const fullUrl = built?.attributes?.["url.full"] as string;
      expect(fullUrl).not.toContain("abc123");
      expect(fullUrl).toContain(encodeURIComponent(REDACTED));
      expect(fullUrl).toContain("page=2");
    });

    it("does not redact bodies/url when level is allow", () => {
      vi.spyOn(configManager, "getPrivacy").mockReturnValue({
        level: "allow",
        maskNetworkBodies: false,
        maskNetworkQueryParams: false,
        maskLogs: false,
        maskErrors: false,
        shouldMaskNetworkBodies: false,
        shouldMaskNetworkQueryParams: false,
        shouldMaskLogs: false,
        shouldMaskErrors: false,
        sensitiveKeys: [],
      });

      const event = {
        method: "POST",
        url: "https://example.com/api?token=abc123",
        body: "",
        status: 200,
        request: {
          headers: { authorization: "Bearer xyz" },
          body: JSON.stringify({ password: "hunter2" }),
        },
        response: { headers: {}, body: "" },
      };

      const built = listener["buildEvent"](event);
      expect(built?.attributes?.["gc.request.body"]).toContain("hunter2");
      expect(built?.attributes?.["url.full"]).toContain("abc123");
      // Built-in sensitive headers are ALWAYS stripped, even under 'allow';
      // 'allow' only opts out of body/url/custom-redactor masking.
      expect(built?.attributes?.["http.request.headers.authorization"]).toBe(
        REDACTED
      );
    });

    it("applies a custom privacy.redact hook per leaf to bodies and url", () => {
      vi.spyOn(configManager, "getPrivacy").mockReturnValue({
        level: "mask-sensitive",
        maskNetworkBodies: true,
        maskNetworkQueryParams: true,
        maskLogs: true,
        maskErrors: true,
        shouldMaskNetworkBodies: true,
        shouldMaskNetworkQueryParams: true,
        shouldMaskLogs: true,
        shouldMaskErrors: true,
        sensitiveKeys: [],
        redact: (field) =>
          typeof field.value === "string"
            ? field.value.replace(/bob/g, "ANON")
            : undefined,
      });

      const event = {
        method: "POST",
        url: "https://example.com/api?user=bob",
        body: "",
        status: 200,
        request: { headers: {}, body: JSON.stringify({ user: "bob" }) },
        response: { headers: {}, body: "" },
      };

      const built = listener["buildEvent"](event);
      expect(built?.attributes?.["gc.request.body"]).toContain("ANON");
      expect(built?.attributes?.["gc.request.body"]).not.toContain("bob");
      expect(built?.attributes?.["url.full"]).toContain("ANON");
    });
  });

  describe("custom trace propagation headers", () => {
    describe("addHeaderToFetchRequest", () => {
      it("should add header to Headers object", () => {
        const headers = new Headers();
        const init = { headers };
        
        listener["addHeaderToFetchRequest"]({
          init,
          headerName: "x-trace-id",
          headerValue: "12345",
        });
        
        expect(headers.get("x-trace-id")).toBe("12345");
      });

      it("should add header to plain object headers", () => {
        const init = { headers: { "content-type": "application/json" } as Record<string, string> };
        
        listener["addHeaderToFetchRequest"]({
          init,
          headerName: "x-trace-id", 
          headerValue: "12345",
        });
        
        expect(init.headers["x-trace-id"]).toBe("12345");
        expect(init.headers["content-type"]).toBe("application/json");
      });

      it("should create headers object if none exists", () => {
        const init = {} as RequestInit;
        
        listener["addHeaderToFetchRequest"]({
          init,
          headerName: "x-trace-id",
          headerValue: "12345",
        });
        
        expect((init.headers as Record<string, string>)["x-trace-id"]).toBe("12345");
      });
    });

    describe("trace propagation with custom header names", () => {
      let mockFetch: MockedFunction<typeof fetch>;
      let mockXHR: Partial<XMLHttpRequest>;
      let mockSetRequestHeader: Mock<(name: string, value: string) => void>;

      beforeEach(() => {
        // Mock fetch
        mockFetch = vi.fn().mockResolvedValue({
          status: 200,
          clone: () => ({
            text: () => Promise.resolve("response body"),
            headers: new Headers({ "content-type": "application/json" }),
          }),
          headers: new Headers({ "content-type": "application/json" }),
        });
        global.fetch = mockFetch;

        // Store original XMLHttpRequest for proper mocking
        const OriginalXHR = global.XMLHttpRequest;
        
        // Mock XHR - create a constructor that returns our mock object
        mockSetRequestHeader = vi.fn();
        let loadCallback: (() => void) | undefined;
        
        mockXHR = {
          setRequestHeader: mockSetRequestHeader,
          addEventListener: vi.fn((event: string, callback: () => void) => {
            // Store the callback to call later
            if (event === 'load') {
              loadCallback = callback;
            }
          }),
          getAllResponseHeaders: () => "content-type: application/json",
          status: 200,
          responseText: "response body",
          responseType: "",
          open: vi.fn(),
          send: vi.fn(() => {
            // Simulate the load event after send
            if (loadCallback) {
              setTimeout(loadCallback, 0);
            }
          }),
        };

        // Create a mock constructor that returns our mock object
        const MockXHRConstructor = vi.fn(() => mockXHR);
        
        // Copy the original prototype methods to the mock constructor
        MockXHRConstructor.prototype = {
          open: OriginalXHR.prototype.open,
          send: OriginalXHR.prototype.send,
          setRequestHeader: OriginalXHR.prototype.setRequestHeader,
          addEventListener: OriginalXHR.prototype.addEventListener,
          getAllResponseHeaders: OriginalXHR.prototype.getAllResponseHeaders,
        };
        
        // Replace global XMLHttpRequest
        // @ts-expect-error - Mocking global XMLHttpRequest for test purposes
        global.XMLHttpRequest = MockXHRConstructor;
      });

      it("should add custom trace and span ID headers when configured", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(
            ["*"],
            [],
            "x-groundcover-trace-id",
            "x-groundcover-parent-id"
          )
        );

        listener.initialize();
        
        // Trigger fetch
        fetch("https://api.example.com", { method: "GET" });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        const headers = fetchInit.headers as Headers;
        expect(headers.get("x-groundcover-trace-id")).toMatch(/^\d+$/);
        expect(headers.get("x-groundcover-parent-id")).toMatch(/^\d+$/);
      });

      it("should add custom headers in XHR requests when configured", () => {
        // Test the addHeaderToXhrRequest method directly instead of full integration
        const mockXHRInstance = {
          setRequestHeader: vi.fn(),
          _requestHeaders: {} as Record<string, string>
        } as unknown as XMLHttpRequest & { _requestHeaders: Record<string, string> };

        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(
            ["*"], 
            [],
            "x-groundcover-trace-id",
            "x-groundcover-parent-id"
          )
        );

        // Test the addHeaderToXhrRequest method directly
        listener["addHeaderToXhrRequest"]({
          request: mockXHRInstance,
          headerName: "x-groundcover-trace-id",
          headerValue: "test-trace-id-123"
        });

        listener["addHeaderToXhrRequest"]({
          request: mockXHRInstance,
          headerName: "x-groundcover-parent-id", 
          headerValue: "test-span-id-456"
        });

        expect(mockXHRInstance.setRequestHeader).toHaveBeenCalledWith(
          "x-groundcover-trace-id",
          "test-trace-id-123"
        );
        expect(mockXHRInstance.setRequestHeader).toHaveBeenCalledWith(
          "x-groundcover-parent-id", 
          "test-span-id-456"
        );
        expect(mockXHRInstance._requestHeaders["x-groundcover-trace-id"]).toBe("test-trace-id-123");
        expect(mockXHRInstance._requestHeaders["x-groundcover-parent-id"]).toBe("test-span-id-456");
      });

      it("should use default traceparent header when custom headers are not configured", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );

        listener.initialize();
        
        // Trigger fetch
        fetch("https://api.example.com", { method: "GET" });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        const headers = fetchInit.headers as Headers;
        expect(headers.get("traceparent")).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      });

      it("should use custom tracePropagationHeaders when configured", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(
            ["*"],
            [],
            undefined,
            undefined,
            ["x-custom-trace-header"]
          )
        );

        listener.initialize();
        
        // Trigger fetch
        fetch("https://api.example.com", { method: "GET" });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        const headers = fetchInit.headers as Headers;
        expect(headers.get("x-custom-trace-header")).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      });

      it("should not add trace headers when URL doesn't match tracePropagationUrls", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(
            ["https://specific-domain.com/*"],
            [],
            "x-groundcover-trace-id",
            "x-groundcover-parent-id"
          )
        );

        listener.initialize();
        
        // Trigger fetch to different domain
        fetch("https://other-domain.com", { method: "GET" });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://other-domain.com",
          expect.objectContaining({
            headers: expect.not.objectContaining({
              "x-groundcover-trace-id": expect.anything(),
              "x-groundcover-parent-id": expect.anything(),
            }),
          })
        );
      });
    });

    describe("addHeaderToFetchRequest through the fetch wrapper", () => {
      let mockFetch: MockedFunction<typeof fetch>;

      beforeEach(() => {
        // Mock fetch to capture what arguments it receives
        mockFetch = vi.fn().mockResolvedValue({
          status: 200,
          clone: () => ({
            text: () => Promise.resolve("response body"),
            headers: new Headers({ "content-type": "application/json" }),
          }),
          headers: new Headers({ "content-type": "application/json" }),
        });
        global.fetch = mockFetch;
      });

      it("should properly modify headers when init has plain object headers", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id", "x-span-id")
        );

        listener.initialize();
        
        // Call fetch with existing headers
        fetch("https://api.example.com", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": "Bearer token123"
          },
          body: JSON.stringify({ data: "test" })
        });

        // Verify the fetch was called with both original and new headers
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.method).toBe("POST");
        expect(fetchInit.body).toBe(JSON.stringify({ data: "test" }));
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        
        const headers = fetchInit.headers as Headers;
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("authorization")).toBe("Bearer token123");
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
        expect(headers.get("x-span-id")).toMatch(/^\d+$/);
      });

      it("should properly modify headers when init has Headers object", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id", "x-span-id")
        );

        listener.initialize();
        
        // Call fetch with Headers object
        const headers = new Headers();
        headers.set("content-type", "application/json");
        headers.set("user-agent", "test-agent");

        fetch("https://api.example.com", {
          method: "PUT",
          headers: headers,
          body: "test data"
        });

        // Verify the fetch was called and Headers object was modified
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.method).toBe("PUT");
        expect(fetchInit.body).toBe("test data");
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        
        const fetchHeaders = fetchInit.headers as Headers;
        expect(fetchHeaders.get("content-type")).toBe("application/json");
        expect(fetchHeaders.get("user-agent")).toBe("test-agent");
        expect(fetchHeaders.get("x-trace-id")).toMatch(/^\d+$/);
        expect(fetchHeaders.get("x-span-id")).toMatch(/^\d+$/);
      });

      it("should create headers object when init has no headers", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id", "x-span-id")
        );

        listener.initialize();
        
        // Call fetch without headers
        fetch("https://api.example.com", {
          method: "DELETE"
        });

        // Verify headers were created and added
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.method).toBe("DELETE");
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        
        const headers = fetchInit.headers as Headers;
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
        expect(headers.get("x-span-id")).toMatch(/^\d+$/);
      });

      it("should create headers when init is initially undefined", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id", "x-span-id")
        );

        listener.initialize();
        
        // Call fetch with no init object
        fetch("https://api.example.com");

        // Verify headers were created and added
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        
        const headers = fetchInit.headers as Headers;
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
        expect(headers.get("x-span-id")).toMatch(/^\d+$/);
      });

      it("should preserve all original properties while adding headers", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id")
        );

        listener.initialize();
        
        const originalInit = {
          method: "PATCH",
          body: "patch data",
          headers: { "custom-header": "custom-value" },
          credentials: "include" as RequestCredentials,
          cache: "no-cache" as RequestCache,
          redirect: "follow" as RequestRedirect,
        };

        fetch("https://api.example.com", originalInit);

        // Verify all original properties are preserved
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.method).toBe("PATCH");
        expect(fetchInit.body).toBe("patch data");
        expect(fetchInit.credentials).toBe("include");
        expect(fetchInit.cache).toBe("no-cache");
        expect(fetchInit.redirect).toBe("follow");
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        
        const headers = fetchInit.headers as Headers;
        expect(headers.get("custom-header")).toBe("custom-value");
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
      });

      it("should handle multiple header additions correctly", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(
            ["*"], 
            [], 
            "x-trace-id", 
            "x-span-id",
            ["x-custom-trace"]
          )
        );

        listener.initialize();
        
        fetch("https://api.example.com", {
          headers: { "existing": "header" }
        });

        // Verify all trace headers were added
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        
        const headers = fetchInit.headers as Headers;
        expect(headers.get("existing")).toBe("header");
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
        expect(headers.get("x-span-id")).toMatch(/^\d+$/);
        expect(headers.get("x-custom-trace")).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      });

      it("should not modify fetch calls that don't match trace URLs", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["https://specific-api.com/*"], [], "x-trace-id")
        );

        listener.initialize();

        const originalInit = {
          method: "POST",
          headers: { "original": "header" },
          body: "test"
        };

        // Call fetch to URL that doesn't match trace patterns
        fetch("https://other-api.com/data", originalInit);

        // Verify no trace headers were added, but original headers preserved
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        
        expect(fetchInit.method).toBe("POST");
        expect(fetchInit.body).toBe("test");
        expect(fetchInit.headers).toBeInstanceOf(Headers);
        
        const headers = fetchInit.headers as Headers;
        expect(headers.get("original")).toBe("header");
        // Verify trace header was NOT added
        expect(headers.get("x-trace-id")).toBeNull();
      });

      it("should preserve custom headers from Request object when init has plain object headers", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id")
        );

        listener.initialize();

        // Create a Request object with custom headers
        const request = new Request("https://api.example.com", {
          method: "POST",
          headers: {
            "x-custom-header-1": "value1",
            "x-custom-header-2": "value2",
            "x-custom-header-3": "value3",
            "content-type": "application/json"
          },
          body: JSON.stringify({ data: "test" })
        });

        // Call fetch with Request object and additional headers in init
        fetch(request, {
          headers: {
            "additional-header": "value"
          }
        });

        // Verify all headers are preserved (both from Request and init)
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = fetchInit.headers;

        if (headers instanceof Headers) {
          expect(headers.get("x-custom-header-1")).toBe("value1");
          expect(headers.get("x-custom-header-2")).toBe("value2");
          expect(headers.get("x-custom-header-3")).toBe("value3");
          expect(headers.get("content-type")).toBe("application/json");
          expect(headers.get("additional-header")).toBe("value");
          expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
        } else {
          const headersObj = headers as Record<string, string>;
          expect(headersObj["x-custom-header-1"]).toBe("value1");
          expect(headersObj["x-custom-header-2"]).toBe("value2");
          expect(headersObj["x-custom-header-3"]).toBe("value3");
          expect(headersObj["content-type"]).toBe("application/json");
          expect(headersObj["additional-header"]).toBe("value");
          expect(headersObj["x-trace-id"]).toMatch(/^\d+$/);
        }
      });

      it("records the method from a Request object instead of defaulting to GET (openapi-fetch style)", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as { handleEvent: (event: { method: string }) => void },
          "handleEvent"
        );
        listener.initialize();

        // Act — openapi-fetch calls fetch(new Request(...)) with the method on the
        // Request object and no init.method.
        await fetch(
          new Request("https://api.example.com/api/v1/migrations/123", {
            method: "DELETE",
          })
        );
        // handleEvent fires from a nested promise after the fetch resolves, so
        // synchronize on the spy rather than a fixed timer.
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — the recorded event method reflects the Request, not "GET".
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent).toEqual(
          expect.objectContaining({ method: "DELETE" })
        );
      });

      it("records the request body from a Request object instead of an empty string (openapi-fetch style)", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: {
              request?: { body?: string };
            }) => void;
          },
          "handleEvent"
        );
        listener.initialize();
        const payload = JSON.stringify({ a: 1 });

        // Act — openapi-fetch calls fetch(new Request(...)) with the body on the
        // Request object and no init.body (it sets a JSON content-type).
        await fetch(
          new Request("https://api.example.com/api/v1/things", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
          })
        );
        // handleEvent fires from a nested promise after the fetch resolves, and
        // the captured body is read asynchronously from a Request clone, so
        // synchronize on the spy rather than a fixed timer.
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — the recorded request body reflects the Request payload, not "".
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent?.request?.body).toBe(payload);
      });

      it("records a placeholder for a multipart Request body instead of leaking field values", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();
        const form = new FormData();
        form.append("secret", "hunter2");

        // Act — a multipart body would serialize field values + file bytes if
        // read raw; it must be replaced with a safe placeholder.
        await fetch(
          new Request("https://api.example.com/upload", {
            method: "POST",
            body: form,
          })
        );
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — placeholder recorded, no secret leaked.
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent?.request?.body).toBe("[form data]");
        expect(recordedEvent?.request?.body).not.toContain("hunter2");
      });

      it("does not let a throwing Request.clone() break the host fetch (defensive)", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: {
              method: string;
              request?: { body?: string };
            }) => void;
          },
          "handleEvent"
        );
        listener.initialize();
        const request = new Request("https://api.example.com/api/v1/things", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ a: 1 }),
        });
        // Request.clone() throws synchronously on a disturbed/used body; the
        // instrumentation must swallow it rather than propagate out of fetch().
        request.clone = () => {
          throw new TypeError("Failed to clone: body already used");
        };

        // Act — the fetch must still resolve despite the clone throwing.
        await expect(fetch(request)).resolves.toBeTruthy();
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — event still recorded; a throwing clone yields the "unavailable"
        // placeholder (distinct from a bodyless ""), never crashes the host fetch.
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent).toEqual(
          expect.objectContaining({ method: "POST" })
        );
        expect(recordedEvent?.request?.body).toBe("[request body unavailable]");
      });

      // --- Body capture edge cases ---

      it("records a placeholder for a binary Request body sent WITHOUT a content-type", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();
        // A raw byte body sets no content-type header on the Request. The SDK
        // must not decode raw bytes into telemetry.
        const bytes = new Uint8Array([0, 255, 1, 2, 3, 200, 150, 42]);

        // Act
        await fetch(
          new Request("https://api.example.com/upload", {
            method: "POST",
            body: bytes,
          })
        );
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — placeholder, not the decoded raw bytes.
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent?.request?.body).toBe("[binary data]");
      });

      it("records a placeholder for an Office document body whose MIME merely contains 'xml'", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();
        // .xlsx MIME contains the substring "xml" (openXMLformats) but is binary.
        const xlsx = new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 0, 1])], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        // Act
        await fetch(
          new Request("https://api.example.com/upload.xlsx", {
            method: "POST",
            body: xlsx,
          })
        );
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — binary file bytes must not be read as text.
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent?.request?.body).toBe("[binary data]");
      });

      it("does not clone the Request when the body will be a placeholder (no stream teeing)", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as { handleEvent: (event: unknown) => void },
          "handleEvent"
        );
        listener.initialize();
        const form = new FormData();
        form.append("file", "x".repeat(100));
        const request = new Request("https://api.example.com/upload", {
          method: "POST",
          body: form,
        });
        const cloneSpy = vi.spyOn(request, "clone");

        // Act — a multipart body is placeholdered without reading, so the body
        // stream should never be teed (clone()).
        await fetch(request);
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert
        expect(cloneSpy).not.toHaveBeenCalled();
      });

      it("records a placeholder for a binary init.body (Uint8Array), not its serialized bytes", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        // Act — a TypedArray passed via init.body flows through formatBody; it
        // must not be JSON-serialized into telemetry (leaks upload bytes).
        await fetch("https://api.example.com/upload", {
          method: "POST",
          body: new Uint8Array([0, 1, 2, 250, 251]),
        });
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent?.request?.body).toBe("[arraybuffer data]");
        expect(recordedEvent?.request?.body).not.toContain('"0"');
      });

      it("records a start timestamp on FAILED fetches", async () => {
        // Arrange — a rejecting fetch drives the .catch failure-event path.
        const failFetch = vi
          .fn()
          .mockRejectedValue(new TypeError("Failed to fetch"));
        global.fetch = failFetch as unknown as typeof fetch;
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { timestamp?: number }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        // Act
        await expect(
          fetch("https://api.example.com/x", { method: "GET" })
        ).rejects.toThrow();
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — error spans need a start time for duration/ordering.
        const [recordedEvent] = handleEventSpy.mock.calls[0] ?? [];
        expect(recordedEvent?.timestamp).toEqual(expect.any(Number));
      });

      it("placeholders a Request body over the cap instead of emitting a truncated (unredactable) slice", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();
        const maxBodyLength = listener["maxBodyLength"] as number;
        // A nested secret in an over-cap body. Capping-then-redacting
        // feeds redactBody truncated JSON, so its subtree pass never runs and
        // `hunter2` leaks — placeholdering the over-cap body avoids that.
        const payload = JSON.stringify({
          credential: { value: "hunter2", filler: "x".repeat(maxBodyLength) },
        });
        expect(payload.length).toBeGreaterThan(maxBodyLength);

        // Act
        await fetch(
          new Request("https://api.example.com/big", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
          })
        );
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — placeholder, and the nested secret never reaches telemetry.
        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.request?.body).toBe("[request body too large]");
        expect(event?.request?.body).not.toContain("hunter2");
      });

      it("placeholders and cancels the stream once the body exceeds the cap", async () => {
        // A cloned Request body stream that yields fixed chunks and never ends.
        // Once maxBodyLength is exceeded the reader must stop, cancel the stream
        // (no unbounded background read), and return the placeholder.
        let cancelled = false;
        let reads = 0;
        const chunk = new TextEncoder().encode("x".repeat(2000));
        const req = {
          body: {},
          headers: { get: () => "text/plain" },
          clone: () => ({
            body: {
              getReader: () => ({
                read: () => {
                  reads++;
                  return Promise.resolve({ done: false, value: chunk });
                },
                cancel: () => {
                  cancelled = true;
                  return Promise.resolve();
                },
              }),
            },
          }),
        } as unknown as Request;

        const body = await (
          listener as unknown as {
            getRequestBody: (r: Request, ct: string) => Promise<string>;
          }
        ).getRequestBody(req, "text/plain");

        expect(body).toBe("[request body too large]");
        expect(cancelled).toBe(true);
        expect(reads).toBeLessThan(10);
      });

      it("structurally redacts a nested sensitive key for a Request body within the cap", async () => {
        // A body that fits under the cap is captured in full, so buildEvent's
        // redactBody parses it and masks the whole sensitive subtree — the
        // nested value must not survive.
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        vi.spyOn(configManager, "getPrivacy").mockReturnValue({
          level: "mask-sensitive",
          maskNetworkBodies: true,
          maskNetworkQueryParams: true,
          maskLogs: true,
          maskErrors: true,
          shouldMaskNetworkBodies: true,
          shouldMaskNetworkQueryParams: true,
          shouldMaskLogs: true,
          shouldMaskErrors: true,
          sensitiveKeys: ["credential"],
        });
        // Read the enriched event via queueEvent (parity with the other redaction tests) — redaction
        // runs in buildEvent, downstream of handleEvent.
        const queueEventSpy = vi.spyOn(
          listener as unknown as {
            queueEvent: (event: { attributes?: Record<string, string> }) => void;
          },
          "queueEvent"
        );
        listener.initialize();
        const payload = JSON.stringify({
          credential: { value: "hunter2" },
          ok: "keep",
        });

        await fetch(
          new Request("https://api.example.com/small", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
          })
        );
        await vi.waitFor(() => expect(queueEventSpy).toHaveBeenCalled());

        const [event] = queueEventSpy.mock.calls[0] ?? [];
        const redacted = event?.attributes?.["gc.request.body"] as string;
        expect(redacted).not.toContain("hunter2");
        expect(redacted).toContain("[REDACTED]");
      });

      it("placeholders a body that reaches the cap (`>=`, so the timeout-less response path never does a second read)", async () => {
        const maxBodyLength = listener["maxBodyLength"] as number;
        const exact = "y".repeat(maxBodyLength);
        let done = false;
        const req = {
          body: {},
          headers: { get: () => "text/plain" },
          clone: () => ({
            body: {
              getReader: () => ({
                read: () => {
                  if (done) return Promise.resolve({ done: true, value: undefined });
                  done = true;
                  return Promise.resolve({
                    done: false,
                    value: new TextEncoder().encode(exact),
                  });
                },
                cancel: () => Promise.resolve(),
              }),
            },
          }),
        } as unknown as Request;

        const body = await (
          listener as unknown as {
            getRequestBody: (r: Request, ct: string) => Promise<string>;
          }
        ).getRequestBody(req, "text/plain");

        // Reaching the cap stops the read immediately (the shared reader has no
        // way to know the body ends exactly here without another read, which the
        // no-timeout response path can't afford), so it's placeholdered.
        expect(body).toBe("[request body too large]");
      });

      it("classifies by the effective content-type when init.headers overrides the Request's", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        // Act — Request declares JSON, but init overrides the wire type to binary.
        await fetch(
          new Request("https://api.example.com/x", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ a: 1 }),
          }),
          { headers: { "content-type": "application/octet-stream" } }
        );
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — the effective (octet-stream) type wins → placeholder, not text.
        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.request?.body).toBe("[binary data]");
      });

      it("honors an explicit empty content-type override (binary placeholder, not text)", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        // Act — Request declares JSON, but init clears content-type to "". The
        // effective type is empty, so classification must honor the override, not
        // fall back to the Request's JSON type and read the body as text.
        await fetch(
          new Request("https://api.example.com/x", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ a: 1 }),
          }),
          { headers: { "content-type": "" } }
        );
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — empty effective type → non-textual → placeholder, not the JSON.
        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.request?.body).toBe("[binary data]");
      });

      it("bounds the request-body read so a never-closing stream body can't hang the event", async () => {
        vi.useFakeTimers();
        try {
          // A Request whose cloned body stream never yields and never closes.
          const req = {
            body: {},
            headers: { get: () => "text/plain" },
            clone: () => ({
              body: {
                getReader: () => ({
                  read: () => new Promise(() => {}),
                  cancel: () => Promise.resolve(),
                }),
              },
            }),
          } as unknown as Request;

          const pending = (
            listener as unknown as {
              getRequestBody: (r: Request, ct: string) => Promise<string>;
            }
          ).getRequestBody(req, "text/plain");

          // Advancing past the read timeout resolves it (never hangs); a
          // timed-out read yields the distinct "unavailable" placeholder — not a
          // partial body, and not the "too large" size-overflow message.
          await vi.advanceTimersByTimeAsync(3100);
          await expect(pending).resolves.toBe("[request body unavailable]");
        } finally {
          vi.useRealTimers();
        }
      });

      it("placeholders (does not leak) a partial body when the read times out mid-stream", async () => {
        vi.useFakeTimers();
        try {
          // First read delivers a truncated JSON prefix with a nested secret,
          // then the stream stalls. On timeout the partial must NOT be emitted
          // (it's invalid JSON → redactBody can't mask the subtree) — placeholder.
          const enc = new TextEncoder();
          let pulls = 0;
          const req = {
            body: {},
            headers: { get: () => "application/json" },
            clone: () => ({
              body: {
                getReader: () => ({
                  read: () => {
                    pulls += 1;
                    if (pulls === 1) {
                      return Promise.resolve({
                        done: false,
                        value: enc.encode('{"credential":{"value":"hunter2"'),
                      });
                    }
                    return new Promise(() => {}); // stalls → forces timeout
                  },
                  cancel: () => Promise.resolve(),
                }),
              },
            }),
          } as unknown as Request;

          const pending = (
            listener as unknown as {
              getRequestBody: (r: Request, ct: string) => Promise<string>;
            }
          ).getRequestBody(req, "application/json");

          await vi.advanceTimersByTimeAsync(3100);
          const body = await pending;
          // Timed-out read → distinct placeholder (not "too large"), and the
          // partial body with the nested secret is never emitted.
          expect(body).toBe("[request body unavailable]");
          expect(body).not.toContain("hunter2");
        } finally {
          vi.useRealTimers();
        }
      });

      it("records an empty body (not a placeholder) for a bodyless Request", async () => {
        // Arrange
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        // Act — a bodyless request (no body, no content-type).
        await fetch(new Request("https://api.example.com/x", { method: "DELETE" }));
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        // Assert — empty body, not the "[binary data]" placeholder.
        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.request?.body).toBe("");
      });

      it("enqueues the failure event immediately, not gated on the request-body read", async () => {
        // Arrange — a rejecting fetch, and a request-body read that never
        // resolves (open/streaming body). The failure event must not wait on it,
        // or a page unloading in that window could drop it from the pool.
        const failFetch = vi
          .fn()
          .mockRejectedValue(new TypeError("Failed to fetch"));
        global.fetch = failFetch as unknown as typeof fetch;
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        vi.spyOn(
          listener as unknown as {
            getRequestBody: (r: Request, ct: string) => Promise<string>;
          },
          "getRequestBody"
        ).mockReturnValue(new Promise<string>(() => {})); // never resolves
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: {
              error?: { type?: string };
              request?: { body?: string };
            }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        // Act — the fetch rejects; the request body on the Request never reads.
        await expect(
          fetch(
            new Request("https://api.example.com/x", {
              method: "POST",
              headers: { "content-type": "text/plain" },
              body: "payload",
            })
          )
        ).rejects.toThrow();

        // Assert — handleEvent already fired synchronously in the .catch, despite
        // the hanging body read; body is best-effort "" (not awaited).
        expect(handleEventSpy).toHaveBeenCalled();
        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.error?.type).toBe("ERR_NETWORK_FAILURE");
        expect(event?.request?.body).toBe("");
      });

      it("uses the request body on failure when the read already resolved", async () => {
        // Arrange — a rejecting fetch, but the body read resolves promptly (small
        // body, already sent). The failure event should include it without ever
        // having waited on the promise.
        const failFetch = vi
          .fn()
          .mockRejectedValue(new TypeError("Failed to fetch"));
        global.fetch = failFetch as unknown as typeof fetch;
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        vi.spyOn(
          listener as unknown as {
            getRequestBody: (r: Request, ct: string) => Promise<string>;
          },
          "getRequestBody"
        ).mockResolvedValue("ALREADY_READ_BODY");
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        // Act
        await expect(
          fetch(
            new Request("https://api.example.com/x", {
              method: "POST",
              headers: { "content-type": "text/plain" },
              body: "payload",
            })
          )
        ).rejects.toThrow();

        // Assert — the already-resolved read body is used (not the "" fallback).
        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.request?.body).toBe("ALREADY_READ_BODY");
      });

      it("should preserve the app's custom headers from a Request object", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id")
        );

        listener.initialize();

        // The app's own headers must survive when a Request object is passed to
        // fetch() with additional headers in init
        const request = new Request("https://api.example.com", {
          method: "POST",
          headers: {
            "x-app-token": "00000000-0000-4000-8000-000000000000",
            "x-app-source": "web.v1.2.3",
            "x-app-version": "v4.5.6",
            "content-type": "application/json"
          },
          body: JSON.stringify({ data: "test" })
        });

        // SDK might add trace headers via the init parameter
        fetch(request, {
          headers: {
            "x-sdk-header": "sdk-value"
          }
        });

        // Verify all of the app's headers are preserved
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = fetchInit.headers as Headers;

        expect(headers.get("x-app-token")).toBe("00000000-0000-4000-8000-000000000000");
        expect(headers.get("x-app-source")).toBe("web.v1.2.3");
        expect(headers.get("x-app-version")).toBe("v4.5.6");
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("x-sdk-header")).toBe("sdk-value");
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
      });

      it("should preserve custom headers from Request object when init has no headers", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id")
        );

        listener.initialize();

        // Create a Request object with custom headers
        const request = new Request("https://api.example.com", {
          method: "GET",
          headers: {
            "custom-auth": "bearer xyz",
            "custom-api-key": "api-key-123"
          }
        });

        // Call fetch with Request object without init headers
        fetch(request);

        // Verify all headers are preserved from Request
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = fetchInit.headers as Headers;

        expect(headers.get("custom-auth")).toBe("bearer xyz");
        expect(headers.get("custom-api-key")).toBe("api-key-123");
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
      });

      it("should preserve custom headers from Request object when init.headers is a Headers object", () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"], [], "x-trace-id")
        );

        listener.initialize();

        // Create a Request object with custom headers
        const request = new Request("https://api.example.com", {
          method: "POST",
          headers: {
            "request-custom-header": "request-value"
          }
        });

        // Create a Headers object for init
        const initHeaders = new Headers();
        initHeaders.set("init-custom-header", "init-value");

        // Call fetch with Request object and Headers init
        fetch(request, {
          headers: initHeaders
        });

        // Verify all headers are preserved from both Request and init
        const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = fetchInit.headers as Headers;

        expect(headers.get("request-custom-header")).toBe("request-value");
        expect(headers.get("init-custom-header")).toBe("init-value");
        expect(headers.get("x-trace-id")).toMatch(/^\d+$/);
      });
    });
  });

  describe("header name validation", () => {
    describe("graceful handling of invalid header names", () => {
      it("should not throw when adding invalid header names to fetch requests", () => {
        const init = { headers: {} } as RequestInit;
        
        expect(() => {
          listener["addHeaderToFetchRequest"]({
            init,
            headerName: "invalid header name",
            headerValue: "test-value",
          });
        }).not.toThrow();
        
        // Should not have added the invalid header
        expect((init.headers as Record<string, string>)["invalid header name"]).toBeUndefined();
      });

      it("should not throw when adding invalid header names to XHR requests", () => {
        const mockXHR = {
          setRequestHeader: vi.fn(),
          _requestHeaders: {} as Record<string, string>,
        } as unknown as XMLHttpRequest & { _requestHeaders: Record<string, string> };
        
        expect(() => {
          listener["addHeaderToXhrRequest"]({
            request: mockXHR,
            headerName: "invalid header name",
            headerValue: "test-value",
          });
        }).not.toThrow();
        
        // Should not have called setRequestHeader
        expect(mockXHR.setRequestHeader).not.toHaveBeenCalled();
        expect(mockXHR._requestHeaders["invalid header name"]).toBeUndefined();
      });

      it("should handle Headers API throwing errors gracefully", () => {
        const mockHeaders = new Headers();
        const originalSet = mockHeaders.set;
        mockHeaders.set = vi.fn().mockImplementation(() => {
          throw new Error("Invalid header name");
        });
        
        const init = { headers: mockHeaders } as RequestInit;
        
        expect(() => {
          listener["addHeaderToFetchRequest"]({
            init,
            headerName: "valid-header",
            headerValue: "test-value",
          });
        }).not.toThrow();
        
        // Restore original method
        mockHeaders.set = originalSet;
      });
    });

    describe("readBodyStreamCapped (response body reading)", () => {
      it("should extract body text using TextDecoder", async () => {
        const stream = new Response("Hello World")
          .body as ReadableStream<Uint8Array>;
        const result = await listener["readBodyStreamCapped"](stream);
        expect(result).toBe("Hello World");
      });

      it("should return an empty string for an empty stream", async () => {
        const stream = {
          getReader: () => ({
            read: () => Promise.resolve({ done: true, value: undefined }),
            cancel: () => Promise.resolve(),
          }),
        } as unknown as ReadableStream<Uint8Array>;
        const result = await listener["readBodyStreamCapped"](stream);
        expect(result).toBe("");
      });

      it("records an empty response body when the response has no body (null)", async () => {
        // The null-body guard lives at the response call site (204/HEAD).
        const nullBodyResponse = {
          status: 204,
          headers: { forEach: () => {}, get: () => null },
          clone: () => ({ body: null }),
        } as unknown as Response;
        global.fetch = vi
          .fn()
          .mockResolvedValue(nullBodyResponse) as unknown as typeof fetch;
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { response?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        listener.initialize();

        await fetch("https://api.example.com/no-body");
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.response?.body).toBe("");
      });

      it("should read JSON body text without parsing", async () => {
        const jsonData = { id: 1, name: "test", email: "test@example.com" };
        const stream = new Response(JSON.stringify(jsonData))
          .body as ReadableStream<Uint8Array>;
        const result = await listener["readBodyStreamCapped"](stream);
        expect(result).toBe(JSON.stringify(jsonData));
      });

      it("should stop reading and cancel the stream once maxBodyLength is reached", async () => {
        const maxBodyLength = (listener as unknown as { maxBodyLength: number }).maxBodyLength;
        const cancel = vi.fn().mockResolvedValue(undefined);
        const chunk = new TextEncoder().encode("A".repeat(maxBodyLength));
        let pulls = 0;
        const reader = {
          read: vi.fn().mockImplementation(async () => {
            pulls += 1;
            // First pull reaches maxBodyLength; the reader must stop + cancel, not
            // ask for more (a second read on the timeout-less response path would
            // hang on an open stream — hence the cap check is `>=`, not `>`).
            if (pulls === 1) return { done: false, value: chunk };
            return { done: true, value: undefined };
          }),
          cancel,
        };
        const stream = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;

        const result = await listener["readBodyStreamCapped"](stream);

        expect(result.length).toBeGreaterThanOrEqual(maxBodyLength);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(reader.read).toHaveBeenCalledTimes(1);
      });

      it("should reject on stream-read failure so the caller's catch handler runs", async () => {
        const stream = {
          getReader: () => ({
            read: vi.fn().mockRejectedValue(new Error("Read failed")),
          }),
        } as unknown as ReadableStream<Uint8Array>;

        await expect(listener["readBodyStreamCapped"](stream)).rejects.toThrow("Read failed");
      });
    });
  });

  // Unified capture contract, request and response alike: every path emits a
  // complete <=maxBodyLength body or a placeholder — never a truncated/partial/
  // binary body that would break redactBody's structured pass and leak.
  describe("unified body capture", () => {
    const maskAllPrivacy = {
      level: "mask-sensitive" as const,
      maskNetworkBodies: true,
      maskNetworkQueryParams: true,
      maskLogs: true,
      maskErrors: true,
      shouldMaskNetworkBodies: true,
      shouldMaskNetworkQueryParams: true,
      shouldMaskLogs: true,
      shouldMaskErrors: true,
      sensitiveKeys: [],
    };

    const doneReader = () => ({
      read: () => Promise.resolve({ done: true, value: undefined }),
      cancel: () => Promise.resolve(),
    });

    describe("getResponseBody (fetch response)", () => {
      const getResponseBody = (r: unknown) =>
        (
          listener as unknown as {
            getResponseBody: (r: Response) => Promise<string>;
          }
        ).getResponseBody(r as Response);

      const makeResponse = (
        contentType: string,
        reader: () => { read: () => Promise<unknown>; cancel: () => Promise<void> }
      ) =>
        ({
          body: {},
          headers: { get: (k: string) => (k === "content-type" ? contentType : null) },
          clone: () => ({ body: { getReader: reader } }),
        }) as unknown as Response;

      it("placeholders a binary response by content-type family (no mojibake)", async () => {
        const body = await getResponseBody(makeResponse("image/png", doneReader));
        expect(body).toBe("[image data]");
      });

      it("records an empty body for a null-body response (204/HEAD)", async () => {
        const body = await getResponseBody({
          body: null,
          headers: { get: () => null },
          clone: () => ({ body: null }),
        });
        expect(body).toBe("");
      });

      it("placeholders an over-cap response instead of a truncatable slice", async () => {
        const maxBodyLength = listener["maxBodyLength"] as number;
        const chunk = new TextEncoder().encode(
          `{"credential":{"note":"the pass is hunter2","x":"${"z".repeat(maxBodyLength)}"}}`
        );
        const body = await getResponseBody(
          makeResponse("application/json", () => ({
            read: () => Promise.resolve({ done: false, value: chunk }),
            cancel: () => Promise.resolve(),
          }))
        );
        expect(body).toBe("[response body too large]");
        expect(body).not.toContain("hunter2");
      });

      it("bounds a never-closing response read with the response timeout placeholder", async () => {
        vi.useFakeTimers();
        try {
          const pending = getResponseBody(
            makeResponse("application/json", () => ({
              read: () => new Promise(() => {}),
              cancel: () => Promise.resolve(),
            }))
          );
          await vi.advanceTimersByTimeAsync(3100);
          await expect(pending).resolves.toBe("[response body unavailable]");
        } finally {
          vi.useRealTimers();
        }
      });

      it("reads and (in buildEvent) redacts a textual response within the cap", async () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        vi.spyOn(configManager, "getPrivacy").mockReturnValue(maskAllPrivacy);
        // Read the ENRICHED event (post-buildEvent): redaction runs downstream of
        // handleEvent, so the raw handleEvent arg is never redacted.
        const queueEventSpy = vi.spyOn(
          listener as unknown as {
            queueEvent: (event: {
              attributes?: Record<string, string>;
            }) => void;
          },
          "queueEvent"
        );
        const json = JSON.stringify({ user: "bob", password: "hunter2" });
        const chunk = new TextEncoder().encode(json);
        let pulls = 0;
        global.fetch = vi.fn().mockResolvedValue({
          status: 200,
          headers: {
            forEach: (cb: (v: string, k: string) => void) =>
              cb("application/json", "content-type"),
            get: (k: string) =>
              k === "content-type" ? "application/json" : null,
          },
          body: {},
          clone: () => ({
            body: {
              getReader: () => ({
                read: () => {
                  pulls += 1;
                  return pulls === 1
                    ? Promise.resolve({ done: false, value: chunk })
                    : Promise.resolve({ done: true, value: undefined });
                },
                cancel: () => Promise.resolve(),
              }),
            },
          }),
        }) as unknown as typeof fetch;
        listener.initialize();

        await fetch("https://api.example.com/echo");
        await vi.waitFor(() => expect(queueEventSpy).toHaveBeenCalled());

        const [event] = queueEventSpy.mock.calls[0] ?? [];
        const responseBody = event?.attributes?.["gc.response.body"] as string;
        const parsed = JSON.parse(responseBody);
        expect(parsed.user).toBe("bob");
        expect(parsed.password).toBe("[REDACTED]");
        expect(responseBody).not.toContain("hunter2");
      });
    });

    describe("fetch init.body", () => {
      it("placeholders an over-cap init.body instead of leaking via the free-text fallback", async () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        vi.spyOn(configManager, "getPrivacy").mockReturnValue(maskAllPrivacy);
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (event: { request?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        // Self-contained: mock fetch so the test never hits the network or
        // depends on a mock leaked from an earlier test.
        global.fetch = vi.fn().mockResolvedValue({
          status: 200,
          headers: { forEach: () => {}, get: () => null },
          clone: () => ({ body: null }),
        }) as unknown as typeof fetch;
        listener.initialize();
        // >MAX_BODY_PARSE_LENGTH so redactBody skips the structured JSON pass and
        // the spaced value under `credential` would leak through redactText on
        // an uncapped init.body path.
        const payload = JSON.stringify({
          credential: { note: "the pass is hunter2", filler: "x".repeat(100001) },
        });

        await fetch("https://api.example.com/big", {
          method: "POST",
          body: payload,
        });
        await vi.waitFor(() => expect(handleEventSpy).toHaveBeenCalled());

        const [event] = handleEventSpy.mock.calls[0] ?? [];
        expect(event?.request?.body).toBe("[request body too large]");
        expect(event?.request?.body).not.toContain("hunter2");
      });

      it("structurally redacts a within-cap init.body nested sensitive key", async () => {
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        vi.spyOn(configManager, "getPrivacy").mockReturnValue(maskAllPrivacy);
        // Enriched event (post-buildEvent) — redaction runs downstream of handleEvent.
        const queueEventSpy = vi.spyOn(
          listener as unknown as {
            queueEvent: (event: { attributes?: Record<string, string> }) => void;
          },
          "queueEvent"
        );
        // Self-contained: mock fetch so the test never hits the network or
        // depends on a mock leaked from an earlier test.
        global.fetch = vi.fn().mockResolvedValue({
          status: 200,
          headers: { forEach: () => {}, get: () => null },
          clone: () => ({ body: null }),
        }) as unknown as typeof fetch;
        listener.initialize();

        await fetch("https://api.example.com/small", {
          method: "POST",
          body: JSON.stringify({ data: { password: "hunter2" } }),
        });
        await vi.waitFor(() => expect(queueEventSpy).toHaveBeenCalled());

        const [event] = queueEventSpy.mock.calls[0] ?? [];
        const requestBody = event?.attributes?.["gc.request.body"] as string;
        const parsed = JSON.parse(requestBody);
        expect(parsed.data.password).toBe("[REDACTED]");
        expect(requestBody).not.toContain("hunter2");
      });
    });

    describe("XHR response", () => {
      // Drive a real XHR through the patched open/send: a fresh FakeXHR whose
      // prototype the SDK patches, then fire its load handler synchronously.
      const driveXHR = (contentType: string, responseText: string) => {
        class FakeXHR {
          status = 200;
          responseType = "";
          responseText = "";
          response: unknown = null;
          _ct = "";
          _load: Array<() => void> = [];
          open() {}
          send() {
            this._load.forEach((h) => h());
          }
          setRequestHeader() {}
          addEventListener(ev: string, cb: () => void) {
            if (ev === "load") this._load.push(cb);
          }
          getAllResponseHeaders() {
            return this._ct ? `content-type: ${this._ct}` : "";
          }
        }
        vi.spyOn(configManager, "getConfig").mockReturnValue(
          createConfigMock(["*"])
        );
        const handleEventSpy = vi.spyOn(
          listener as unknown as {
            handleEvent: (e: { response?: { body?: string } }) => void;
          },
          "handleEvent"
        );
        const OriginalXHR = global.XMLHttpRequest;
        global.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
        try {
          listener.initialize();
          const x = new XMLHttpRequest() as unknown as FakeXHR;
          x.responseText = responseText;
          x._ct = contentType;
          (x as unknown as XMLHttpRequest).open("GET", "https://api.example.com/x");
          (x as unknown as XMLHttpRequest).send();
        } finally {
          global.XMLHttpRequest = OriginalXHR;
        }
        return handleEventSpy;
      };

      it("placeholders a binary XHR response by content-type (no mojibake)", () => {
        const spy = driveXHR("image/png", "\x89PNG\r\n\x1a\n rawbytes");
        const [event] = spy.mock.calls[0] ?? [];
        expect(event?.response?.body).toBe("[image data]");
      });

      it("reads a textual XHR response unchanged", () => {
        const spy = driveXHR("application/json", '{"ok":true}');
        const [event] = spy.mock.calls[0] ?? [];
        expect(event?.response?.body).toBe('{"ok":true}');
      });
    });
  });
});
