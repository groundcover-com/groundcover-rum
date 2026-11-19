import { handleError } from "../common/error-handler";
import type { ErrorDeduplicationOptions } from "../config/types";
import type { BaseEvent, DedupInfo } from "./types";

interface Repeat {
  index: number;
  count: number;
  countAttribute: string;
}

/**
 * The events waiting to be sent, with repeats merged: an event whose `dedup`
 * key matches one already here is counted on that one instead of buffered
 * again (errors.deduplication). Knows nothing about event types: an event's
 * producer decides what makes it a repeat (see DedupeableEvent). The pool
 * replaces the whole batch when it is sent or dropped, so a count can never
 * outlive the event it belongs to.
 */
export class PendingBatch<E extends BaseEvent<string>> {
  readonly events: E[] = [];
  private readonly repeats = new Map<number, Repeat>();

  /**
   * `readOptions` returns `options.errors.deduplication`, read on every event so
   * a config update applies at once. SDKConfig stores it as `{ enabled }` (it
   * expands the boolean shorthand); on unless `enabled` is falsy.
   */
  constructor(private readonly readOptions: () => ErrorDeduplicationOptions | boolean | undefined) {}

  /**
   * Buffers `event`, or counts it on the event it repeats. Returns what counts
   * toward the batch size: the buffer's length, or the merged event's
   * occurrences, so an error loop is still sent every batchSize occurrences.
   * Null when the buffer is at `capacity`; a repeat takes no slot, so it is
   * counted even then.
   */
  add(event: E, dedup: DedupInfo | undefined, capacity: number): number | null {
    const merging = dedup && this.isEnabled() ? dedup : undefined;
    const repeat = merging && this.repeats.get(merging.key);
    if (repeat) return ++repeat.count;

    if (this.events.length >= capacity) return null;
    const size = this.events.push(event);
    if (merging) {
      this.repeats.set(merging.key, { index: size - 1, count: 1, countAttribute: merging.countAttribute });
    }
    return size;
  }

  /**
   * The events as they are sent: each merged one replaced by a copy carrying
   * its count, so the count never lands on an object a hook may still hold (or
   * froze). An event that can't be copied (a hostile getter) is sent as it is.
   */
  toSend(): E[] {
    const events = this.events.slice();
    for (const { index, count, countAttribute } of this.repeats.values()) {
      if (count < 2) continue;
      try {
        const event = events[index]!;
        events[index] = { ...event, attributes: { ...event.attributes, [countAttribute]: count } };
      } catch (error) {
        handleError(error);
      }
    }
    return events;
  }

  // Contained: a config that can't be read means the event isn't merged.
  private isEnabled(): boolean {
    try {
      const enabled = (this.readOptions() as ErrorDeduplicationOptions | undefined)?.enabled;
      return enabled === undefined || Boolean(enabled);
    } catch (error) {
      handleError(error);
      return false;
    }
  }
}
