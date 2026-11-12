import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventsPool } from "./events-pool";
import { EventEnricher, type EnrichInput } from "./event-enricher";
import { SessionLifecycle } from "../session/session-lifecycle";
import { SessionState } from "../session/session-state";
import { SafeStorage } from "../common/storage";
import { RandomIdGenerator } from "../common/id-generator";
import { BaseListener, type ListenerDeps } from "./listeners/base-listener";
import { LogEventsListener } from "./listeners/logs-events-listener";
import { ManualEventEmitter } from "./manual-event-emitter";
import type { ConfigManager } from "../config/config-manager";
import type { Transporter } from "../transporter/transporter";
import type { BaseEvent, EnrichedEvent, CoreEventType } from "./types";
import { MemoryStorage } from "../test-utils/memory-storage";

const hostStorage = new MemoryStorage();

// The whole point of `BaseEvent<TType>`: a platform package must be able to
// name its OWN event kinds without editing core. This suite stands in for a
// second, extension platform — if any of it stops compiling, core has
// closed the vocabulary and a platform would need a core PR to ship a new
// signal.
type ExtExtra = "ext.tap" | "ext.view" | "ext.lifecycle";
type ExtEventType = CoreEventType | ExtExtra;

const mockSend = vi.fn();

const createConfigFake = () =>
  ({
    getConfig: vi.fn().mockReturnValue({
      options: { transport: { batchSize: 100, batchTimeout: 10_000 } },
      appId: "ext-app",
      cluster: "c",
    }),
  }) as unknown as ConfigManager;

const createTransporterFake = () =>
  ({ send: mockSend }) as unknown as Transporter;

