import { describe, it, expect, vi } from "vitest";
import { ManualEventEmitter } from "./manual-event-emitter";
import { EventEnricher } from "./event-enricher";
import { EventsPool } from "./events-pool";
import { ConfigManager } from "../config/config-manager";
import { BaseEvent } from "./types";

function emitterWith(enricher: EventEnricher) {
  const addEvent = vi.fn();
  const emitter = new ManualEventEmitter({
    config: new ConfigManager(),
    pool: { addEvent } as unknown as EventsPool,
    enricher,
  });
  const sent = (): BaseEvent => {
    expect(addEvent).toHaveBeenCalledTimes(1);
    return addEvent.mock.calls[0]![0] as BaseEvent;
  };
  return { emitter, sent };
}

describe("ManualEventEmitter.emitLog reserved keys", () => {
  it("strips message/level and the platform's reserved keys from user attributes", () => {
    const { emitter, sent } = emitterWith(
      new EventEnricher({
        enrichAttributes: () => ({ view: { name: "home" } }),
        reservedAttributeKeys: ["view"],
      })
    );

    emitter.emitLog("hello", "info", {
      message: "spoofed",
      level: "error",
      view: { name: "spoofed", extra: 1 },
      orderId: 7,
    });

    const a = sent().attributes ?? {};
    expect(a.message).toBe("hello");
    expect(a.level).toBe("info");
    expect(a.view).toEqual({ name: "home" });
    expect(a).not.toHaveProperty(["view.extra"]);
    expect(a.orderId).toBe(7);
  });

  it("keeps a user key that no platform reserved", () => {
    const { emitter, sent } = emitterWith(new EventEnricher());

    emitter.emitLog("hello", "info", { location: "warehouse-7" });

    expect(sent().attributes?.location).toBe("warehouse-7");
  });
});
