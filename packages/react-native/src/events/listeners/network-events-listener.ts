import {
  BaseListener,
  buildTraceHeaders,
  capBody,
  classifyBody,
  formatBody,
  generateTraceIds,
  handleError,
  isEventStream,
  isKnownEmptyResponse,
  matchesPropagationUrl,
  NETWORK_BODY_PLACEHOLDER as BODY_PLACEHOLDER,
  PatchSet,
  type PatchSpec,
  RandomIdGenerator,
  shapeNetworkEvent,
  shouldIgnoreUrl,
  type EnrichedEvent,
  type CoreEventType,
  type RawNetworkEvent,
} from "@groundcover/rum-core";
import type { RNExtraEventType } from "../rn-event-types";
import { warnOnce } from "../../internal/safe-warn";

// Capture over BOTH transports. Patching XHR alone is not enough: Expo replaces the
// global `fetch` with a native-backed one, so most traffic on a modern Expo app would
// be captured by nothing. Both are wrapped, gated per call by `fetchProbe`.
//
// Interception only: shaping, the body gate, trace headers and the URL filter are
// core's, shared with the browser. RN's own parts: no `new URL` (paths are
// regex-extracted), failures via XHR `error`/`timeout`, and Blob bodies read with
// FileReader.

const PATH_PATTERN_WARNING =
  "[groundcover] tracing.propagationUrls entries are matched against the full request URL, so a "
  + "path-only pattern such as \"/api/*\" matches no request. Use a full URL pattern, e.g. "
  + "\"https://api.myapp.com/*\".";

// Signals that a response body must be read asynchronously (a textual Blob).
const NEEDS_ASYNC = Symbol("gc.needsAsyncBody");
const BLOB_READ_TIMEOUT_MS = 3000;

// Absolute-URL path extractor: scheme://authority(/path)?(?#…). RN requires
// absolute request URLs, so there is no relative case to resolve.
const URL_PATH_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i;

interface PatchedXHR extends XMLHttpRequest {
  _gcMethod?: string;
  _gcUrl?: string;
  _gcHeaders?: Record<string, string>;
  _gcStart?: number;
  _gcBody?: string;
}

// Structurally typed rather than lib.dom's `fetch`: the runtime one may be
// Expo's WinterCG implementation, whose Response is its own class. Only the
// members actually read below are required.
type FetchLike = (input: unknown, init?: unknown) => Promise<FetchResponseLike>;

/**
 * A cloned response, read either as a stream or in one go. `body` is optional
 * because most RN runtimes expose none — whatwg-fetch has no streaming at all — so
 * `text()` has to stay as the fallback rather than being replaced.
 */
type ClonedResponse = {
  text: () => Promise<string>;
  blob?: () => Promise<{ size?: number }>;
  body?: {
    getReader?: () => {
      read: () => Promise<{ done?: boolean; value?: unknown }>;
      cancel?: () => unknown;
    };
  } | null;
};

type FetchResponseLike = {
  status: number;
  headers?: { forEach?: (cb: (value: string, key: string) => void) => void };
  clone?: () => ClonedResponse;
};

export class NetworkEventsListener extends BaseListener<RNExtraEventType> {
  private maxBodyLength = 5000;
  private idGenerator = new RandomIdGenerator();
  private active = false;

  // Our XHR and fetch wrappers, installed as two independent groups: a host with
  // a frozen XMLHttpRequest.prototype must not lose the fetch capture, or the
  // reverse. Restored only where a slot still holds our wrapper.
  private patches = new PatchSet();

  /**
   * Records "the fetch call now executing opened an XHR of its own", so the two
   * wrappers never report one request twice. PER CALL, not per runtime:
   * `fetch.polyfill` is set by only some XHR-backed implementations and by some
   * native ones, and a latch misses a `fetch` that tunnels only SOME requests.
   *
   * Saved and restored rather than cleared, since fetch implementations call fetch.
   * Relies on the XHR being opened synchronously inside the call; a runtime that
   * deferred it would be double-reported, which is the failure to prefer.
   */
  private fetchProbe: (() => void) | null = null;

