import { describe, expect, expectTypeOf, it } from "vitest";
import { DEFAULT_SDK_CONFIG_OPTIONS } from "./constants";
import type { SDKConfigInput, SDKOptions } from "./types";
import type { BaseEvent } from "../events/types";

// An extension platform extends the OPEN event-name set (see BaseEvent<TType>)
// with its own kinds. It must be able to type `beforeSend` / `enrichEvent` over
// THOSE events through the core config contract — without casts and without an
// Omit-and-redeclare workaround. These are type-level assertions: the
// gate is `tsc --noEmit -p tsconfig.tests.json` (part of `npm run test`), which
// fails to compile if the core callbacks are not generic over the event type.
type ExtEvent = BaseEvent<"ext.tap" | "ext.view">;

describe("sampling configuration", () => {
  it("supports session sampling without an event sampling option", () => {
    expectTypeOf<SDKOptions>().not.toHaveProperty("eventSampleRate");
    expectTypeOf<SDKOptions>().toHaveProperty("sessionSampleRate").toBeNumber();
    expect(DEFAULT_SDK_CONFIG_OPTIONS).not.toHaveProperty("eventSampleRate");
    expect(DEFAULT_SDK_CONFIG_OPTIONS.sessionSampleRate).toBe(1);
  });
});

describe("core config callbacks are generic over the platform event type", () => {
  it("types beforeSend/enrichEvent over a platform-defined event map (no casts)", () => {
    const beforeSend = (event: ExtEvent): boolean => event.type === "ext.tap";
    const enrichEvent = (event: ExtEvent): ExtEvent => event;

    // Compiles ONLY because SDKOptions / SDKConfigInput are generic over their
    // event type. Were they not, `SDKOptions<ExtEvent>` would be "not generic"
    // and assigning ExtEvent callbacks would report TS2322 against a fixed union.
    const options: Partial<SDKOptions<ExtEvent>> = { beforeSend, enrichEvent };
    const input: Partial<SDKConfigInput<ExtEvent>> = { options };

    expect(options.beforeSend?.({ type: "ext.tap" } as ExtEvent)).toBe(true);
    expect(input.options?.enrichEvent).toBe(enrichEvent);
  });

  it("defaults to the open core event type when no type argument is given", () => {
    // Bare `SDKOptions` means the open core event type, so a consumer that never
    // spells out a type argument gets hooks typed over `BaseEvent<string>`.
    const options: Partial<SDKOptions> = {
      beforeSend: (event) => event.type === "network",
    };
    expect(typeof options.beforeSend).toBe("function");
  });
});
