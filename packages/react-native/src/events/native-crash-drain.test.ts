import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";
import {
  ConfigManager,
  msToNs,
  RandomIdGenerator,
  type Batch,
  type SDKConfigInput,
} from "@groundcover/rum-core";

import { __resetDrainStateForTest, drainNativeCrashReports } from "./native-crash-drain";
import type { GroundcoverNativeModule, PendingCrashRecord } from "../platform/native-types";

// The crashed session — deliberately different from anything a live session
// would produce, so a batch stamped with the wrong envelope is unmistakable.
const CRASHED_SESSION = {
  session_id: "crashed-session-id",
  session_start_time: 1_700_000_000_000_000_000,
  source: "mobile-rum",
  cluster: "c",
  env: "e",
  user: { id: "user-7" },
  "service.name": "a",
  screen: { name: "Checkout", key: "Checkout-1" },
};

const CRASH_EPOCH_MS = 1_700_000_123_456;

function record(overrides: Partial<PendingCrashRecord> = {}): PendingCrashRecord {
  return {
    id: "crash-1",
    crashEpochMs: CRASH_EPOCH_MS,
    errorType: "SIGSEGV",
    errorMessage: "Attempted to dereference garbage pointer",
    stacktrace: [{ filename: "AcmeShop", function: "0x104a3f1c8", lineno: 0, colno: 0 }],
    metadata: { signal: "SIGSEGV", crashed_thread: 0 },
    sessionSnapshotJson: JSON.stringify(CRASHED_SESSION),
    screen: { name: "Checkout", key: "Checkout-1" },
    ...overrides,
  };
}

function nativeStub(records: PendingCrashRecord[]): GroundcoverNativeModule {
  return {
    nativeInit: vi.fn().mockResolvedValue("{}"),
    updateSessionSnapshot: vi.fn(),
    getPendingCrashReports: vi.fn().mockResolvedValue(JSON.stringify(records)),
    clearPendingCrashReports: vi.fn().mockResolvedValue(undefined),
    flushFrameSegment: vi.fn().mockResolvedValue("null"),
    stop: vi.fn(),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  };
}

function configManager(options: Record<string, unknown> = {}): ConfigManager {
  const config = new ConfigManager();
  config.initialize({
    dsn: "ingest.example",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
    options: { transport: { compression: false }, ...options },
  } as SDKConfigInput);
  return config;
}

function sentBatches(fetchMock: ReturnType<typeof vi.fn>): Batch[] {
  return fetchMock.mock.calls.map((call) => {
    const [, init] = call as [string, { headers: Record<string, string>; body: Uint8Array }];
    const bytes = init.headers["Content-Encoding"] === "gzip" ? gunzipSync(init.body) : init.body;
    return JSON.parse(strFromU8(bytes)) as Batch;
  });
}

function drain(native: GroundcoverNativeModule, config = configManager()) {
  return drainNativeCrashReports({
    config,
    idGenerator: new RandomIdGenerator(),
    native,
  });
}