  initialize(): void {
    const propagationUrls = this.config.getConfig()?.options?.tracing?.propagationUrls;
    if (propagationUrls?.some((pattern) => typeof pattern === "string" && pattern.startsWith("/"))) {
      warnOnce(PATH_PATTERN_WARNING);
    }
    // Defensive: RN always has XMLHttpRequest, but a non-RN host (SSR, a test
    // runner without a DOM) may not. No XHR → nothing to patch.
    if (typeof XMLHttpRequest === "undefined") return;
    this.patches.install(this.xhrPatches());
    // Finding fetch reads the global, which a host can put behind a throwing
    // accessor — contained like the install itself, so the XHR capture survives.
    let fetchPatch: PatchSpec<FetchLike> | null = null;
    try {
      fetchPatch = this.fetchPatch();
    } catch (error) {
      handleError(error);
    }
    if (fetchPatch) this.patches.install([fetchPatch]);
    this.active = true;
  }

  destroy(): void {
    // Stand our wrappers down first (a wrapper still reachable via a host chain
    // goes inert), then guarded-restore only where we are STILL the wrapper.
    this.active = false;
    this.patches.restore();
  }

  handleEvent(event: RawNetworkEvent): void {
    try {
      if (!this.active) return;
      if (this.shouldIgnoreRequest(event.url)) return;
      this.queueEvent(this.buildEvent(event));
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent(event: RawNetworkEvent): EnrichedEvent<CoreEventType | RNExtraEventType> {
    return this.enricher.enrich(
      shapeNetworkEvent(event, {
        privacy: this.config.getPrivacy(),
        maxBodyLength: this.maxBodyLength,
        tracing: this.config.getConfig()?.options?.tracing,
        resolveUrl: (url) => ({ path: this.extractPath(url), fullUrl: url }),
      })
    );
  }

  queueEvent(event: EnrichedEvent<CoreEventType | RNExtraEventType>): void {
    try {
      this.eventsPool.addEvent(event);
    } catch (error) {
      handleError(error);
    }
  }

  private extractPath(url: string): string {
    try {
      const match = URL_PATH_RE.exec(url);
      if (!match) return url; // not an absolute URL we recognize — leave as-is
      // An empty group means a root URL: return "/", never the whole URL, which
      // would blow up cardinality and could carry the query.
      const path = (match[1] || "").split("?")[0];
      return path || "/";
    } catch {
      return url;
    }
  }

  private shouldIgnoreRequest(url: string): boolean {
    try {
      const config = this.config.getConfig();
      return shouldIgnoreUrl(url, { endpoint: config?.getEndpoint(), excludedUrls: config?.options?.excludedUrls });
    } catch (error) {
      handleError(error);
      return false;
    }
  }

  private xhrPatches(): [
    PatchSpec<XMLHttpRequest["open"]>,
    PatchSpec<XMLHttpRequest["setRequestHeader"]>,
    PatchSpec<XMLHttpRequest["send"]>,
  ] {
    // The wrappers need the call-site `this` (the XHR instance), so they are
    // `function`s and the listener is captured in a local.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const proto = XMLHttpRequest.prototype as unknown as PatchedXHR;

    const open: PatchSpec<XMLHttpRequest["open"]> = {
      get: () => proto.open,
      set: (fn) => {
        proto.open = fn;
      },
      wrap: (originalOpen) =>
        function (this: PatchedXHR, method: string, url: string | { toString(): string }, ...rest: unknown[]) {
          // An XHR opened while the host's fetch is running IS that fetch. Recorded
          // before the `active` check: it is a fact about that call, not about us.
          self.fetchProbe?.();
          if (!self.active) return originalOpen.apply(this, [method, url, ...rest] as never);
          const urlStr = url.toString();
          this._gcStart = Date.now();
          this._gcMethod = method;
          this._gcUrl = urlStr;
          this._gcHeaders = {};
          return originalOpen.apply(this, [method, url, ...rest] as never);
        } as XMLHttpRequest["open"],
    };

    const setRequestHeader: PatchSpec<XMLHttpRequest["setRequestHeader"]> = {
      get: () => proto.setRequestHeader,
      set: (fn) => {
        proto.setRequestHeader = fn;
      },
      wrap: (originalSetRequestHeader) =>
        function (this: PatchedXHR, name: string, value: string) {
          if (self.active && this._gcHeaders) this._gcHeaders[name] = value;
          return originalSetRequestHeader.apply(this, [name, value]);
        },
    };

    const send: PatchSpec<XMLHttpRequest["send"]> = {
      get: () => proto.send,
      set: (fn) => {
        proto.send = fn;
      },
      wrap: (originalSend) =>
        function (this: PatchedXHR, ...params: unknown[]) {
          // Instrumentation must never prevent OR duplicate the host's request, so it
          // is all inside this try and originalSend runs exactly once outside it. The
          // guards are nested `if`s rather than early returns for the same reason.
          try {
            if (self.active) {
              const requestUrl = this._gcUrl;
              if (requestUrl && !self.shouldIgnoreRequest(requestUrl)) {
                if (self.shouldAddTraceHeader(requestUrl)) self.injectTraceHeaders(this);

                this._gcBody = self.cap(formatBody(params[0] ?? ""), BODY_PLACEHOLDER.requestTooLarge);

                const finish = (error?: { type: string }) => {
                  try {
                    // Stamped BEFORE any async body read, so a blob's FileReader latency
                    // cannot inflate the captured duration.
                    const endTime = Date.now();
                    const headers = self.parseResponseHeaders(this);
                    // A failed request has no response to read — an empty body, rather than
                    // mis-classifying the absent one as binary.
                    const body = error ? "" : self.readResponseBodySync(this, headers);
                    if (body !== NEEDS_ASYNC) {
                      self.handleEvent(self.collect(this, error, headers, body, endTime));
                      return;
                    }
                    // A textual Blob (RN's polyfill sets responseType "blob") is read off the
                    // sync path, still stamped with the load-time endTime above.
                    self.readBlobText(this).then(
                      (text) => self.handleEvent(self.collect(this, error, headers, text, endTime)),
                      () =>
                        self.handleEvent(
                          self.collect(this, error, headers, BODY_PLACEHOLDER.responseUnavailable, endTime)
                        )
                    );
                  } catch (e) {
                    handleError(e);
                  }
                };
                this.addEventListener("load", () => finish());
                this.addEventListener("error", () => finish({ type: "ERR_NETWORK_FAILURE" }));
                this.addEventListener("timeout", () => finish({ type: "ERR_TIMEOUT" }));
                // "abort" is user-cancelled — deliberately not reported.
              }
            }
          } catch (error) {
            handleError(error);
          }

          return originalSend.apply(this, params as never);
        },
    };

    return [open, setRequestHeader, send];
  }

  /**
   * Wrap the global `fetch` — always, never skipped up front. Whether a request is
   * XHR-backed (and so already reported) is decided per CALL. See `fetchProbe`.
   */
  private fetchPatch(): PatchSpec<FetchLike> | null {
    const g = globalThis as unknown as { fetch?: FetchLike };
    if (typeof g.fetch !== "function") return null;
    return {
      get: () => g.fetch as FetchLike,
      set: (fn) => {
        g.fetch = fn;
      },
      wrap: (original) => this.wrapFetch(original),
    };
  }

  private wrapFetch(original: FetchLike): FetchLike {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return function (this: unknown, input: unknown, init?: unknown): Promise<FetchResponseLike> {
      // Every line here is contained: on any internal error we fall through to the
      // original call untouched.
      let started = Date.now();
      let url = "";
      let method = "GET";
      let requestHeaders: Record<string, string> = {};
      let requestBody = "";
      let nextInit = init;
      let observe = false;
      // Set only when the body has to be read off a Request asynchronously.
      let requestBodyPending: Promise<string> | null = null;
      // The caller's cancellation signal, read at rejection time — see `isAbortRejection`.
      let abortSignal: { aborted?: unknown } | undefined;

      try {
        if (self.active) {
          const req = input as { url?: unknown; method?: unknown } | string;
          url = typeof req === "string" ? req : String((req as { url?: unknown })?.url ?? input);
          const initObj = (init ?? {}) as { method?: unknown; headers?: unknown; body?: unknown };
          method = String(
            initObj.method ?? (typeof req === "object" ? (req as { method?: unknown })?.method : undefined) ?? "GET"
          ).toUpperCase();

          if (url && !self.shouldIgnoreRequest(url)) {
            observe = true;
            // `init.signal` wins over the Request's, per the Fetch standard's construction of
            // `new Request(input, init)`.
            abortSignal = ((initObj as { signal?: unknown }).signal ??
              (isRequestLike(input) ? (input as { signal?: unknown }).signal : undefined)) as
              | { aborted?: unknown }
              | undefined;
            // With a Request, the caller's headers live on IT — so with no `init.headers` the
            // Request's list is the merge base, or every caller header (Authorization included)
            // is stripped the moment tracing rebuilds `init`.
            //
            // But ONLY then. A present `init.headers` REPLACES the Request's list — Expo
            // resolves them as `init?.headers ?? request.headers`, and the Fetch standard says
            // the same — and `fetch(req, { headers })` is how a caller DROPS a credential before
            // a retry or a cross-host redirect. Merging unconditionally puts it back, and with
            // tracing on the merged map becomes the `init` handed to the real fetch: the
            // Authorization the caller removed goes out on the wire.
            const callerHeaders = {
              ...(initObj.headers == null
                ? normalizeHeaders(isRequestLike(input) ? (input as { headers?: unknown }).headers : undefined)
                : {}),
              ...normalizeHeaders(initObj.headers),
            };
            requestHeaders = callerHeaders;
            // Any non-null `init.body` is an explicit override, `""` included: Expo resolves
            // the body as `init.body ?? request.body`, and `??` keeps the empty string, so that
            // is what goes out. Reading `""` as "no body given" falls through to the Request
            // below and reports a payload the server never received. (Bare RN's whatwg-fetch
            // uses a falsy test and WOULD send the Request's body — under-reporting there is
            // the safer half of that disagreement than publishing a body that was blanked.)
            if (initObj.body != null) {
              requestBody = self.cap(formatBody(initObj.body), BODY_PLACEHOLDER.requestTooLarge);
            } else if (isRequestLike(input)) {
              // Same rule as the headers: the body lives on the Request, and reading
              // only `init` would report an empty one for every generated API client.
              // Cloned before the original call — once the runtime starts reading a
              // Request's body it can no longer be cloned.
              // Gated on the effective content-type like the browser's: a binary or
              // multipart body is labelled, never decoded.
              requestBodyPending = readRequestBody(input, callerHeaders["content-type"] ?? "", (text) =>
                self.cap(text, BODY_PLACEHOLDER.requestTooLarge)
              );
            }

            if (self.shouldAddTraceHeader(url)) {
              const trace = self.buildTraceHeaders();
              requestHeaders = { ...callerHeaders, ...trace };
              // Merge rather than replace: the caller's own headers must survive.
              nextInit = { ...(initObj as object), headers: { ...callerHeaders, ...trace } };
            }
            started = Date.now();
          }
        }
      } catch (error) {
        handleError(error);
        observe = false;
      }

      // Bracketed so the XHR patch can see whether this fetch opens an XHR of its
      // own — see `fetchProbe`. `finally`, because the host's fetch may throw.
      let usedXhr = false;
      let promise: Promise<FetchResponseLike>;
      const outerProbe = self.fetchProbe;
      self.fetchProbe = () => {
        usedXhr = true;
      };
      try {
        promise = original.call(this, input, nextInit) as Promise<FetchResponseLike>;
      } finally {
        self.fetchProbe = outerProbe;
      }
      // Checked AFTER the call: an XHR-backed fetch has opened its request by now,
      // so even the very first one is not double-reported.
      if (!observe || usedXhr) return promise;

      // endTime is passed in, never taken here: it is stamped when the response
      // settles, before the body is read. The XHR path does the same.
      const report = (
        endTime: number,
        status: number,
        responseHeaders: Record<string, string>,
        body: string,
        error?: { type: string }
      ) => {
        try {
          self.handleEvent({
            timestamp: started,
            end_time: endTime,
            method,
            url,
            status,
            request: { headers: requestHeaders, body: requestBody },
            response: { headers: responseHeaders, body },
            ...(error ? { error } : {}),
          });
        } catch (e) {
          handleError(e);
        }
      };

      // Waits for a Request body read, when there is one. `endTime` was already
      // stamped by the caller, so this cannot inflate the captured duration.
      const emit = (
        endTime: number,
        status: number,
        responseHeaders: Record<string, string>,
        body: string,
        error?: { type: string }
      ) => {
        const pending = requestBodyPending;
        if (!pending) {
          report(endTime, status, responseHeaders, body, error);
          return;
        }
        requestBodyPending = null;
        pending.then(
          (text) => {
            requestBody = text;
            report(endTime, status, responseHeaders, body, error);
          },
          () => report(endTime, status, responseHeaders, body, error)
        );
      };

      promise.then(
        (response) => {
          // Stamped before reading the body, so read latency cannot inflate it.
          const endedAt = Date.now();
          let responseHeaders: Record<string, string> = {};
          try {
            response?.headers?.forEach?.((value, key) => {
              responseHeaders[String(key).toLowerCase()] = String(value);
            });
          } catch {
            responseHeaders = {};
          }
          const status = Number(response?.status ?? 0);

          // Classify BEFORE touching the body, as the XHR path does: otherwise an
          // image or protobuf is fully decoded into a JS string — a memory spike,
          // and binary in telemetry — only for capBody to truncate it. A known-empty
          // response is "" first, so its absent content-type isn't read as binary.
          if (isKnownEmptyResponse({ method, status, headers: responseHeaders })) {
            emit(endedAt, status, responseHeaders, "");
            return;
          }
          const contentType = responseHeaders["content-type"] || "";
          // An SSE stream never closes, so a capped read would wait on it forever.
          if (isEventStream(contentType)) {
            emit(endedAt, status, responseHeaders, BODY_PLACEHOLDER.responseUnreadable);
            return;
          }
          const responseBodyPlaceholder = classifyBody(contentType);
          if (responseBodyPlaceholder != null) {
            emit(endedAt, status, responseHeaders, responseBodyPlaceholder);
            return;
          }

          // clone() so the host still gets an unread body. A runtime without it
          // degrades to the placeholder rather than risking the caller's response.
          let cloned: ClonedResponse | undefined;
          try {
            cloned = response?.clone?.();
          } catch {
            cloned = undefined;
          }
          if (!cloned) {
            emit(endedAt, status, responseHeaders, BODY_PLACEHOLDER.responseUnavailable);
            return;
          }
          // One character past the cap, never the whole body: that is all capBody
          // needs to tell "too large" from "exactly at the limit".
          readCappedText(cloned, self.maxBodyLength + 1).then(
            (text) => emit(endedAt, status, responseHeaders, self.cap(text, BODY_PLACEHOLDER.responseTooLarge)),
            () => emit(endedAt, status, responseHeaders, BODY_PLACEHOLDER.responseUnavailable)
          );
        },
        (err: unknown) => {
          // A rejected fetch is the XHR path's "error" case; status 0 mirrors it so
          // both transports read the same on the wire. "abort" is user-cancelled and
          // unreported on the XHR side — same contract here.
          if (isAbortRejection(err, abortSignal)) return;
          emit(Date.now(), 0, {}, "", { type: "ERR_NETWORK_FAILURE" });
        }
      );

      return promise;
    } as unknown as FetchLike;
  }

  private parseResponseHeaders(xhr: PatchedXHR): Record<string, string> {
    const responseHeaders: Record<string, string> = {};
    try {
      (xhr.getAllResponseHeaders() || "").split(/\r?\n/).forEach((line) => {
        const idx = line.indexOf(":");
        if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      });
    } catch {
      /* headers unavailable on a failed request */
    }
    return responseHeaders;
  }

  private collect(
    xhr: PatchedXHR,
    error: { type: string } | undefined,
    responseHeaders: Record<string, string>,
    responseBody: string,
    endTime: number
  ): RawNetworkEvent {
    return {
      timestamp: xhr._gcStart ?? endTime,
      end_time: endTime,
      method: xhr._gcMethod ?? "UNKNOWN",
      url: xhr._gcUrl ?? "",
      status: error ? 0 : xhr.status,
      request: { headers: xhr._gcHeaders ?? {}, body: xhr._gcBody ?? "" },
      response: { headers: responseHeaders, body: responseBody },
      error,
    };
  }

  // The XHR response body cases readable without I/O: responseText, a parsed
  // `responseType:"json"`, and a string `response`. A textual Blob returns
  // NEEDS_ASYNC for readBlobText; binary, form-data and an absent content-type
  // get a placeholder; a known-empty response is "".
  private readResponseBodySync(
    xhr: PatchedXHR,
    headers: Record<string, string>
  ): string | typeof NEEDS_ASYNC {
    try {
      if (isKnownEmptyResponse({ method: xhr._gcMethod, status: xhr.status, headers })) return "";
      const contentType = headers["content-type"] || "";
      const placeholder = classifyBody(contentType);
      if (placeholder != null) return placeholder;
      const responseType = xhr.responseType;
      if (responseType === "" || responseType === "text") {
        return this.cap(formatBody(xhr.responseText), BODY_PLACEHOLDER.responseTooLarge);
      }
      if (responseType === "json") {
        return this.cap(formatBody(JSON.stringify(xhr.response)), BODY_PLACEHOLDER.responseTooLarge);
      }
      if (typeof xhr.response === "string") {
        return this.cap(formatBody(xhr.response), BODY_PLACEHOLDER.responseTooLarge);
      }
      if (isBlobLike(xhr.response)) return NEEDS_ASYNC;
      return BODY_PLACEHOLDER.responseUnavailable;
    } catch {
      return BODY_PLACEHOLDER.responseUnavailable;
    }
  }

  // A textual Blob body via FileReader, off the sync path. Timeout-bounded so a
  // stuck read cannot delay emission; failures become the "unavailable" placeholder.
  private readBlobText(xhr: PatchedXHR): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Hoisted so a synchronous throw from readAsText can still clear it —
      // otherwise the timer dangles, retaining the reader, and fires a stray abort.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (typeof FileReader === "undefined") {
          reject(new Error("no FileReader"));
          return;
        }
        const reader = new FileReader();
        timer = setTimeout(() => {
          try {
            reader.abort();
          } catch {
            /* ignore */
          }
          reject(new Error("blob read timeout"));
        }, BLOB_READ_TIMEOUT_MS);
        reader.onload = () => {
          clearTimeout(timer);
          resolve(this.cap(formatBody(String(reader.result ?? "")), BODY_PLACEHOLDER.responseTooLarge));
        };
        reader.onerror = () => {
          clearTimeout(timer);
          reject(reader.error ?? new Error("blob read error"));
        };
        reader.readAsText(xhr.response as Blob);
      } catch (e) {
        if (timer) clearTimeout(timer);
        reject(e);
      }
    });
  }

  private cap(text: string, tooLargePlaceholder: string): string {
    return capBody(text, this.maxBodyLength, tooLargePlaceholder);
  }

  /**
   * The trace headers this request should carry. Shared by both transports so a
   * header added for one is never silently missing on the other.
   */
  private buildTraceHeaders(): Record<string, string> {
    return buildTraceHeaders(this.config.getConfig()?.options?.tracing, generateTraceIds(this.idGenerator));
  }

  private injectTraceHeaders(xhr: PatchedXHR): void {
    const headers = this.buildTraceHeaders();
    for (const name of Object.keys(headers)) {
      try {
        xhr.setRequestHeader(name, headers[name] as string);
        if (xhr._gcHeaders) xhr._gcHeaders[name] = headers[name] as string;
      } catch (error) {
        handleError(error);
      }
    }
  }

  // Matched against the full URL only: RN has no page origin to scope a path
  // pattern to, so `/api/*` would send trace headers to every host with that path.
  shouldAddTraceHeader(url: string): boolean {
    return matchesPropagationUrl([url], this.config.getConfig()?.options?.tracing?.propagationUrls);
  }
}

