import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigManager,
  EventEnricher,
  RandomIdGenerator,
  type SDKConfigInput,
} from "@groundcover/rum-core";

import { InteractionListener } from "./interaction-listener";
import { EMPTY_WALK } from "../../react/fiber-walk";
import type { RawGesture } from "../../internal/touch-bridge";

function setup(options: Record<string, unknown> = {}) {
  const config = new ConfigManager();
  config.initialize({
    dsn: "ingest.example",
    apiKey: "k",
    cluster: "c",
    environment: "e",
    appId: "a",
    options,
  } as SDKConfigInput);

  const eventsPool = { addEvent: vi.fn(), flush: vi.fn() };
  const enricher = new EventEnricher({
    enrichAttributes: () => ({ screen: { name: "Checkout", key: "Checkout-1" } }),
    idGenerator: new RandomIdGenerator(),
  });

  const listener = new InteractionListener({
    config,
    eventsPool: eventsPool as never,
    enricher,
  });
  listener.initialize();

  return { listener, eventsPool };
}

const swipe = (over: Partial<RawGesture> = {}): RawGesture => ({
  kind: "swipe",
  x: 300,
  y: 400,
  target: EMPTY_WALK,
  captureSource: "js",
  startedAtMs: 1_700_000_000_000,
  direction: "left",
  distanceDp: 184,
  durationMs: 210,
  velocityDpS: 876,
  pointerCount: 1,
  partial: false,
  ...over,
});

describe("InteractionListener", () => {
  let harness: ReturnType<typeof setup>;

  beforeEach(() => {
    // The guard test below mocks EventEnricher.prototype.enrich to throw; left in place it
    // would silently empty every later assertion instead of failing them.
    vi.restoreAllMocks();
    harness = setup();
  });

  // `enrich` flattens nested attributes to dotted keys, so this is the wire shape.
  const queued = () =>
    harness.eventsPool.addEvent.mock.calls[0]?.[0] as {
      type: string;
      attributes: Record<string, unknown>;
    };

  /**
   * Every entry contains its own build failure. One that does not lets the failure escape the
   * listener entirely — into the touch bridge's catch when it comes from a real touch, and
   * straight into the caller on every other route.
   */
  it("contains a build failure instead of throwing into the caller", () => {
    vi.spyOn(EventEnricher.prototype, "enrich").mockImplementation(() => {
      throw new Error("enrich boom");
    });

    expect(() => harness.listener.handleEvent(swipe())).not.toThrow();
    expect(harness.eventsPool.addEvent).not.toHaveBeenCalled();
  });

  /**
   * With one builder for every source, `capture_source` has to be carried by the payload rather
   * than decided by which method was called — otherwise the JS and native paths could only be
   * told apart by having separate builders.
   */
  it("labels the capture source from the payload, through the one builder", () => {
    harness.listener.handleEvent(swipe());
    expect(queued().attributes["interaction_gesture.capture_source"]).toBe("js");

    harness.eventsPool.addEvent.mockClear();

    // Exactly what RNInstrumentationManager.handleNativeGesture maps a NativeGesturePayload into.
    harness.listener.handleEvent(swipe({ kind: "scroll", captureSource: "native" }));
    expect(queued().attributes["interaction_gesture.capture_source"]).toBe("native");
  });

  /** A tap is a RawGesture with kind "tap", but it carries no kinematics: the classifier's
   *  defaults are not measurements of anything, and shipping them would invent a 0dp/0ms
   *  "gesture" for every tap in the product. The one builder has to keep that distinction. */
  it("emits no interaction_gesture block for a tap", () => {
    harness.listener.handleEvent(swipe({ kind: "tap", direction: undefined }));

    const attributes = queued().attributes;
    expect(attributes["interaction_type"]).toBe("tap");
    expect(Object.keys(attributes).filter((k) => k.startsWith("interaction_gesture"))).toEqual([]);
    expect(attributes["interaction_coordinates.x"]).toBe(300);
    expect(attributes["interaction_coordinates.y"]).toBe(400);
  });
});
