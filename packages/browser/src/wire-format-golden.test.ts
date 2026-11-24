import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";

import { SessionManager } from "@/session-manager/session-manager";
import { Batch, BaseEvent } from "@groundcover/rum-core/events/types";
import { msToNs } from "@groundcover/rum-core/common/global";
import { SDKConfigInput, BrowserSessionAttributes } from "@/config/types";
import { BASE_CONFIG, drainAsyncSends, fixture } from "@/test-utils/pipeline";

// GOLDEN WIRE-FORMAT SUITE — characterization tests for the exact payload the backend ingests
// at {dsn}/json/rum: endpoint, headers, batch envelope, sessionAttributes and per-event
// enrichment. A failure here means the wire format changed, which is a backend-visible
// regression rather than a test to update casually.
//
// What every SDK shares has two parts. The requests: each file in packages/core/wire
// is the one request a call sends, exactly, and "shared wire fixtures" below checks this SDK
// sends it. The behaviour: the presence gate, sampling, session identity and rotation ordering,
// as plain tests every SDK's golden repeats (the fixtures' README lists them). What only the
// browser sends — userAgent/browser, location, dom.event, gzip, the DOM-node guard, the
// retained-backlog flow — stays inline too.

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const TRACE_ID = /^0{16}[0-9a-f]{16}$/;

// The clock the fixture files were sent on (2027-01-15T08:00:00Z), so their times are exact.
const FIXTURE_CLOCK_MS = 1_800_000_000_000;

const without = (object: object, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

type FetchCall = { url: string; headers: Record<string, string>; body: Uint8Array };

function recordedCalls(fetchMock: ReturnType<typeof vi.fn>): FetchCall[] {
  return fetchMock.mock.calls.map((call) => {
    const [url, init] = call as [string, { headers: Record<string, string>; body: Uint8Array }];
    return { url, headers: init.headers, body: init.body };
  });
}

function decodeBody(call: FetchCall): Batch {
  const bytes =
    call.headers["Content-Encoding"] === "gzip" ? gunzipSync(call.body) : call.body;
  return JSON.parse(strFromU8(bytes)) as Batch;
}

function allSentEvents(fetchMock: ReturnType<typeof vi.fn>): BaseEvent[] {
  return recordedCalls(fetchMock).flatMap((call) => decodeBody(call).events);
}

function simulatePresence(): void {
  // pointerdown is a raw-input presence signal (UserPresenceMonitor) that no
  // event listener turns into an SDK event — presence only, no dom.event.
  window.dispatchEvent(new Event("pointerdown"));
}

// The tab is hidden: the SDK's lifecycle flush. showPage undoes it. The event bubbles, as the
// browser's does: the SDK listens on window.
function hidePage(): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}

function showPage(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
}