// Whether `fetch`'s first argument is a Request rather than a URL. Duck-typed on
// `headers`, because `Request` is not guaranteed to be the same constructor (or to
// exist) across RN's runtimes, and the header list is all we need from it.
function isRequestLike(input: unknown): boolean {
  return typeof input === "object" && input !== null && "headers" in (input as Record<string, unknown>);
}

/**
 * Whether a rejected fetch is the caller cancelling, which neither transport reports.
 *
 * The SIGNAL is the fact; the error is only how a given runtime dresses it up. Expo's fetch —
 * the global under Expo 57 — rejects with a `FetchError` that assigns only `cause` and `stack`,
 * so `name` is the inherited "Error" and a name test never fires. Keeping the name test as well
 * covers a runtime that rejects with a spec `AbortError` on a signal we could not read (a signal
 * passed through a wrapper, say).
 *
 * `aborted` is read HERE rather than at call time: it is false when the request starts and true
 * by the time it rejects, which is precisely the question being asked.
 *
 * A signal from `AbortSignal.timeout()` reads as an abort too, so a fetch-side timeout goes
 * unreported where the XHR path would report one. That asymmetry is accepted — nothing in a
 * fetch rejection distinguishes the two — and cancelling is the far commoner case.
 */
function isAbortRejection(err: unknown, signal: { aborted?: unknown } | undefined): boolean {
  if (signal?.aborted) return true;
  return String((err as { name?: unknown })?.name ?? "") === "AbortError";
}