describe("drainNativeCrashReports", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetDrainStateForTest();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the crash under the CRASHED session's envelope, not the current one", async () => {
    const native = nativeStub([record()]);

    await drain(native);

    const [batch] = sentBatches(fetchMock);
    expect(batch!.sessionAttributes.session_id).toBe("crashed-session-id");
    expect(batch!.sessionAttributes.user).toEqual({ id: "user-7" });
    // `screen` belongs on the event, not the envelope.
    expect(batch!.sessionAttributes.screen).toBeUndefined();
  });

  it("timestamps the event at crash time, not drain time", async () => {
    const native = nativeStub([record()]);

    await drain(native);

    const [batch] = sentBatches(fetchMock);
    expect(batch!.events[0]!.timestamp).toBe(msToNs(CRASH_EPOCH_MS));
  });

  it("builds the exception attributes JS errors use, plus the native markers", async () => {
    const native = nativeStub([record()]);

    await drain(native);

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["error_type"]).toBe("SIGSEGV");
    expect(attrs["error_handled"]).toBe(false);
    expect(attrs["error_fingerprint"]).toBe(
      "SIGSEGV:Attempted to dereference garbage pointer"
    );
    expect(attrs["error_metadata.native"]).toBe(true);
    expect(attrs["error_metadata.fatal"]).toBe(true);
    expect(attrs["error_metadata.signal"]).toBe("SIGSEGV");
    // Stable across at-least-once redeliveries, so a duplicate can be recognised.
    expect(attrs["error_metadata.crash_report_id"]).toBe("crash-1");
    // The crash-time screen, nested like every other event's screen stamp.
    expect(attrs["screen"]).toEqual({ name: "Checkout", key: "Checkout-1" });
  });

  // The other half of the bridge's empty-sentinel drop: native writes `screen`
  // unconditionally, so when its own extraction failed the record carries `{name:"",key:""}`
  // and JS must fall back to the screen it lifts from the same snapshot itself.
  it("falls back to the snapshot's screen when native could not read one", async () => {
    const native = nativeStub([record({ screen: { name: "", key: "" } })]);

    await drain(native);

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["screen"]).toEqual(CRASHED_SESSION.screen);
  });

  // Crash messages routinely carry request context — an NSException raised out
  // of a failed API call, a Kotlin exception whose message embeds the URL it was
  // fetching. The JS error listener redacts that (errors-events-listener.ts
  // buildEvent, via privacy.shouldMaskErrors, which defaults ON). A native fatal
  // must not be the one path that ships it in the clear.
  it("redacts sensitive text in the crash message, like the JS error path", async () => {
    const native = nativeStub([
      record({
        errorMessage: "NSInvalidArgumentException while POSTing /v1/pay, Authorization: Bearer eyJhbGciOi9",
      }),
    ]);

    await drain(native);

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["error_message"]).not.toContain("eyJhbGciOi9");
    // The fingerprint is derived from the message, so it must not leak it either.
    expect(String(attrs["error_fingerprint"])).not.toContain("eyJhbGciOi9");
  });

  // redactObject is key-based (see core redactValueAt): a sensitively-NAMED key
  // has its value replaced. Same contract the JS path gets for captureException
  // metadata — free-text scanning of non-sensitive HOST keys is not part of it on
  // either path. The one exception is `causes[].message`, which the SDK's own
  // mapper writes from exception text; see the next test.
  it("redacts sensitively-named keys in native crash metadata", async () => {
    const native = nativeStub([
      record({ metadata: { signal: "SIGABRT", authorization: "Bearer eyJsecret" } }),
    ]);

    await drain(native);

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(String(attrs["error_metadata.authorization"])).not.toContain("eyJsecret");
    // Non-sensitive diagnostic keys must survive, or the crash loses its context.
    expect(attrs["error_metadata.signal"]).toBe("SIGABRT");
    // SDK-owned markers are never at the mercy of the key heuristic — the dedupe
    // key in particular must survive redelivery.
    expect(attrs["error_metadata.crash_report_id"]).toBe("crash-1");
  });

  // The ONE exception to the key-based contract above, and it is ours: the Android
  // mapper copies each `caused by` message into `metadata.causes[].message`
  // (GcRumCrashRecordMapper.buildMetadata) — exception free text, under a key no
  // heuristic calls sensitive. Unscanned, the same string that gets scrubbed as
  // `error_message` would ship in the clear one level down. Scanned as text because the
  // SDK is what put it there, not the host.
  it("redacts sensitive text inside the native cause chain", async () => {
    const native = nativeStub([
      record({
        metadata: {
          crash_source: "uncaught",
          causes: [
            {
              type: "java.io.IOException",
              message: "GET https://api/pay failed, Authorization: Bearer eyJsecret",
            },
          ],
        },
      }),
    ]);

    await drain(native);

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    const causes = attrs["error_metadata.causes"] as Array<Record<string, unknown>> | undefined;
    const cause = causes?.[0] ?? {};
    const message = cause["error_metadata.causes[0].message"];
    // The enricher flattens nested keys, so this test asserts on the WIRE key. Without
    // this guard a moved key makes `message` undefined and the scrub assertion below
    // passes against nothing.
    expect(typeof message).toBe("string");
    expect(message as string).not.toContain("eyJsecret");
    // The cause chain is where the real failure is described — scrubbing must not
    // blank the whole field, and the type is what makes the message readable.
    expect(cause["error_metadata.causes[0].type"]).toBe("java.io.IOException");
    // Nothing may leak anywhere else in the event either (fingerprint, a stray copy).
    expect(JSON.stringify(attrs)).not.toContain("eyJsecret");
  });

  it("leaves the crash message alone when privacy level is allow", async () => {
    const native = nativeStub([record({ errorMessage: "token=keep-me-verbatim" })]);

    await drain(native, configManager({ privacy: { level: "allow" } }));

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["error_message"]).toBe("token=keep-me-verbatim");
  });

  it("acks the record only after the POST succeeds", async () => {
    const native = nativeStub([record()]);

    await drain(native);

    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["crash-1"]);
  });

  it("does NOT ack on a network failure — the report retries next launch", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const native = nativeStub([record()]);

    await drain(native);

    expect(fetchMock).toHaveBeenCalled();
    expect(native.clearPendingCrashReports).not.toHaveBeenCalled();
  });

  it("does NOT ack on a non-2xx response", async () => {
    // The transporter treats any resolved fetch as sent; a 500 dropped the data,
    // so acking here would lose the report.
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const native = nativeStub([record()]);

    await drain(native);

    expect(native.clearPendingCrashReports).not.toHaveBeenCalled();
  });

  it("settles without hanging when the API key is missing", async () => {
    // Transporter.send returns WITHOUT invoking sendBatch here, so the delivery
    // promise never resolves on its own — the deadline has to rescue the drain.
    vi.useFakeTimers();
    try {
      const config = new ConfigManager();
      config.initialize({
        dsn: "ingest.example",
        apiKey: "",
        cluster: "c",
        environment: "e",
        appId: "a",
      } as SDKConfigInput);
      const native = nativeStub([record()]);

      const pending = drain(native, config);
      await vi.advanceTimersByTimeAsync(40_000);
      await pending;

      expect(fetchMock).not.toHaveBeenCalled();
      expect(native.clearPendingCrashReports).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no delivery-deadline timer queued once a report lands", async () => {
    // The 35s deadline only rescues a send that never reports its verdict; when delivery
    // wins the race it must be cleared, or a sequential drain strands one live callback per
    // record through teardown and re-init.
    vi.useFakeTimers();
    try {
      const native = nativeStub([record()]);

      await drain(native);

      // Delivery resolved on a microtask; nothing should still be waiting on the clock.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies beforeSend, and acks a dropped report so it does not retry forever", async () => {
    const native = nativeStub([record()]);

    await drain(native, configManager({ beforeSend: () => false }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["crash-1"]);
  });

  // A THROWING callback, as opposed to one that returns false. The same hazard as the `false`
  // return — "Ack anyway — leaving it would retry forever": a throw that propagated out of
  // `reportOne` would be logged by `runDrain` and leave the record un-acked, retried on every
  // launch, forever, because the callback keeps throwing. Worse than a slow leak: the pending
  // directory is capped at 10 records, so a permanently stuck one crowds out later crashes.
  //
  // Acking matches what the live path does — `EventsPool` contains a throwing `beforeSend` and
  // drops that event (the playground's `callbacks-throw` preset exists for exactly that) — so a
  // host with a broken callback loses the report either way. The choice here is between losing it
  // once and losing it plus every crash that follows.
  it("acks a record whose beforeSend throws, instead of retrying it forever", async () => {
    const native = nativeStub([record()]);

    await drain(
      native,
      configManager({
        beforeSend: () => {
          throw new Error("host beforeSend is broken");
        },
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["crash-1"]);
  });

  // enrichEvent is the recoverable one: the event is already built and valid, so a broken
  // enricher costs its added attributes, not the crash report.
  it("still delivers the report when enrichEvent throws", async () => {
    const native = nativeStub([record()]);

    await drain(
      native,
      configManager({
        enrichEvent: () => {
          throw new Error("host enrichEvent is broken");
        },
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["crash-1"]);
  });

  // The hook gets a copy, so one that changes the event and then throws leaves no trace. This
  // report is acked once sent, so what ships is the only copy kept.
  it("sends the report exactly as built when enrichEvent changes it and then throws", async () => {
    const native = nativeStub([record()]);

    await drain(
      native,
      configManager({
        enrichEvent: (event: { timestamp: number; attributes: Record<string, unknown> }) => {
          event.timestamp = 1;
          event.attributes["error_message"] = "rewritten by the hook";
          delete (event.attributes["error_metadata"] as Record<string, unknown>)["crash_report_id"];
          throw new Error("host enrichEvent broke halfway");
        },
      })
    );

    const event = sentBatches(fetchMock)[0]!.events[0]! as Record<string, unknown>;
    expect(event["timestamp"]).toBe(msToNs(CRASH_EPOCH_MS));
    const attrs = event["attributes"] as Record<string, unknown>;
    expect(attrs["error_message"]).not.toBe("rewritten by the hook");
    expect(attrs["error_metadata.crash_report_id"]).toBe("crash-1");
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["crash-1"]);
  });

  it("applies enrichEvent", async () => {
    const native = nativeStub([record()]);
    const enrichEvent = (event: { attributes: Record<string, unknown> }) => ({
      ...event,
      attributes: { ...event.attributes, tenant: "acme" },
    });

    await drain(native, configManager({ enrichEvent }));

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["tenant"]).toBe("acme");
  });

  // A host `enrichEvent` that returns a malformed object must not put it on the wire.
  // The pool validates its result and drops; this path cannot drop (a fatal is the most
  // valuable event the SDK sends) so it falls back to the built event instead.
  it("ignores an enrichEvent result that is not a usable event", async () => {
    const native = nativeStub([record()]);

    await drain(native, configManager({ enrichEvent: () => ({}) }));

    const [batch] = sentBatches(fetchMock);
    const event = batch!.events[0]! as Record<string, unknown>;
    expect(event["type"]).toBe("exception");
    expect(event["timestamp"]).toBe(msToNs(CRASH_EPOCH_MS));
    const attrs = event["attributes"] as Record<string, unknown>;
    expect(attrs["error_type"]).toBe("SIGSEGV");
  });

  it("keeps the built event when enrichEvent returns undefined", async () => {
    const native = nativeStub([record()]);

    await drain(native, configManager({ enrichEvent: () => undefined }));

    const [batch] = sentBatches(fetchMock);
    const event = batch!.events[0]! as Record<string, unknown>;
    expect(event["type"]).toBe("exception");
    expect((event["attributes"] as Record<string, unknown>)["error_type"]).toBe("SIGSEGV");
  });

  it("drops and acks a record whose snapshot is missing or corrupt", async () => {
    // Sending under the CURRENT session would corrupt an unrelated session with
    // another one's fatal — worse than losing the report.
    const native = nativeStub([
      record({ id: "no-snapshot", sessionSnapshotJson: null }),
      record({ id: "corrupt", sessionSnapshotJson: "{not json" }),
      record({ id: "no-session-id", sessionSnapshotJson: '{"source":"mobile-rum"}' }),
    ]);

    await drain(native);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["no-snapshot"]);
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["corrupt"]);
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["no-session-id"]);
  });

  it("survives a malformed record without dropping the healthy ones", async () => {
    const native = nativeStub([
      { id: "broken", crashEpochMs: Number.NaN } as unknown as PendingCrashRecord,
      record({ id: "healthy" }),
    ]);

    await drain(native);

    // The broken record has no snapshot → acked and dropped; the healthy one
    // still ships.
    expect(sentBatches(fetchMock)).toHaveLength(1);
    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["healthy"]);
  });

  it("sends one batch per record, each under its own session", async () => {
    const other = { ...CRASHED_SESSION, session_id: "other-session" };
    const native = nativeStub([
      record({ id: "a" }),
      record({ id: "b", sessionSnapshotJson: JSON.stringify(other) }),
    ]);

    await drain(native);

    const batches = sentBatches(fetchMock);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.sessionAttributes.session_id)).toEqual([
      "crashed-session-id",
      "other-session",
    ]);
  });

  it("runs one drain per runtime — a concurrent re-init cannot double-send", async () => {
    const native = nativeStub([record()]);

    // Both calls come from the same runtime; the second must join the first
    // rather than start a second pass over the same un-acked records.
    await Promise.all([drain(native), drain(native)]);

    expect(sentBatches(fetchMock)).toHaveLength(1);
    expect(native.clearPendingCrashReports).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is nothing pending", async () => {
    const native = nativeStub([]);

    await drain(native);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(native.clearPendingCrashReports).not.toHaveBeenCalled();
  });

  /**
   * A record is JSON off the device's disk, possibly written by a different SDK version, and
   * only `id` is checked. A truthy non-string message survives
   * `record.errorMessage || "Native crash"` and reaches `redactText`, which catches its own
   * failure and hands the value back untouched — so it ships as an `error_message` the
   * schema calls a string, with `error_fingerprint` built from stringified garbage.
   *
   * The boundary therefore coerces rather than validates: dropping a real crash report over
   * one odd field is the worse trade, and every field has a documented default.
   */
  it("reports and acks a record whose message is not a string", async () => {
    const native = nativeStub([record({ errorMessage: { code: 7 } as unknown as string })]);

    await drain(native);

    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["crash-1"]);
    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["error_message"]).toBe("Native crash");
    // The fingerprint is built from the message, so it must not carry the
    // uncoerced value either.
    expect(attrs["error_fingerprint"]).toBe("SIGSEGV:Native crash");
  });

  /**
   * An unusable crash time falls back to the DRAIN time arithmetically rather than by a
   * branch: `msToNs` of a non-number is NaN, NaN is falsy, and `timestamp || now` substitutes.
   *
   * `Infinity` would defeat that (truthy after `* 1e6`, so it reaches the wire as
   * `JSON.stringify`'s `null` — no timestamp at all) but cannot get here: records cross as a
   * JSON string, and JSON has no `Infinity` literal, so it is already the `null` this sends.
   */
  it("falls back to the drain-time timestamp when the crash time is unusable", async () => {
    const native = nativeStub([record({ crashEpochMs: null as unknown as number })]);

    await drain(native);

    const [batch] = sentBatches(fetchMock);
    expect(batch!.events[0]!.timestamp).toEqual(expect.any(Number));
    expect(Number.isFinite(batch!.events[0]!.timestamp)).toBe(true);
  });

  it("falls back to the default error type when the type is not a string", async () => {
    const native = nativeStub([record({ errorType: 42 as unknown as string })]);

    await drain(native);

    expect(native.clearPendingCrashReports).toHaveBeenCalledWith(["crash-1"]);
    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["error_type"]).toBe("NativeCrash");
  });

  /**
   * Metadata is spread into `error_metadata`, so a non-object here does not throw
   * — it decomposes. A string spreads to one attribute per CHARACTER, burying the
   * native markers under `error_metadata.0`, `.1`, `.2`…
   *
   * Asserted with masking off, because that is the only path where the raw value
   * is spread: `redactObject` happens to return an empty object for a
   * non-object, so the default masked path already absorbs it. Relying on that
   * would make the guarantee an accident of another module's tolerance.
   */
  it("ignores metadata that is not an object instead of spreading it", async () => {
    const native = nativeStub([record({ metadata: "oops" as unknown as Record<string, unknown> })]);

    await drain(native, configManager({ privacy: { level: "allow" } }));

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    expect(attrs["error_metadata.0"]).toBeUndefined();
    // The markers we add ourselves are the point of the field and must survive.
    expect(attrs["error_metadata.native"]).toBe(true);
    expect(attrs["error_metadata.crash_report_id"]).toBe("crash-1");
  });
  /**
   * The record comes off the device's disk, possibly written by an older SDK version — the trust
   * boundary `toCrashRecord` exists for. `stacktrace` goes through the same `normalizeStackFrames`
   * the HANG path uses: passed through on an `Array.isArray` check alone, a null frame or one whose
   * `filename` is not a string would reach the wire while the hang path drops exactly those. Same
   * shape of data, one policy.
   */
  it("drops stack frames the hang path would reject", async () => {
    const native = nativeStub([
      record({
        stacktrace: [
          { filename: "GcRumCrashHandler.kt", function: "record", lineno: 42, colno: 0 },
          null,
          { filename: 5, function: "junk", lineno: 1, colno: 0 },
        ] as unknown as PendingCrashRecord["stacktrace"],
      }),
    ]);

    await drain(native);

    const attrs = sentBatches(fetchMock)[0]!.events[0]!.attributes as Record<string, unknown>;
    // Frames reach the wire dot-flattened per entry, as `hangs-listener.test.ts` asserts them.
    const frames = attrs["error_stacktrace"] as Array<Record<string, unknown>>;
    expect(frames).toHaveLength(1);
    expect(frames[0]!["error_stacktrace[0].filename"]).toBe("GcRumCrashHandler.kt");
    expect(frames[0]!["error_stacktrace[0].lineno"]).toBe(42);
  });
});
