import { describe, it, expect } from "vitest";
import type { SDKConfigInput, SDKConfigUpdate, CallbackEvent } from "./types";

// Type-level contracts. The @ts-expect-error assertions are enforced by
// `tsc -p tsconfig.tests.json` (wired into CI); vitest just executes the trivial
// bodies so the file is a real, runnable test.
describe("RN config type contracts", () => {
  it("requires appId at init and excludes it from runtime updates", () => {
    // @ts-expect-error appId is required at initialization.
    const missing: SDKConfigInput = { apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e" };
    const update: SDKConfigUpdate = {
      // @ts-expect-error appId is fixed at initialization.
      appId: "other-app",
    };
    expect(missing).not.toHaveProperty("appId");
    expect(update).toHaveProperty("appId", "other-app");
  });

  it("updateConfig rejects options.enabledEvents — a runtime no-op, so it must not type-check", () => {
    // Listeners are constructed once in instrument() and never reconsulted, so
    // accepting an enabledEvents change at runtime would type-check a silent
    // no-op. It is omitted from the update options on purpose.
    const ok: SDKConfigUpdate = { options: { debug: true } };
    const bad: SDKConfigUpdate = {
      // @ts-expect-error enabledEvents is intentionally not updatable at runtime.
      options: { enabledEvents: ["network"] },
    };
    expect(ok).toBeTruthy();
    expect(bad).toBeTruthy();
  });

  it("callback events expose DOT-FLATTENED attributes, never the nested build shape", () => {
    const filter = (e: CallbackEvent): boolean => {
      // Flattened bracket access is how the runtime shape is read...
      void e.attributes["interaction_target.label"];
      // ...and the nested build shape is deliberately NOT on the type: a filter
      // written against it would throw at runtime and silently drop the event.
      // @ts-expect-error runtime attributes are dot-flattened, not nested.
      void e.attributes.interaction_target?.label;
      // `screen` is the one block that stays nested (merged after flattening).
      return e.attributes.screen.name !== "Secret";
    };
    expect(typeof filter).toBe("function");
  });
});
