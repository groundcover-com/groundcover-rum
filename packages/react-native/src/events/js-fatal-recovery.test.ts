import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";
import { msToNs, type Batch, type BaseEvent } from "@groundcover/rum-core";
import groundcover, { __resetForTest, __whenReady } from "../index";
import type { CallbackEvent } from "../config/types";
import { reportPresence } from "../internal/touch-bridge";
import { NATIVE_MODULE_NAME, type PendingJsFatal } from "../platform/native-types";
import { __reset, __setNativeModule } from "../test-utils/react-native-stub";
import { __resetDrainStateForTest } from "./native-crash-drain";

const config = { appId: "app", cluster: "test", environment: "test", apiKey: "key", dsn: "ingest.test" };
const options = { enabledEvents: ["exceptions" as const], transport: { compression: false } };

function fixture() {
  const host = vi.fn();
  let handler: (error: Error, fatal: boolean) => void = host;
  vi.stubGlobal("ErrorUtils", {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next: typeof handler) => { handler = next; },
  });
  const files = new Map<string, string>();
  const native = {
    nativeInit: async () => "{}",
    updateSessionSnapshot: vi.fn(),
    writePendingCrashReport: vi.fn((id: string, json: string) => { files.set(id, json); return true; }),
    getPendingCrashReports: vi.fn(async () => JSON.stringify(Array.from(files.values(), json => JSON.parse(json)))),
    clearPendingCrashReports: vi.fn(async (ids: string[]) => {
      for (const id of ids) files.delete(id);
    }),
    stop: vi.fn(),
  };
  __setNativeModule(NATIVE_MODULE_NAME, native);
  const send = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
  vi.stubGlobal("fetch", send);
  return { host, files, native, send, nonfatal: (error: Error) => handler(error, false), fatal: (error = new Error("startup failure")) => handler(error, true) };
}