/**
 * The body of a Request passed as `fetch`'s first argument. Cloned, not read, and
 * cloned before `original.call` — a Request can only be cloned before anything
 * consumes it. A binary or multipart body (by the effective content-type) is
 * labelled without reading it. A failed read degrades to the "unavailable"
 * placeholder, never a throw: an unreported body is a telemetry gap, a thrown one
 * is a broken request.
 *
 * The emptiness check has to admit `_bodyInit`, not just `body`. React Native's global `Request`
 * is whatwg-fetch's, whose Body mixin defines `_bodyInit` / `_bodyText` / `bodyUsed` and NO `body`
 * accessor at all — so `body == null` alone is unconditionally true on the runtime this patch
 * exists for, and the clone below (which whatwg-fetch supports perfectly well: `clone()` passes
 * `{body: this._bodyInit}`, consuming nothing) would never be reached. Expo reads the same hidden
 * property in its own `dangerouslyGetBodyFromRequest`.
 */
function readRequestBody(input: unknown, contentType: string, cap: (text: string) => string): Promise<string> {
  try {
    const req = input as {
      body?: unknown;
      _bodyInit?: unknown;
      clone?: () => { text?: () => Promise<string> };
    };
    if (req.body == null && req._bodyInit == null) return Promise.resolve("");
    const placeholder = classifyBody(contentType);
    if (placeholder != null) return Promise.resolve(placeholder);
    const text = req.clone?.()?.text?.();
    if (!text) return Promise.resolve(BODY_PLACEHOLDER.requestUnavailable);
    return text.then(
      (value) => cap(String(value)),
      () => BODY_PLACEHOLDER.requestUnavailable
    );
  } catch {
    return Promise.resolve(BODY_PLACEHOLDER.requestUnavailable);
  }
}

