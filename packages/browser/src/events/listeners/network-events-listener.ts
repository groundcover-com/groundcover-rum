/* eslint-disable */

import {
  EnrichedEvent,
  RawNetworkEvent,
} from "@groundcover/rum-core/events/types";
import { BaseListener } from "@groundcover/rum-core/events/listeners/base-listener";
import { handleError } from "@groundcover/rum-core/common/error-handler";
import { RandomIdGenerator } from "@groundcover/rum-core/common/id-generator";
import { PatchSet, type PatchSpec } from "@groundcover/rum-core/common/patch";
import {
  NETWORK_BODY_PLACEHOLDER as BODY_PLACEHOLDER,
  capBody,
  classifyBody,
  isEventStream,
} from "@groundcover/rum-core/events/network/body";
import { shapeNetworkEvent } from "@groundcover/rum-core/events/network/shape";
import { shouldIgnoreUrl } from "@groundcover/rum-core/events/network/url-filter";
import {
  buildTraceHeaders,
  extractTraceIds,
  generateTraceIds,
  isValidHeaderName,
  matchesPropagationUrl,
} from "@groundcover/rum-core/events/network/trace";
import { formatWebBody } from "../../common/web-body";

// Dev-server module requests (Vite/webpack HMR) are page plumbing, not app
// traffic.
const DEV_MODULE_EXTENSIONS = [".tsx", ".jsx", ".css"];
const isDevModuleRequest = (url: string) =>
  DEV_MODULE_EXTENSIONS.some((ext) => url.toLowerCase().endsWith(ext));

export class NetworkEventsListener extends BaseListener {
  private maxBodyLength = 5000;
  // Upper bound on how long we'll wait to read a captured request body before
  // giving up with "" — so a slow or never-closing streaming body can't defer
  // the network event (especially the failure event) indefinitely.
  private requestBodyReadTimeoutMs = 3000;
  // Same bound for the response read: a slow/never-closing cloned
  // response stream must not keep the success event from being enqueued.
  private responseBodyReadTimeoutMs = 3000;
  private idGenerator = new RandomIdGenerator();

  // Our XHR and fetch wrappers, as two independent groups (see PatchSet): each
  // records the original it wrapped, rolls back if it can't install, and is
  // restored only where the global is STILL our wrapper — a host wrapper
  // layered on top of us is left intact instead of stomped.
  private patches = new PatchSet();

  // True only while this listener owns a live patch. destroy() flips it false so
  // a wrapper still reachable through a HOST delegation chain (host → our retired
  // wrapper → native) goes inert — passing straight to the original with no
  // tracing headers and no capture. Guarded restore alone can't cover this: it
  // deliberately leaves such a wrapper installed, so the wrapper itself must
  // stand down. Mirrors the ownership check in destroy().
  private active = false;

