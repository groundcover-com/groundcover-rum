import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigManager,
  EventEnricher,
  RandomIdGenerator,
  msToNs,
  type SDKConfigInput,
} from "@groundcover/rum-core";

import { HangsEventsListener } from "./hangs-listener";
import type { NativeHangPayload } from "../../platform/native-types";

function setup() {
  const config = new ConfigManager();
  config.initialize({
    dsn: "ingest.example",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
  } as SDKConfigInput);

  const eventsPool = {
    addEvent: vi.fn(),
    flush: vi.fn(),
  };
  const enricher = new EventEnricher({
    enrichAttributes: () => ({ screen: { name: "Checkout", key: "Checkout-1" } }),
    idGenerator: new RandomIdGenerator(),
  });

  const listener = new HangsEventsListener({
    config,
    eventsPool: eventsPool as never,
    enricher,
  });
  listener.initialize();

  return { listener, eventsPool };
}

const hang = (over: Partial<NativeHangPayload> = {}): NativeHangPayload => ({
  kind: "anr",
  startedAtMs: 1_700_000_000_000,
  durationMs: 5_210,
  ...over,
});

describe("HangsEventsListener", () => {
  let harness: ReturnType<typeof setup>;

  beforeEach(() => {
    harness = setup();
  });

  const queuedEvent = () =>
    harness.eventsPool.addEvent.mock.calls[0]?.[0] as {
      type: string;
      attributes: Record<string, unknown>;
    };

  it("reports a hang as an exception, the same shape a crash or JS error uses", () => {
    harness.listener.handleEvent(hang());

    const event = queuedEvent();
    expect(event.type).toBe("exception");
    expect(event.attributes["error_type"]).toBe("ANR");
    expect(event.attributes["error_message"]).toBe("Main thread blocked for 5210ms");
    // Nobody handled it — the user watched a frozen app.
    expect(event.attributes["error_handled"]).toBe(false);
    expect(event.attributes["error_metadata.native"]).toBe(true);
    expect(event.attributes["error_metadata.hang_duration_ms"]).toBe(5210);
    // Distinguishes this from the post-mortem ANR, which never came back.
    expect(event.attributes["error_metadata.recovered"]).toBe(true);
  });

  it("timestamps the hang at its ONSET, not when the recovery signal arrives", () => {
    // A hang is reported only once the app unfreezes — by definition, after the
    // taps and navigations it blocked. Falling back to the enrich-time clock would
    // drop it onto the timeline AFTER those interactions, the exact ordering a
    // consumer keys on. startedAtMs carries the onset; the event must use it.
    const onsetMs = 1_699_000_000_000;
    harness.listener.handleEvent(hang({ startedAtMs: onsetMs }));

    const event = queuedEvent() as { timestamp?: number };
    expect(event.timestamp).toBe(msToNs(onsetMs));
  });

  it("uses each platform's own name for the stall", () => {
    harness.listener.handleEvent(hang({ kind: "app_hang" }));

    expect(queuedEvent().attributes["error_type"]).toBe("AppHang");
  });

  it("fingerprints by duration BUCKET so repeat freezes group into one issue", () => {
    const first = setup();
    first.listener.handleEvent(hang({ durationMs: 5_210 }));
    const second = setup();
    second.listener.handleEvent(hang({ durationMs: 5_940 }));

    const fingerprint = (h: ReturnType<typeof setup>) =>
      (h.eventsPool.addEvent.mock.calls[0]![0] as { attributes: Record<string, unknown> })
        .attributes["error_fingerprint"];

    expect(fingerprint(first)).toBe("ANR:5s");
    // Exact-millisecond fingerprints would make every hang its own issue and
    // bury the pattern.
    expect(fingerprint(second)).toBe(fingerprint(first));
  });

  it("buckets sub-second and very long stalls at the extremes", () => {
    const short = setup();
    short.listener.handleEvent(hang({ durationMs: 700 }));
    const long = setup();
    long.listener.handleEvent(hang({ durationMs: 120_000 }));

    const fingerprint = (h: ReturnType<typeof setup>) =>
      (h.eventsPool.addEvent.mock.calls[0]![0] as { attributes: Record<string, unknown> })
        .attributes["error_fingerprint"];

    expect(fingerprint(short)).toBe("ANR:<1s");
    expect(fingerprint(long)).toBe("ANR:30s+");
  });

  it("carries the native main-thread stack when there is one", () => {
    harness.listener.handleEvent(
      hang({
        mainThreadStack: [
          { filename: "com.acme.Checkout", function: "computeTotals", lineno: 142, colno: 0 },
        ],
      })
    );

    const frames = queuedEvent().attributes["error_stacktrace"] as Array<Record<string, unknown>>;
    expect(frames).toHaveLength(1);
    expect(frames[0]!["error_stacktrace[0].function"]).toBe("computeTotals");
  });

  it("still reports a hang with no stack (iOS ships none)", () => {
    harness.listener.handleEvent(hang({ kind: "app_hang", mainThreadStack: undefined }));

    expect(queuedEvent().attributes["error_stacktrace"]).toEqual([]);
  });

  it("flushes immediately — a hang often precedes a force-quit", () => {
    harness.listener.handleEvent(hang());

    expect(harness.eventsPool.flush).toHaveBeenCalledWith({ lifecycle: true });
  });

  it("ignores a signal that arrives after teardown", () => {
    // The native side is not synchronized with the JS lifecycle, so a hang can
    // be delivered mid-destroy.
    harness.listener.destroy();

    harness.listener.handleEvent(hang());

    expect(harness.eventsPool.addEvent).not.toHaveBeenCalled();
  });

  it("does not let a pool failure escape into the emitter callback", () => {
    harness.eventsPool.addEvent.mockImplementation(() => {
      throw new Error("pool exploded");
    });

    expect(() => harness.listener.handleEvent(hang())).not.toThrow();
  });
});