afterEach(() => {
  __resetForTest();
  __resetDrainStateForTest();
  __reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fatal JS recovery", () => {
  it("saves the same error attributes as the ordinary uncaught-error pipeline", async () => {
    const { native, fatal, nonfatal } = fixture();
    const beforeSend = vi.fn((_event: CallbackEvent) => true);
    groundcover.init({ ...config, options: { ...options, beforeSend } });
    await __whenReady();

    const error = new Error("startup password=private-message");
    error.name = "StartupError password=private-name";
    error.stack = "    at start_password=private-function (app.js?password=private-path:12:3)";
    nonfatal(error);
    fatal(error);

    const [ordinary] = beforeSend.mock.calls[0]!;
    const [, json] = native.writePendingCrashReport.mock.calls[0]!;
    const saved = JSON.parse(json) as PendingJsFatal<BaseEvent>;
    expect(saved.events.at(-1)!.attributes).toEqual(ordinary.attributes);
    expect(json).not.toContain("private-message");
  });

  it("keeps the accepted startup event through a failed delivery and a successful retry", async () => {
    const { files, fatal, host, native, send } = fixture();
    const enrichEvent = vi.fn((event: CallbackEvent) => ({
      ...event,
      attributes: { screen: event.attributes.screen, sanitized: true },
    }));
    const beforeSend = vi.fn(() => true);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    groundcover.init({ ...config, sessionId: "original", options: { ...options, enrichEvent, beforeSend } });
    const at = Date.now();
    fatal(); // During hydration, before the first tap.
    expect(host).toHaveBeenCalledOnce();
    expect(files.size).toBe(0);
    now.mockReturnValue(at + 500);
    send.mockResolvedValue({ ok: false });
    await __whenReady();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const [id, json] = Array.from(files.entries())[0]!;
    const saved = JSON.parse(json) as PendingJsFatal<BaseEvent>;
    expect(saved.jsFatalId).toBe(id);
    expect(saved.events).toHaveLength(1);
    expect(saved.events[0]).toMatchObject({ id, timestamp: msToNs(at), attributes: { sanitized: true } });
    expect(json).not.toContain("startup failure");
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(enrichEvent).toHaveBeenCalledOnce();

    __resetForTest();
    const reject = vi.fn(() => false);
    send.mockResolvedValue({ ok: true });
    groundcover.init({ ...config, sessionId: "next", options: { ...options, beforeSend: reject, sessionSampleRate: 0 } });
    await __whenReady();
    await vi.waitFor(() => expect(files.size).toBe(0));
    expect(reject).not.toHaveBeenCalled();
    expect(native.clearPendingCrashReports).toHaveBeenCalledOnce();
    const batches = send.mock.calls.map(([, init]) => JSON.parse(strFromU8(init.body as Uint8Array)) as Batch);
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      expect(batch.sessionAttributes.session_id).toBe("original");
      expect(batch.events).toEqual(saved.events);
    }
  });

  it.each(["refused", "threw", "old binary"])("flushes the accepted event once when the writer is %s", async failure => {
    const { native, send, host, fatal } = fixture();
    if (failure === "old binary") Reflect.deleteProperty(native, "writePendingCrashReport");
    else native.writePendingCrashReport.mockImplementation(() => {
      if (failure === "threw") throw new Error("bridge failure");
      return false;
    });
    const beforeSend = vi.fn(() => true);
    groundcover.init({ ...config, options: { ...options, beforeSend } });
    await __whenReady();
    reportPresence(Date.now());
    groundcover.captureException(new Error("earlier handled error"));
    fatal();
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(host).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const [, init] = send.mock.calls[0]!;
    const batch = JSON.parse(strFromU8(init.body as Uint8Array)) as Batch;
    expect(batch.events.map(event => event.attributes?.error_message)).toEqual(["earlier handled error", "startup failure"]);
  });

  it.each(["before", "after"])("saves queued events with the fatal and sends them once in the same run, %s the first tap", async timing => {
    const { fatal, files, host, native, send } = fixture();
    groundcover.init({ ...config, sessionId: "original", options: { ...options, enabledEvents: ["exceptions", "logs"] } });
    await __whenReady();
    // Let the startup recovery finish, so only a run started by the save can send the file.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(native.getPendingCrashReports).toHaveBeenCalledOnce();
    if (timing === "after") reportPresence(Date.now());
    groundcover.logger.info("earlier log");
    groundcover.captureException(new Error("earlier handled error"));
    expect(send).not.toHaveBeenCalled();
    fatal();
    expect(host).toHaveBeenCalledOnce();
    expect(native.writePendingCrashReport).toHaveBeenCalledOnce();
    const [, json] = native.writePendingCrashReport.mock.calls[0]!;
    const saved = JSON.parse(json) as PendingJsFatal<BaseEvent>;
    expect(saved.events.map(event => event.type)).toEqual(["log", "exception", "exception"]);
    await vi.waitFor(() => expect(files.size).toBe(0));
    expect(native.getPendingCrashReports).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    const [, init] = send.mock.calls[0]!;
    const batch = JSON.parse(strFromU8(init.body as Uint8Array)) as Batch;
    expect(batch.sessionAttributes.session_id).toBe("original");
    expect(batch.events).toEqual(saved.events);
  });

  it("saves only the first fatal of a run, and queues later fatals once its file was sent", async () => {
    const { fatal, files, native, send } = fixture();
    groundcover.init({ ...config, options });
    await __whenReady();
    reportPresence(Date.now());
    const repeating = new Error("repeating failure");
    fatal(repeating);
    await vi.waitFor(() => expect(files.size).toBe(0));
    fatal(repeating);
    fatal(new Error("other failure"));
    expect(native.writePendingCrashReport).toHaveBeenCalledOnce();
    // The file carried the first fatal; the queue sends the repeat and the other fatal.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const sent = send.mock.calls.map(([, init]) => JSON.parse(strFromU8(init.body as Uint8Array)) as Batch);
    expect(sent.map(batch => batch.events.map(event => event.attributes?.error_message))).toEqual([
      ["repeating failure"],
      ["repeating failure"],
      ["other failure"],
    ]);
  });

  it("counts a repeat of the saved fatal in its file while the file is unsent", async () => {
    const { fatal, files, native, send } = fixture();
    send.mockResolvedValue({ ok: false });
    groundcover.init({ ...config, options: { ...options, enabledEvents: ["exceptions", "logs"] } });
    await __whenReady();
    groundcover.logger.info("earlier log");
    const repeating = new Error("repeating failure");
    fatal(repeating);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    fatal(repeating);
    fatal(repeating);
    reportPresence(Date.now());
    fatal(new Error("other failure"));
    // The same file was written again for each repeat; the other fatal got no file.
    const writes = native.writePendingCrashReport.mock.calls;
    expect(writes.map(([id]) => id)).toEqual([writes[0]![0], writes[0]![0], writes[0]![0]]);
    expect(writes.map(([, json]) => {
      const record = JSON.parse(json) as PendingJsFatal<BaseEvent>;
      return record.events.at(-1)!.attributes?.error_repeat_count;
    })).toEqual([undefined, 2, 3]);
    expect(files.size).toBe(1);
    const saved = JSON.parse(writes[2]![1]) as PendingJsFatal<BaseEvent>;
    expect(saved.events.map(event => [event.type, event.attributes?.error_repeat_count])).toEqual([
      ["log", undefined],
      ["exception", 3],
    ]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const [, init] = send.mock.calls[1]!;
    const queued = JSON.parse(strFromU8(init.body as Uint8Array)) as Batch;
    expect(queued.events.map(event => event.attributes?.error_message)).toEqual(["other failure"]);
  });

  it("reconciles the session before committing the crash", async () => {
    const { native, fatal } = fixture();
    const now = vi.spyOn(Date, "now");
    const start = Date.now();
    now.mockReturnValue(start);
    groundcover.init({ ...config, sessionId: "expired", options: { ...options, sessionMaxDuration: 60_000 } });
    await __whenReady();
    now.mockReturnValue(start + 61_000);
    fatal();
    const [, json] = native.writePendingCrashReport.mock.calls[0]!;
    const session = JSON.parse(JSON.parse(json).sessionSnapshotJson);
    expect(session.session_id).toBe(groundcover.getSessionId());
    expect(session.session_id).not.toBe("expired");
  });

  it.each(["unsampled", "exceptions disabled", "filtered", "broken enricher"])("chains but does not persist when %s", async reason => {
    const { native, fatal, host } = fixture();
    groundcover.init({ ...config, options: {
      ...options, sessionSampleRate: reason === "unsampled" ? 0 : 1,
      enabledEvents: reason === "exceptions disabled" ? ["crashes"] : ["exceptions"],
      beforeSend: () => reason !== "filtered",
      enrichEvent: event => { if (reason === "broken enricher") throw new Error("failed"); return event; },
    } });
    fatal();
    await __whenReady();
    fatal();
    expect(native.writePendingCrashReport).not.toHaveBeenCalled();
    expect(host).toHaveBeenCalledTimes(2);
  });
});
