import { describe, it, expect } from "vitest";
import { PendingBatch } from "./pending-batch";
import type { BaseEvent, DedupInfo } from "./types";
import type { ErrorDeduplicationOptions } from "../config/types";

let nextId = 0;
const event = (name: string): BaseEvent => ({
  type: "test",
  id: `e-${nextId++}`,
  spanId: "s",
  parentSpanId: "",
  traceId: "t",
  attributes: { name },
});
const LOOP: DedupInfo = { key: 1, countAttribute: "repeat_count" };
const on = () => new PendingBatch(() => undefined);

describe("PendingBatch", () => {
  it("buffers new events, returning the buffer's length", () => {
    const batch = on();
    expect(batch.add(event("a"), undefined, Infinity)).toBe(1);
    expect(batch.add(event("b"), undefined, Infinity)).toBe(2);
    expect(batch.events.map((e) => e.attributes?.name)).toEqual(["a", "b"]);
  });

  it("counts a repeat on the buffered event, which adds no event to send", () => {
    const batch = on();
    const first = event("loop");
    batch.add(first, LOOP, Infinity);
    batch.add(event("a"), undefined, Infinity);
    expect(batch.add(event("loop"), LOOP, Infinity)).toBe(2);
    expect(batch.add(event("loop"), LOOP, Infinity)).toBe(2);
    expect(batch.events).toHaveLength(2);

    const sent = batch.toSend();
    expect(sent[0]).toMatchObject({ id: first.id, attributes: { name: "loop", repeat_count: 3 } });
    expect(sent[1]!.attributes).not.toHaveProperty("repeat_count");
  });

  it("keeps different keys apart", () => {
    const batch = on();
    batch.add(event("loop"), LOOP, Infinity);
    batch.add(event("other"), { key: 2, countAttribute: "repeat_count" }, Infinity);
    expect(batch.events).toHaveLength(2);
  });

  it("writes the count on a copy, leaving the buffered event as it was", () => {
    const batch = on();
    const first = Object.freeze({ ...event("loop"), attributes: Object.freeze({ name: "loop" }) });
    batch.add(first, LOOP, Infinity);
    batch.add(event("loop"), LOOP, Infinity);

    expect(batch.toSend()[0]!.attributes).toEqual({ name: "loop", repeat_count: 2 });
    expect(first.attributes).toEqual({ name: "loop" });
  });

  it("leaves a single occurrence unchanged", () => {
    const batch = on();
    const only = event("loop");
    batch.add(only, LOOP, Infinity);
    expect(batch.toSend()[0]).toBe(only);
  });

  it("refuses a new event at capacity but still counts a repeat", () => {
    const batch = on();
    batch.add(event("loop"), LOOP, 1);
    expect(batch.add(event("a"), undefined, 1)).toBeNull();
    expect(batch.add(event("loop"), LOOP, 1)).toBe(1);
    expect(batch.events).toHaveLength(1);
  });

  it("merges nothing while enabled is falsy, read on every event", () => {
    let options: ErrorDeduplicationOptions | undefined = { enabled: false };
    const batch = new PendingBatch(() => options);
    batch.add(event("loop"), LOOP, Infinity);
    batch.add(event("loop"), LOOP, Infinity);
    expect(batch.events).toHaveLength(2);

    options = {};
    expect(batch.add(event("loop"), LOOP, Infinity)).toBe(3); // the first two were never tracked
    expect(batch.add(event("loop"), LOOP, Infinity)).toBe(3); // a repeat of the third
    expect(batch.toSend().map((e) => e.attributes?.repeat_count)).toEqual([undefined, undefined, 2]);
  });

  it("merges nothing when the setting can't be read", () => {
    const batch = new PendingBatch(() => {
      throw new Error("hostile config");
    });
    batch.add(event("loop"), LOOP, Infinity);
    batch.add(event("loop"), LOOP, Infinity);
    expect(batch.events).toHaveLength(2);
  });
});