describe("platform extension (stand-in for a second platform)", () => {
  let pool: EventsPool<ExtEventType>;
  let config: ConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();
    hostStorage.clear();
    config = createConfigFake();

    pool = new EventsPool<ExtEventType>({
      config,
      session: new SessionState({
        storage: new SafeStorage(hostStorage),
      }),
      transporter: createTransporterFake(),
      // The extension platform's device provider contributes its OWN
      // vocabulary. Core must not require any other platform's shape.
      getDeviceAttributes: () => ({
        device_model: "test-device",
        os_name: "test-os",
        os_version: "15",
        app_version: "2.1.0",
      }),
      eventsToSkipFlush: ["ext.view"],
    });
    pool.initialize();
  });

  afterEach(() => {
    pool.destroy();
  });

  it("accepts a platform-defined event kind core has never heard of", () => {
    const tap: BaseEvent<ExtEventType> = {
      type: "ext.tap",
      id: "e1",
      spanId: "s1",
      parentSpanId: undefined,
      traceId: undefined,
      attributes: { target: "checkout-button" },
    };

    pool.addEvent(tap);
    pool.flush();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const batch = mockSend.mock.calls[0]?.[0];
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].type).toBe("ext.tap");
  });

  it("stamps the platform's own device vocabulary on the envelope", () => {
    pool.addEvent({
      type: "ext.view",
      id: "e2",
      spanId: "s2",
      parentSpanId: undefined,
      traceId: undefined,
    });
    pool.flush();

    const attrs = mockSend.mock.calls[0]?.[0].sessionAttributes;
    expect(attrs.device_model).toBe("test-device");
    expect(attrs.os_name).toBe("test-os");
    // Core must not have invented device fields of its own: the envelope is
    // exactly the provider's vocabulary plus core's session identity fields.
    expect(Object.keys(attrs).sort()).toEqual(
      [
        "device_model",
        "os_name",
        "os_version",
        "app_version",
        "cluster",
        "env",
        "namespace",
        "releaseId",
        "session_id",
        "session_start_time",
        "user",
        "service.name",
      ].sort(),
    );
  });

  it("still carries the shared kinds alongside the platform's own", () => {
    pool.addEvent({
      type: "network",
      id: "e3",
      spanId: "s3",
      parentSpanId: undefined,
      traceId: undefined,
    });
    pool.flush();

    expect(mockSend.mock.calls[0]?.[0].events[0].type).toBe("network");
  });

  it("drives the session lifecycle off platform-defined presence signals", () => {
    const session = new SessionState({
      storage: new SafeStorage(hostStorage),
    });
    const lifecycle = new SessionLifecycle<void, ExtEventType>({
      session,
      pool,
      idGenerator: new RandomIdGenerator(),
      // "an ext.tap proves a human" — the platform picks its own presence kind.
      activityEventTypes: new Set<ExtEventType>(["ext.tap"]),
      ignoredEventTypes: new Set<ExtEventType>(["ext.lifecycle"]),
    });
    lifecycle.install();

    expect(session.hasUserActivity()).toBe(false);

    pool.addEvent({
      type: "ext.tap",
      id: "e4",
      spanId: "s4",
      parentSpanId: undefined,
      traceId: undefined,
    });

    // The tap confirmed the session, which is what opens the flush gate.
    expect(session.hasUserActivity()).toBe(true);
  });

  // An open event KIND is only half the contract — a platform kind carries a
  // platform PAYLOAD. Passing real platform attributes here (rather than
  // `undefined`, which sidesteps the question) is what keeps EnrichInput from
  // silently narrowing to a single platform's attribute union.
  it("enriches a platform-defined kind with a platform-defined payload", () => {
    const enricher = new EventEnricher();

    const input: EnrichInput<"ext.tap"> = {
      type: "ext.tap",
      attributes: {
        tap_target: "checkout-button",
        tap_x: 128,
        tap_y: 440,
        view_name: "Cart",
      },
    };
    const enriched = enricher.enrich(input);

    expect(enriched.type).toBe("ext.tap");
    expect(enriched.id).toEqual(expect.any(String));
    expect(enriched.attributes).toMatchObject({
      tap_target: "checkout-button",
      tap_x: 128,
      tap_y: 440,
      view_name: "Cart",
    });
  });

  // The event VOCABULARY being open (above) is only useful if the listener
  // PLUMBING is open too: a platform listener that emits its own kind has to
  // receive the platform's `EventsPool<ExtEventType>` through ListenerDeps.
  // If ListenerDeps/BaseListener narrow the pool to EventsPool<CoreEventType>,
  // the platform can't wire its listener without a cast — core has closed the
  // boundary. These assertions fail to COMPILE if that regresses.
  describe("listener plumbing accepts a platform-extended pool", () => {
    class TapListener extends BaseListener<ExtExtra> {
      handleEvent(target: string): void {
        this.queueEvent(this.buildEvent(target));
      }

      buildEvent(target: string): EnrichedEvent<ExtEventType> {
        return this.enricher.enrich<"ext.tap">({
          type: "ext.tap",
          attributes: { tap_target: target },
        });
      }

      queueEvent(event: EnrichedEvent<ExtEventType>): void {
        this.eventsPool.addEvent(event);
      }

      initialize(): void {}
      destroy(): void {}
    }

    it("wires a BaseListener<TExtra> subclass onto the platform pool", () => {
      const enricher = new EventEnricher();
      const deps: ListenerDeps<ExtExtra> = { config, eventsPool: pool, enricher };
      const listener = new TapListener(deps);

      listener.handleEvent("checkout-button");
      pool.flush();

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]?.[0].events[0].type).toBe("ext.tap");
    });

    it("wires LogEventsListener and ManualEventEmitter onto the platform pool", () => {
      const enricher = new EventEnricher();

      const logListener = new LogEventsListener<ExtExtra>({
        config,
        eventsPool: pool,
        enricher,
      });
      const emitter = new ManualEventEmitter<ExtExtra>({
        config,
        pool,
        enricher,
      });

      // Compile-time is the real assertion; a smoke call keeps the runtime honest.
      emitter.sendCustomEvent({ event: "checkout", attributes: { step: 2 } });
      pool.flush();

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]?.[0].events[0].type).toBe("custom");
      expect(logListener).toBeInstanceOf(LogEventsListener);
    });
  });
});