/**
 * A response body read only as far as `limit` characters. `text()` decodes the WHOLE
 * body first — a 50 MB download buffered into a JS string to keep 5 KB — so where a
 * stream exists we stop pulling and cancel the rest.
 *
 * Where one does NOT — React Native's `whatwg-fetch` response exposes no
 * `body.getReader()`, so this is the ordinary RN path rather than an edge case — we
 * size the body as a Blob first. `blob()` moves the bytes natively without decoding
 * them, and `size` then answers "is this worth reading?" for free: over the limit is
 * reported as too-large without ever building a JS string, and under it the decode is
 * bounded by that same check. Only a runtime with neither streams nor Blob is left
 * without a bounded read, and that reports the body as unavailable rather than
 * decoding an unbounded one.
 */
function readCappedText(cloned: ClonedResponse, limit: number): Promise<string> {
  const reader = (() => {
    try {
      return cloned.body?.getReader?.();
    } catch {
      return undefined;
    }
  })();
  const decoder = reader && typeof TextDecoder === "function" ? new TextDecoder() : null;
  if (!reader || !decoder) return readSizedBlobText(cloned, limit);

  let out = "";
  const pump = (): Promise<string> =>
    reader.read().then(({ done, value }) => {
      if (done) return out + decoder.decode();
      out += decoder.decode(value as never, { stream: true });
      if (out.length >= limit) {
        // The host reads its own copy; cancelling ours releases the rest.
        try {
          reader.cancel?.();
        } catch {
          /* already closed */
        }
        return out;
      }
      return pump();
    });

  return pump().catch(() => readSizedBlobText(cloned, limit));
}