describe("wire-format golden contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let manager: SessionManager | null = null;

  beforeEach(() => {
    sessionStorage.clear();
    // Force the inline (non-worker) encode path so the payload bytes are
    // produced deterministically in this environment.
    vi.stubGlobal("Worker", undefined);
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  function initSDK(config: SDKConfigInput = BASE_CONFIG): SessionManager {
    manager = new SessionManager(config);
    return manager;
  }

  // The core envelope keys and their values are pinned by the shared wire fixtures. This adds
  // the browser's own: the EXACT key set (core + userAgent + browser, so an extra key anywhere is
  // caught), and the device metadata core leaves unnamed but the browser SDK must always send.
  it("adds userAgent + browser to the core envelope, and nothing else", async () => {
    const sdk = initSDK();
    simulatePresence();

    sdk.sendCustomEvent({ event: "envelope-probe", attributes: {} });
    await drainAsyncSends();

    expect(fetchMock).toHaveBeenCalled();
    const attrs = decodeBody(recordedCalls(fetchMock)[0]!).sessionAttributes as BrowserSessionAttributes;
    expect(Object.keys(attrs).sort()).toEqual(
      [
        "browser",
        "cluster",
        "env",
        "namespace",
        "releaseId",
        "service.name",
        "session_id",
        "session_start_time",
        "user",
        "userAgent",
      ].sort()
    );
    expect(typeof attrs.userAgent).toBe("string");
    expect(attrs.userAgent.length).toBeGreaterThan(0);
    expect(Object.keys(attrs.browser).sort()).toEqual([
      "language",
      "mobile",
      "name",
      "platform",
      "version",
    ]);
  });

  it("stamps location on every event, as a nested (unflattened) object", async () => {
    const sdk = initSDK();
    simulatePresence();

    sdk.sendCustomEvent({ event: "enrichment-probe", attributes: {} });
    await drainAsyncSends();

    const event = allSentEvents(fetchMock).find((e) => e.type === "custom")!;
    expect(event).toBeDefined();
    expect(event.attributes?.location).toEqual({
      path: expect.any(String),
      url: expect.any(String),
      title: expect.any(String),
    });
  });

  it("ships a click as a dom.event riding along with the next flushing event", async () => {
    const sdk = initSDK();
    simulatePresence();

    // dom.event is in EVENTS_TO_SKIP_FLUSH, so it rides along with the next flushing event.
    const button = document.createElement("button");
    button.textContent = "Buy";
    document.body.appendChild(button);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    sdk.sendCustomEvent({ event: "flush", attributes: {} });
    await drainAsyncSends();

    const dom = allSentEvents(fetchMock).find((e) => e.type === "dom.event")!;
    expect(dom.attributes?.dom_event_type).toBe("click");
    expect(dom.attributes?.["dom_event_target.tagName"]).toBe("BUTTON");
  });

  it("never walks a DOM node passed as an attribute (enrichment or redaction)", async () => {
    const sdk = initSDK();
    simulatePresence();

    const element = document.createElement("div");
    sdk.sendCustomEvent({ event: "node-probe", attributes: { el: element } });
    sdk.emitLog("node log", "info", { el: element });
    await drainAsyncSends();

    const events = allSentEvents(fetchMock);
    const custom = events.find((e) => e.type === "custom")!;
    // Enrichment: a placeholder at the node's key, and no flattened node fields.
    expect(custom.attributes?.["custom_event_attributes.el"]).toBe("[HTMLDivElement]");
    expect(Object.keys(custom.attributes ?? {}).filter((k) => k.startsWith("custom_event_attributes.el.")))
      .toEqual([]);
    // Log masking is on by default, so the node meets redaction first.
    const log = events.find((e) => e.type === "log")!;
    expect(log.attributes?.el).toBe("[REDACTED]");
  });

  it("gzips the payload and sets Content-Encoding when compression is on", async () => {
    const sdk = initSDK();
    // Runtime config update path — merges transport options.
    sdk.updateConfig({ options: { transport: { compression: true } } });
    simulatePresence();

    sdk.sendCustomEvent({ event: "compressed-probe", attributes: {} });
    await drainAsyncSends();

    expect(fetchMock).toHaveBeenCalled();
    const call = recordedCalls(fetchMock)[0]!;
    expect(call.headers["Content-Encoding"]).toBe("gzip");

    // Body must gunzip back to the same envelope.
    const batch = decodeBody(call);
    expect(Object.keys(batch).sort()).toEqual(["events", "sessionAttributes"]);
    const names = batch.events.map((e) => e.attributes?.custom_event_name);
    expect(names).toContain("compressed-probe");
  });

  // The core unit test for the retained-buffer candidate INJECTS the pool
  // timestamp, which proves the resolver's selection but not the flow. This
  // drives the real thing end to end — start with no cluster so flush()
  // retains, rotate while a retained event is inside the trust window, supply
  // the cluster via updateConfig, then inspect the successor's wire envelope.
  //
  // It is written to fail if ANY of these three regress:
  // retention (the held event is lost), attribution (which id it ships under),
  // or ordering against the candidate the resolver actually selected.
  it("ships a retained no-cluster backlog under the successor, ordered against the in-window candidate", async () => {
    const SESSION_MAX_DURATION_MS = 60_000;
    const base = Date.now();
    let clock = base;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      const sdk = initSDK({
        ...BASE_CONFIG,
        cluster: "",
        options: { ...BASE_CONFIG.options, sessionMaxDuration: SESSION_MAX_DURATION_MS },
      });
      simulatePresence();
      const sessionIdBefore = sdk.getSessionId();
      expect(sessionIdBefore).toBeTruthy();

      // Enqueued 2s before the cap, so it is still inside the trust window when
      // the rotation happens (here the window is the 60s cap, not the 30min idle
      // one). No cluster => flush() returns without draining.
      const retainedNs = msToNs(base + SESSION_MAX_DURATION_MS - 2_000);
      clock = base + SESSION_MAX_DURATION_MS - 2_000;
      sdk.sendCustomEvent({ event: "retained", attributes: {} });
      await drainAsyncSends();
      expect(fetchMock, "nothing ships while cluster is unset").not.toHaveBeenCalled();

      // Past the cap: this event rotates, and the rotation's own flush retains
      // again — so the backlog crosses the id boundary.
      clock = base + SESSION_MAX_DURATION_MS + 1_000;
      sdk.sendCustomEvent({ event: "trigger", attributes: {} });
      await drainAsyncSends();

      const sessionIdAfter = sdk.getSessionId();
      expect(sessionIdAfter, "the cap should have rotated the session").not.toBe(sessionIdBefore);

      // Cluster arrives; confirm the successor and let the backlog drain.
      sdk.updateConfig({ cluster: "golden-cluster" });
      simulatePresence();
      sdk.sendCustomEvent({ event: "post-cluster", attributes: {} });
      await drainAsyncSends();

      const batches = recordedCalls(fetchMock).map(decodeBody);
      expect(batches.length, "the backlog ships once the cluster arrives").toBeGreaterThan(0);

      // 1. RETENTION: nothing held across the rotation was dropped.
      const names = batches
        .flatMap((b) => b.events)
        .map((e) => e.attributes?.custom_event_name)
        .filter(Boolean);
      expect(names).toContain("retained");
      expect(names).toContain("trigger");

      // 2. ATTRIBUTION: the pre-rotation backlog ships under the SUCCESSOR id.
      // This is a known limitation (docs/session-lifecycle.md §7) — events
      // carry no session id of their own, so a retained backlog inherits the
      // current session at send time. Pinned here so a change to it is deliberate.
      const carryingRetained = batches.find((b) =>
        b.events.some((e) => e.attributes?.custom_event_name === "retained")
      );
      expect(carryingRetained).toBeDefined();
      expect(carryingRetained!.sessionAttributes.session_id).toBe(sessionIdAfter);

      // 3. ORDERING against the candidate the resolver actually selected. The
      // retained event was inside the trust window, so the rotation must have
      // backdated the successor's start to exactly it — proving the pool-candidate
      // path ran for real rather than being injected by a fake.
      expect(carryingRetained!.sessionAttributes.session_start_time).toBe(retainedNs);

      // 4. KNOWN LIMITATION, pinned deliberately rather than left to chance.
      //
      // The batch also carries the `pageload` from session birth, which by the
      // time the cap is crossed is OLDER than the trust window — so it was never
      // a candidate, and the successor's start postdates it. That is the
      // documented trade-off: widening the window to cover it would let a
      // rotation adopt a start old enough to make the new session stale at birth,
      // and the next interaction would then discard this very buffer.
      //
      // If this expectation ever flips, update docs/session-lifecycle.md and the
      // changelog with it.
      const pageload = carryingRetained!.events.find((e) => e.type === "pageload");
      expect(pageload, "the birth pageload rides along in the backlog").toBeDefined();
      expect(
        carryingRetained!.sessionAttributes.session_start_time >
          (pageload!.timestamp ?? Number.POSITIVE_INFINITY),
        "KNOWN LIMITATION: successor start postdates the birth pageload it carries"
      ).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not transmit anything before genuine user presence (ghost-session gate)", async () => {
    const sdk = initSDK();

    sdk.sendCustomEvent({ event: "pre-presence", attributes: {} });
    await drainAsyncSends();

    expect(fetchMock).not.toHaveBeenCalled();

    // Presence opens the gate; the next flush drains the held buffer.
    simulatePresence();
    sdk.sendCustomEvent({ event: "post-presence", attributes: {} });
    await drainAsyncSends();

    expect(fetchMock).toHaveBeenCalled();
    const names = allSentEvents(fetchMock)
      .filter((e) => e.type === "custom")
      .map((e) => e.attributes?.custom_event_name);
    expect(names).toContain("pre-presence");
    expect(names).toContain("post-presence");
  });

  it("sends a session that caught an exception when the app is hidden, before presence", async () => {
    const sdk = initSDK();

    sdk.sendCustomEvent({ event: "pre-presence", attributes: {} });
    sdk.captureException(new Error("load failed"));
    await drainAsyncSends();
    // Still gated while the app is in use.
    expect(fetchMock).not.toHaveBeenCalled();

    try {
      hidePage();
      await drainAsyncSends();

      // One request: the exception and everything held before it.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const events = allSentEvents(fetchMock);
      expect(events.some((e) => e.type === "exception")).toBe(true);
      expect(
        events.some((e) => e.type === "custom" && e.attributes?.custom_event_name === "pre-presence")
      ).toBe(true);
    } finally {
      showPage();
    }
  });

  it("does not send a session without an exception when the app is hidden, before presence", async () => {
    const sdk = initSDK();

    sdk.sendCustomEvent({ event: "pre-presence", attributes: {} });
    try {
      hidePage();
      await drainAsyncSends();

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      showPage();
    }
  });

  it("does not send a session a rotation started when the app is hidden, before presence", async () => {
    const SESSION_MAX_DURATION_MS = 60_000;
    const base = Date.now();
    let clock = base;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      const sdk = initSDK({
        ...BASE_CONFIG,
        options: { ...BASE_CONFIG.options, sessionMaxDuration: SESSION_MAX_DURATION_MS },
      });
      const firstSessionId = sdk.getSessionId();

      // Nobody touches the app. Past the cap, background traffic rotates the session, and the
      // new one catches an exception.
      clock = base + SESSION_MAX_DURATION_MS + 1_000;
      sdk.sendCustomEvent({ event: "background", attributes: {} });
      sdk.captureException(new Error("poll failed"));
      await drainAsyncSends();
      expect(sdk.getSessionId()).not.toBe(firstSessionId);

      hidePage();
      await drainAsyncSends();

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      showPage();
      nowSpy.mockRestore();
    }
  });

  it("sends nothing when sessionSampleRate is 0", async () => {
    const sdk = initSDK({
      ...BASE_CONFIG,
      options: { ...BASE_CONFIG.options, sessionSampleRate: 0 },
    });
    simulatePresence();
    sdk.sendCustomEvent({ event: "sampled-out", attributes: {} });
    await drainAsyncSends();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps session identity stable across flushes within a session", async () => {
    const sdk = initSDK();
    simulatePresence();

    sdk.sendCustomEvent({ event: "first", attributes: {} });
    await drainAsyncSends();
    sdk.sendCustomEvent({ event: "second", attributes: {} });
    await drainAsyncSends();

    const calls = recordedCalls(fetchMock);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const ids = calls.map((c) => decodeBody(c).sessionAttributes.session_id);
    expect(new Set(ids).size).toBe(1);
    expect(sdk.getSessionId()).toBe(ids[0]);
  });

  // The downstream contract, not an implementation detail: consumers derive
  // session duration from (last event - session_start_time), so an envelope
  // claiming a start LATER than an event it carries yields a negative duration.
  // Deliberately scenario-independent — it walks whatever this suite already
  // sent, so it keeps holding as scenarios grow.
  it("never claims a session started after an event in the same batch", async () => {
    const sdk = initSDK();
    simulatePresence();

    sdk.sendCustomEvent({ event: "first", attributes: {} });
    await drainAsyncSends();
    sdk.sendCustomEvent({ event: "second", attributes: {} });
    await drainAsyncSends();

    const calls = recordedCalls(fetchMock);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    for (const call of calls) {
      const { sessionAttributes, events } = decodeBody(call);
      // network events carry start_timestamp instead of timestamp.
      const times = events
        .map((event) => event.timestamp ?? event.start_timestamp)
        .filter((time): time is number => typeof time === "number");
      expect(times.length).toBeGreaterThan(0);
      expect(sessionAttributes.session_start_time).toBeLessThanOrEqual(Math.min(...times));
    }
  });

  // The test above holds trivially in a fresh session, because bootstrap stamps
  // the start before any event exists. This one crosses the max-duration cap so
  // a real ROTATION mints the start, which is where an inversion can arise —
  // and it forces the interleave that would invert it.
  //
  // The clock is a Date.now spy (not fake timers, which the async encode path
  // needs). `beforeSend` runs inside addEvent BEFORE the rotation hook, so
  // advancing the clock there reproduces real work in between: the enricher
  // stamps the event from one reading, the rotation stamps the session from a
  // later one.
  it("never claims a rotated session started after the event that triggered it", async () => {
    const SESSION_MAX_DURATION_MS = 60_000;
    const base = Date.now();
    let clock = base;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      let advanceOnSend = false;
      const sdk = initSDK({
        ...BASE_CONFIG,
        options: {
          ...BASE_CONFIG.options,
          sessionMaxDuration: SESSION_MAX_DURATION_MS,
          // The interleave: real elapsed time between the enricher's stamp and
          // the rotation's stamp.
          beforeSend: () => {
            if (advanceOnSend) clock += 5;
            return true;
          },
        },
      });
      simulatePresence();

      sdk.sendCustomEvent({ event: "before-cap", attributes: {} });
      await drainAsyncSends();
      const sessionIdBefore = recordedCalls(fetchMock)
        .map((c) => decodeBody(c).sessionAttributes.session_id)
        .at(-1);
      expect(sessionIdBefore).toBeTruthy();

      // Past the cap. Rotation is lazy — the next event triggers it.
      clock = base + SESSION_MAX_DURATION_MS + 1_000;
      advanceOnSend = true;
      sdk.sendCustomEvent({ event: "after-cap", attributes: {} });
      advanceOnSend = false;
      await drainAsyncSends();

      // The rotation reset the activity clock, so the new session is born
      // unconfirmed and the ghost-session gate holds its batch. Confirm it, then
      // give the pool a reason to drain.
      simulatePresence();
      sdk.sendCustomEvent({ event: "post-rotation", attributes: {} });
      await drainAsyncSends();

      const rotated = recordedCalls(fetchMock)
        .map(decodeBody)
        .filter((b) => b.sessionAttributes.session_id !== sessionIdBefore);
      expect(rotated.length, "the cap should have rotated the session").toBeGreaterThan(0);

      for (const { sessionAttributes, events } of rotated) {
        const times = events
          .map((event) => event.timestamp ?? event.start_timestamp)
          .filter((time): time is number => typeof time === "number");
        expect(times.length).toBeGreaterThan(0);
        expect(
          sessionAttributes.session_start_time,
          "the rotated session started after an event it carries"
        ).toBeLessThanOrEqual(Math.min(...times));
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  // It is enrichEvent's RESULT that enters the buffer, so the resolver must read
  // the triggering event AFTER the public `enrichEvent` hook runs. Otherwise a
  // hook that moves the timestamp earlier — a supported transformation — would
  // defeat the ordering guarantee above.
  it("never claims a rotated session started after an enrichEvent-backdated trigger", async () => {
    const SESSION_MAX_DURATION_MS = 60_000;
    const base = Date.now();
    let clock = base;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      let backdate = false;
      const sdk = initSDK({
        ...BASE_CONFIG,
        options: {
          ...BASE_CONFIG.options,
          sessionMaxDuration: SESSION_MAX_DURATION_MS,
          enrichEvent: ((event: BaseEvent) => {
            if (!backdate || typeof event.timestamp !== "number") return event;
            return { ...event, timestamp: event.timestamp - 5 * 1_000_000 };
          }) as unknown as NonNullable<SDKConfigInput["options"]>["enrichEvent"],
        },
      });
      simulatePresence();

      sdk.sendCustomEvent({ event: "before-cap", attributes: {} });
      await drainAsyncSends();
      const sessionIdBefore = recordedCalls(fetchMock)
        .map((c) => decodeBody(c).sessionAttributes.session_id)
        .at(-1);
      expect(sessionIdBefore).toBeTruthy();

      // Past the cap. The next event rotates, and enrichEvent moves ITS
      // timestamp 5ms earlier than the value the resolver saw.
      clock = base + SESSION_MAX_DURATION_MS + 1_000;
      backdate = true;
      sdk.sendCustomEvent({ event: "after-cap", attributes: {} });
      backdate = false;
      await drainAsyncSends();

      // The rotation reset the activity clock; confirm the successor and drain.
      simulatePresence();
      sdk.sendCustomEvent({ event: "post-rotation", attributes: {} });
      await drainAsyncSends();

      const rotated = recordedCalls(fetchMock)
        .map(decodeBody)
        .filter((b) => b.sessionAttributes.session_id !== sessionIdBefore);
      expect(rotated.length, "the cap should have rotated the session").toBeGreaterThan(0);

      for (const { sessionAttributes, events } of rotated) {
        const times = events
          .map((event) => event.timestamp ?? event.start_timestamp)
          .filter((time): time is number => typeof time === "number");
        expect(times.length).toBeGreaterThan(0);
        expect(
          sessionAttributes.session_start_time,
          "the rotated session started after an enriched event it carries"
        ).toBeLessThanOrEqual(Math.min(...times));
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  // The shared requests. Each file in packages/core/wire is what one call sends after
  // presence, on the fixture clock.
  describe("shared wire fixtures", () => {
    // The request as the file holds it: without the random ids (their format is checked here
    // instead), what only the browser sends, and the stack trace, whose frames are the platform's.
    function sharedRequest(call: FetchCall): unknown {
      const batch = decodeBody(call);
      expect(batch.sessionAttributes.session_id).toMatch(HEX_32);
      const events = batch.events
        .filter((event) => event.type !== "pageload")
        .map((event) => {
          expect(event.id).toMatch(HEX_32);
          expect(event.spanId).toMatch(HEX_16);
          expect(event.traceId).toMatch(TRACE_ID);
          const attributes = without(event.attributes ?? {}, ["location", "error_stacktrace"]);
          return { ...without(event, ["id", "spanId", "traceId"]), attributes };
        });
      const sessionAttributes = without(batch.sessionAttributes, ["session_id", "browser", "userAgent"]);
      return { url: call.url, headers: call.headers, body: { ...batch, sessionAttributes, events } };
    }

    async function onlyRequest(send: (sdk: SessionManager) => void): Promise<unknown> {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXTURE_CLOCK_MS);
      try {
        const sdk = initSDK();
        simulatePresence();
        send(sdk);
        await drainAsyncSends();
      } finally {
        nowSpy.mockRestore();
      }
      const calls = recordedCalls(fetchMock);
      expect(calls).toHaveLength(1);
      return sharedRequest(calls[0]!);
    }

    it("custom-event.json", async () => {
      const sent = await onlyRequest((sdk) =>
        sdk.sendCustomEvent({ event: "purchase", attributes: { amount: 42, nested: { sku: "abc" } } })
      );
      expect(sent).toEqual(fixture("custom-event.json"));
    });

    it("log-event.json", async () => {
      const sent = await onlyRequest((sdk) => sdk.emitLog("golden log line", "warn", { context: "checkout" }));
      expect(sent).toEqual(fixture("log-event.json"));
    });

    it("exception-event.json", async () => {
      const sent = await onlyRequest((sdk) => sdk.captureException(new Error("golden failure"), { stage: "test" }));
      expect(sent).toEqual(fixture("exception-event.json"));
    });

    it("exception-repeat-event.json", async () => {
      // batchSize 10, so the three calls share one batch.
      const batched = {
        ...BASE_CONFIG,
        options: { ...BASE_CONFIG.options, transport: { ...BASE_CONFIG.options?.transport, batchSize: 10 } },
      } as SDKConfigInput;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXTURE_CLOCK_MS);
      try {
        const sdk = initSDK(batched);
        simulatePresence();
        // One call site, so all three are the same error.
        for (const offsetMs of [0, 1_000, 2_000]) {
          nowSpy.mockReturnValue(FIXTURE_CLOCK_MS + offsetMs);
          sdk.captureException(new Error("golden failure"), { stage: "test" });
        }
        hidePage();
        await drainAsyncSends();
      } finally {
        nowSpy.mockRestore();
        showPage();
      }
      const calls = recordedCalls(fetchMock);
      expect(calls).toHaveLength(1);
      expect(sharedRequest(calls[0]!)).toEqual(fixture("exception-repeat-event.json"));
    });
  });
});
