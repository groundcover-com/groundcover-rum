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
    getPendingCrashReports: async () => JSON.stringify(Array.from(files.values(), json => JSON.parse(json))),
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
    expect(saved.event.attributes).toEqual(ordinary.attributes);
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
    expect(saved.event).toMatchObject({ id, timestamp: msToNs(at), attributes: { sanitized: true } });
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
      expect(batch.events).toEqual([saved.event]);
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
    fatal();
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(host).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  });

  it("flushes events queued before a successfully saved fatal", async () => {
    const { fatal, native, send } = fixture();
    groundcover.init({ ...config, options });
    await __whenReady();
    reportPresence(Date.now());
    groundcover.captureException(new Error("earlier handled error"));
    expect(send).not.toHaveBeenCalled();
    fatal();
    expect(native.writePendingCrashReport).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const [, init] = send.mock.calls[0]!;
    const batch = JSON.parse(strFromU8(init.body as Uint8Array)) as Batch;
    expect(batch.events.map(event => event.attributes?.error_message)).toEqual(["earlier handled error"]);
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