/**
 * The no-stream read: size the body as a Blob, then decode it only if it is small
 * enough to be worth decoding.
 *
 * Returning the too-large placeholder here rather than a truncated string is
 * deliberate — `capBody` decides "too large" from the LENGTH of what it is handed, so
 * a body cut to `limit` bytes would read to it as a body that merely happened to fit,
 * and the event would carry a silently truncated payload instead of an honest marker.
 */
function readSizedBlobText(cloned: ClonedResponse, limit: number): Promise<string> {
  try {
    const asBlob = cloned.blob?.();
    if (!asBlob) return Promise.resolve(BODY_PLACEHOLDER.responseUnavailable);
    return asBlob.then((blob) => {
      const size = blob?.size;
      if (typeof size !== "number") return BODY_PLACEHOLDER.responseUnavailable;
      // `>=`, matching capBody: at the limit is already too large. Decided from
      // the SIZE alone, before FileReader is even needed — an oversized body is
      // answered on a runtime that could not have read it anyway.
      if (size >= limit) return BODY_PLACEHOLDER.responseTooLarge;
      if (typeof FileReader === "undefined") return BODY_PLACEHOLDER.responseUnavailable;
      return readBlobAsText(blob).catch(() => BODY_PLACEHOLDER.responseUnavailable);
    }, () => BODY_PLACEHOLDER.responseUnavailable);
  } catch {
    return Promise.resolve(BODY_PLACEHOLDER.responseUnavailable);
  }
}