  // Read a body stream to text, byte-capped at maxBodyLength; shared by the
  // request and response paths. Over-cap/timeout resolve to a placeholder (a
  // truncated/partial body can't be safely redacted); read errors propagate.
  private async readBodyStreamCapped(
    stream: ReadableStream<Uint8Array> | null | undefined,
    opts: {
      timeoutMs?: number;
      overflowPlaceholder?: string;
      timeoutPlaceholder?: string;
    } = {}
  ): Promise<string> {
    if (!stream) return '';
    const { timeoutMs, overflowPlaceholder, timeoutPlaceholder } = opts;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    // Cap by raw bytes — multi-byte UTF-8 would let us read 3-4× the budget
    // before a char-length check fires.
    let receivedBytes = 0;
    let overflowed = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout: Promise<{ timedOut: true }> | undefined =
      timeoutMs != null
        ? new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
          })
        : undefined;

    try {
      while (true) {
        const step = timeout
          ? await Promise.race([reader.read(), timeout])
          : await reader.read();
        // Time budget exhausted (a streaming body that never closes). Whatever
        // we've read is a PARTIAL body — invalid for structured redaction — so
        // report it as incomplete rather than emitting the truncated prefix.
        if ('timedOut' in step) {
          timedOut = true;
          break;
        }

        const { done, value } = step;
        if (done) break;

        if (receivedBytes + value.byteLength >= this.maxBodyLength) {
          // `>=`, not `>`: stop at the cap without another read (which on an open
          // stream would block until the timeout). Matches core capBody so a body
          // is treated identically on the stream and in-memory paths.
          const slice = value.subarray(0, this.maxBodyLength - receivedBytes);
          result += decoder.decode(slice, { stream: true });
          overflowed = true;
          break;
        }

        receivedBytes += value.byteLength;
        result += decoder.decode(value, { stream: true });
      }
      // Flush any multi-byte sequence the streaming decoder is still holding.
      result += decoder.decode();
      if (timedOut && timeoutPlaceholder != null) return timeoutPlaceholder;
      if (overflowed && overflowPlaceholder != null) return overflowPlaceholder;
      return result;
    } finally {
      clearTimeout(timer);
      // Stop pulling an abandoned stream (cap hit/timeout). Best-effort and
      // guarded so a cleanup failure can't mask a read error from the try.
      try {
        void reader.cancel()?.catch(() => { /* ignore */ });
      } catch {
        /* reader without cancel / already released */
      }
    }
  }

  private async getRequestBody(
    request: Request,
    effectiveContentType: string
  ): Promise<string> {
    try {
      // A bodyless request (GET/DELETE, or a POST with no body) has nothing to
      // record — return "" rather than mistaking its absent content-type for a
      // binary payload.
      if (!request.body) return "";

      // Classify by the effective content-type BEFORE reading — a multipart or
      // binary body returns a placeholder without consuming the stream.
      const placeholder = classifyBody(effectiveContentType);
      if (placeholder != null) return placeholder;

      // Clone synchronously (before the first await) so the app's one-shot body
      // is never consumed, then read capped + timed-out — only a complete body
      // reaches redaction; over-cap/timeout become placeholders.
      return await this.readBodyStreamCapped(request.clone().body, {
        timeoutMs: this.requestBodyReadTimeoutMs,
        overflowPlaceholder: BODY_PLACEHOLDER.requestTooLarge,
        timeoutPlaceholder: BODY_PLACEHOLDER.requestUnavailable,
      });
    } catch {
      // A throwing clone or rejected read means we couldn't capture the body;
      // record it as unavailable (distinct from a legitimately bodyless "").
      return BODY_PLACEHOLDER.requestUnavailable;
    }
  }

  // Fetch response body under the same contract as getRequestBody:
  // null → ""; event-stream/binary/multipart → placeholder; else read capped +
  // timed out. Read errors reject to the caller (records the unreadable value).
  private async getResponseBody(response: Response): Promise<string> {
    if (!response.body) return "";
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (isEventStream(contentType)) {
      return BODY_PLACEHOLDER.responseUnreadable;
    }
    const placeholder = classifyBody(contentType);
    if (placeholder != null) return placeholder;
    return await this.readBodyStreamCapped(response.clone().body, {
      timeoutMs: this.responseBodyReadTimeoutMs,
      overflowPlaceholder: BODY_PLACEHOLDER.responseTooLarge,
      timeoutPlaceholder: BODY_PLACEHOLDER.responseUnavailable,
    });
  }

  initialize() {
    this.logger.log("[network-events-listener.initialize] called");

    // Independent groups: a host that froze XMLHttpRequest.prototype (or made
    // fetch non-writable) loses that transport's capture, not both. A failed
    // group is rolled back, never left half-wrapped.
    const xhr = this.patches.install(this.xhrPatches());
    const fetch = this.patches.install([this.fetchPatch()]);
    this.active = xhr || fetch;
  }

  destroy() {
    // Stand our wrappers down FIRST: any still reachable through a host
    // delegation chain (host → our retired wrapper → native) must go inert — no
    // tracing headers, no capture — even though the guarded restore
    // deliberately leaves such a wrapper installed.
    this.active = false;
    this.patches.restore();
  }

  private shouldIgnoreRequest(url: string) {
    try {
      const config = this.config.getConfig();
      return shouldIgnoreUrl(url, {
        endpoint: config?.getEndpoint(),
        excludedUrls: config?.options?.excludedUrls,
        extraIgnore: isDevModuleRequest,
      });
    } catch (error) {
      handleError(error);
      return false;
    }
  }

  handleEvent = (event: RawNetworkEvent) => {
    try {
      // A request that started while we were active can complete AFTER destroy()
      // (fetch `emit()` / XHR `load` fire asynchronously). The entry-guard on the
      // wrappers can't stop that, so drop it here — a retired listener enqueues
      // nothing into the torn-down graph.
      if (!this.active) {
        return;
      }
      if (this.shouldIgnoreRequest(event.url)) {
        return;
      }

      const fullEvent = this.buildEvent(event);
      this.queueEvent(fullEvent);
    } catch (error) {
      handleError(error);
    }
  };

  buildEvent = (event: RawNetworkEvent) => {
    this.logger.log("[network-events-listener.buildEvent] called", {
      event,
    });

    return this.enricher.enrich(
      shapeNetworkEvent(event, {
        privacy: this.config.getPrivacy(),
        maxBodyLength: this.maxBodyLength,
        tracing: this.config.getConfig()?.options?.tracing,
        resolveUrl: (url) => {
          try {
            // Parsed: the pathname is query-free, so it is the route.
            return { path: new URL(url).pathname, fullUrl: url };
          } catch {
            // Relative: resolve the full URL against the page, and keep the
            // raw URL (query included, redacted by the shaper) as the route.
            return { path: url, fullUrl: new URL(url, globalThis.location.href).href };
          }
        },
      })
    );
  };

  queueEvent(event: EnrichedEvent) {
    try {
      this.logger.log("[network-events-listener.queueEvent] called");

      if (event) {
        this.eventsPool.addEvent(event);
      }
    } catch (error) {
      handleError(error);
    }
  }

  private xhrPatches(): [
    PatchSpec<XMLHttpRequest["open"]>,
    PatchSpec<XMLHttpRequest["setRequestHeader"]>,
    PatchSpec<XMLHttpRequest["send"]>,
  ] {
    const self = this;
    const proto = globalThis.XMLHttpRequest.prototype;

    let startTime: number;

    const open: PatchSpec<XMLHttpRequest["open"]> = {
      get: () => proto.open,
      set: (fn) => {
        proto.open = fn;
      },
      wrap: (originalXHROpen) =>
        function (
          this: XMLHttpRequest,
          method: string,
          url: string | URL,
          async: boolean = true,
          username?: string | null,
          password?: string | null
        ) {
          // Retired but reachable via a host chain → pass straight through.
          if (!self.active) {
            return originalXHROpen.apply(this, [method, url, async, username, password]);
          }
          startTime = Date.now();
          if (self.shouldIgnoreRequest(url.toString())) {
            return originalXHROpen.apply(this, [
              method,
              url,
              async,
              username,
              password,
            ]);
          }

          // Convert relative URLs to absolute URLs using the current location
          const fullUrl = new URL(url.toString(), globalThis.location.href).href;

          (this as any)._requestMethod = method;
          (this as any)._requestUrl = fullUrl; // Store the full URL instead of the raw url parameter
          (this as any)._requestHeaders = {};
          return originalXHROpen.apply(this, [
            method,
            url,
            async,
            username,
            password,
          ]);
        },
    };

    const setRequestHeader: PatchSpec<XMLHttpRequest["setRequestHeader"]> = {
      get: () => proto.setRequestHeader,
      set: (fn) => {
        proto.setRequestHeader = fn;
      },
      wrap: (originalXHRSetRequestHeader) =>
        function (
          this: XMLHttpRequest,
          name: string,
          value: string
        ) {
          if (!self.active) {
            return originalXHRSetRequestHeader.apply(this, [name, value]);
          }
          if ((this as any)._requestHeaders) {
            (this as any)._requestHeaders[name] = value;
          }
          return originalXHRSetRequestHeader.apply(this, [name, value]);
        },
    };

    const send: PatchSpec<XMLHttpRequest["send"]> = {
      get: () => proto.send,
      set: (fn) => {
        proto.send = fn;
      },
      wrap: (originalXHRSend) =>
        function (this: XMLHttpRequest, ...params: Parameters<XMLHttpRequest["send"]>) {
          if (!self.active) {
            return originalXHRSend.apply(this, params);
          }

          const requestUrl = (this as any)._requestUrl?.toString();

          if (!requestUrl || self.shouldIgnoreRequest(requestUrl)) {
            return originalXHRSend.apply(this, params);
          }

          const shouldAddTraceHeader = self.shouldAddTraceHeader(requestUrl);

          if (shouldAddTraceHeader) {
            for (const [headerName, headerValue] of Object.entries(self.buildTraceHeaders())) {
              self.addHeaderToXhrRequest({ request: this, headerName, headerValue });
            }
          }

          (this as any)._requestBody = params[0] || "";

          this.addEventListener("load", () => {
            const endTime = Date.now();

            const responseHeaders: Record<string, string> = {};
            this.getAllResponseHeaders()
              .split(/\r?\n/)
              .forEach((line: string) => {
                const [key, value] = line.split(": ");
                if (key && value) responseHeaders[key.trim()] = value.trim();
              });

            const requestBody = capBody(formatWebBody((this as any)._requestBody), self.maxBodyLength, BODY_PLACEHOLDER.requestTooLarge);
            // A text/"" responseType is a raw decoded string that could be binary
            // mojibake, so classify it by content-type (parity with the fetch path);
            // typed responseTypes keep formatBody's precise JS-type handling.
            const isTextResponseType =
              this.responseType === "" || this.responseType === "text";
            const xhrResponseBody = isTextResponseType
              ? this.responseText
              : this.response;
            const contentTypePlaceholder = isTextResponseType
              ? classifyBody(responseHeaders["content-type"] || "")
              : null;
            const responseBody =
              contentTypePlaceholder ??
              capBody(formatWebBody(xhrResponseBody), self.maxBodyLength, BODY_PLACEHOLDER.responseTooLarge);

            const networkEvent = {
              timestamp: startTime,
              end_time: endTime,
              method: (this as any)._requestMethod,
              url: (this as any)._requestUrl,
              status: this.status,
              request: {
                headers: (this as any)._requestHeaders || {},
                body: requestBody,
              },
              response: {
                headers: responseHeaders,
                body: responseBody,
              },
            };

            self.handleEvent(networkEvent);
          });

          return originalXHRSend.apply(this, params);
        },
    };

    return [open, setRequestHeader, send];
  }

  private normalizeHeaders(requestHeaders?: HeadersInit, initHeaders?: HeadersInit): Headers {
    try {
      const baseHeaders = requestHeaders ? new Headers(requestHeaders) : new Headers();

      if (!initHeaders) {
        return baseHeaders;
      }

      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => baseHeaders.set(key, value));
      } else if (Array.isArray(initHeaders)) {
        new Headers(initHeaders as [string, string][]).forEach((value, key) => baseHeaders.set(key, value));
      } else if (typeof initHeaders === "object") {
        Object.entries(initHeaders as Record<string, string>).forEach(([key, value]) => baseHeaders.set(key, value));
      }

      return baseHeaders;
    } catch {
      return new Headers();
    }
  }

  private addTraceHeaders(init: RequestInit): void {
    for (const [headerName, headerValue] of Object.entries(this.buildTraceHeaders())) {
      this.addHeaderToFetchRequest({ init, headerName, headerValue });
    }
  }

  // The headers this traced request carries — one map for both transports.
  private buildTraceHeaders(): Record<string, string> {
    return buildTraceHeaders(
      this.config.getConfig()?.options?.tracing,
      generateTraceIds(this.idGenerator)
    );
  }

  private extractHeadersRecord(headers?: HeadersInit): Record<string, string> {
    const result: Record<string, string> = {};

    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        result[key] = value;
      });
    }

    return result;
  }

  private fetchPatch(): PatchSpec<typeof globalThis.fetch> {
    return {
      get: () => globalThis.fetch,
      set: (fn) => {
        globalThis.fetch = fn;
      },
      wrap: (originalFetch) => (...args) => {
        // Retired (destroyed) but still reachable via a host delegation chain:
        // pass straight through — no tracing, no capture.
        if (!this.active) {
          return originalFetch.apply(globalThis, args);
        }

        const startTime = Date.now();

        let [input, init] = args;
        init = { ...(init || {}) };
        args[1] = init;
        const inputIsRequest = input instanceof Request;
        // openapi-fetch (and any `fetch(new Request(...))` caller) puts the method
        // and body on the Request object, not in `init`. Reading `init.method` alone
        // mislabels every such request as GET — fall back to the Request's method.
        const method = init?.method || (inputIsRequest ? (input as Request).method : "GET");

        const url = input instanceof Request ? input.url : input.toString();

        if (this.shouldIgnoreRequest(url)) {
          return originalFetch.apply(globalThis, args);
        }

        const shouldAddTraceHeader = this.shouldAddTraceHeader(url);

        init.headers = this.normalizeHeaders(inputIsRequest ? (input as Request).headers : undefined, init.headers);

        if (shouldAddTraceHeader) {
          this.addTraceHeaders(init);
        }

        const requestHeaders = this.extractHeadersRecord(init.headers);

        // Capture the request body from either init.body (sync) or a Request clone
        // (async — openapi-fetch puts the body there). Keep the sync value so the
        // failure path can enqueue immediately without awaiting the read.
        const syncRequestBody =
          init?.body != null
            ? capBody(formatWebBody(init.body), this.maxBodyLength, BODY_PLACEHOLDER.requestTooLarge)
            : "";
        const requestBodyPromise: Promise<string> =
          init?.body != null
            ? Promise.resolve(syncRequestBody)
            : inputIsRequest
              ? this.getRequestBody(
                  input as Request,
                  // Presence-aware, not `||`: an explicit init override to "" is a
                  // deliberate empty content-type and must win; only when the key is
                  // absent do we fall back to the Request's own header.
                  "content-type" in requestHeaders
                    ? requestHeaders["content-type"]
                    : (input as Request).headers.get("content-type") ?? ""
                )
              : Promise.resolve("");

        // Record the async body once it resolves, so the failure path can use it
        // if already done (else it falls back to syncRequestBody) — never waiting.
        let resolvedRequestBody: string | undefined;
        requestBodyPromise.then((b) => {
          resolvedRequestBody = b;
        }).catch(() => { /* getRequestBody never rejects; defensive */ });

        return originalFetch
          .apply(globalThis, args)
          .then((response) => {
            const endTime = Date.now();

            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              headers[key] = value;
            });

            const networkEvent = {
              method,
              url,
              timestamp: startTime,
              status: response.status,
              end_time: endTime,
              request: {
                headers: requestHeaders,
                body: "",
              },
              response: {
                headers,
                body: ''
              },
            };

            // Resolve the captured request body (possibly read from a Request
            // clone) before enqueuing — the fetch has already been sent, so this
            // only defers the SDK event, never the app's request/response.
            const emit = () => {
              requestBodyPromise.then((requestBody) => {
                networkEvent.request.body = requestBody;
                this.handleEvent(networkEvent);
              });
            };

            // Capture the response body under the shared contract; getResponseBody
            // tees via response.clone() so the app still reads its own body. A
            // rejected/unreadable read records a placeholder, never a partial.
            this.getResponseBody(response)
              .then((body) => {
                networkEvent.response.body = body;
                emit();
              })
              .catch((error) => {
                networkEvent.response.body = BODY_PLACEHOLDER.responseUnreadable;
                emit();
                this.logger.log("[network-events-listener.fetch] response body error", {
                  error,
                });
              });

            return response;
          })
          .catch((error: Error) => {
            const endTime = Date.now();

            let errorType = "NetworkError";
            const errorMessage = error.message || "Unknown network error";

            if (
              error instanceof TypeError &&
              errorMessage.includes("Failed to fetch")
            ) {
              errorType = "ERR_NETWORK_FAILURE";
            } else if (errorMessage.includes("Name not resolved")) {
              errorType = "ERR_NAME_NOT_RESOLVED";
            } else if (errorMessage.includes("Connection refused")) {
              errorType = "ERR_CONNECTION_REFUSED";
            }

            // Best-effort body WITHOUT waiting: use the async read if it already
            // resolved (common for small bodies), else the synchronous value.
            const failureRequestBody = resolvedRequestBody ?? syncRequestBody;

            const networkEvent = {
              method,
              url,
              timestamp: startTime,
              status: 0,
              end_time: endTime,
              request: {
                headers: requestHeaders,
                body: failureRequestBody,
              },
              response: {
                headers: {},
                body: "",
              },
              error: {
                type: errorType,
              },
            };

            // Enqueue IMMEDIATELY — don't await requestBodyPromise. A rejection
            // often fires as the page unloads (when the pool does its final flush),
            // so deferring on an async body read could drop this event.
            this.handleEvent(networkEvent);

            throw error;
          });
      },
    };
  }

  private addHeaderToXhrRequest({
    request,
    headerName,
    headerValue,
  }: {
    request: XMLHttpRequest;
    headerName: string;
    headerValue: string;
  }) {
    this.logger.log("[network-events-listener.addHeaderToXhrRequest] called", {
      request,
      headerName,
      headerValue,
    });
    
    if (!isValidHeaderName(headerName)) {
      this.logger.log("[network-events-listener.addHeaderToXhrRequest] Invalid header name", {
        headerName,
      });
      return;
    }
    
    try {
      request.setRequestHeader(headerName, headerValue);
      (request as any)._requestHeaders[headerName] = headerValue;
    } catch (error) {
      this.logger.log("[network-events-listener.addHeaderToXhrRequest] Error setting header", {
        error,
        headerName,
        headerValue,
      });
    }
  }

  private addHeaderToFetchRequest({
    init,
    headerName,
    headerValue,
  }: {
    init: RequestInit;
    headerName: string;
    headerValue: string;
  }) {
    this.logger.log("[network-events-listener.addHeaderToFetchRequest] called", {
      init,
      headerName,
      headerValue,
    });

    if (!isValidHeaderName(headerName)) {
      this.logger.log("[network-events-listener.addHeaderToFetchRequest] Invalid header name", {
        headerName,
      });
      return;
    }

    try {
      if (init.headers instanceof Headers) {
        init.headers.set(headerName, headerValue);
      } else {
        init.headers = { ...init.headers, [headerName]: headerValue };
      }
    } catch (error) {
      this.logger.log("[network-events-listener.addHeaderToFetchRequest] Error setting header", {
        error,
        headerName,
        headerValue,
      });
    }
  }

  shouldAddTraceHeader(url: string) {
    const result = matchesPropagationUrl(
      this.propagationCandidates(url),
      this.config.getConfig()?.options?.tracing?.propagationUrls
    );

    this.logger.log("[network-events-listener.shouldAddTraceHeader] result", {
      url,
      result,
    });

    return result;
  }

  // What a propagationUrls pattern is matched against: the URL the browser will
  // actually request (resolved against the page, dot segments removed), plus —
  // for a same-origin request only — its pathname. A path pattern like
  // `/api/*` therefore traces the app's own API whether the call was written
  // relative or absolute, over fetch, XHR or a Request, but never sends trace
  // headers to another host with the same path, or to a path it only spells.
  private propagationCandidates(url: string): string[] {
    try {
      const base = globalThis.location.href;
      const resolved = new URL(url, base);
      const candidates = [resolved.href];
      // A bare origin serializes with a trailing slash; keep an origin pattern
      // written without one ("https://api.example.com") matching.
      if (resolved.pathname === "/" && !resolved.search && !resolved.hash) {
        candidates.push(resolved.href.slice(0, -1));
      }
      if (resolved.origin === new URL(base).origin) candidates.push(resolved.pathname);
      return candidates;
    } catch {
      // Unparseable, or no page location: match the URL as given.
      return [url];
    }
  }
}