/** FileReader over a Blob already known to be under the cap. Timeout-bounded, like the XHR path. */
function readBlobAsText(blob: unknown): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = new FileReader();
      timer = setTimeout(() => {
        try {
          reader.abort();
        } catch {
          /* already finished */
        }
        reject(new Error("blob read timeout"));
      }, BLOB_READ_TIMEOUT_MS);
      reader.onload = () => {
        clearTimeout(timer);
        resolve(String(reader.result ?? ""));
      };
      reader.onerror = () => {
        clearTimeout(timer);
        reject(reader.error ?? new Error("blob read failed"));
      };
      reader.readAsText(blob as Blob);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * A header list (object, pair array, or Headers) as a plain map keyed by LOWERCASE
 * name; anything unrecognized yields `{}`. Lowercasing is load-bearing: a caller's
 * `Traceparent` beside our `traceparent` is two JS keys, which the runtime folds
 * into one comma-joined value that is not a valid traceparent — and lookups here are
 * case-sensitive. Lowercase on the wire is spec-correct for /1.1, required in /2.
 */
function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!headers) return out;
    // ARRAY FIRST. Arrays have `forEach`, so testing for the Headers-like shape
    // ahead of the tuple form would send `[["Authorization", "Bearer x"]]` down the
    // iterable branch with `value` = the pair and `key` = the index, yielding
    // `{ "0": "Authorization,Bearer x" }` and leaving this branch unreachable.
    // With tracing on, `init.headers` is rebuilt from this map, so the caller's
    // own Authorization would never reach the wire and the request would get a 401.
    if (Array.isArray(headers)) {
      for (const pair of headers as unknown[]) {
        if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
      return out;
    }
    const asIterable = headers as { forEach?: (cb: (value: string, key: string) => void) => void };
    if (typeof asIterable.forEach === "function") {
      asIterable.forEach((value, key) => {
        out[String(key).toLowerCase()] = String(value);
      });
      return out;
    }
    if (typeof headers === "object") {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        out[key.toLowerCase()] = String(value);
      }
    }
  } catch {
    return {};
  }
  return out;
}

// A Blob-shaped response (has a numeric `size`) — read via FileReader.
function isBlobLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { size?: unknown }).size === "number";
}
