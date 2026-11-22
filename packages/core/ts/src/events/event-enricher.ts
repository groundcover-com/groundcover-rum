import { msToNs } from "../common/global";
import { IdGenerator, RandomIdGenerator } from "../common/id-generator";
import { Logger } from "../common/logger";
import { hashText } from "../common/hash";

import { BaseEvent, DedupInfo, DedupeableEvent } from "./types";

/**
 * What a caller hands `EventEnricher.enrich`. Named so a platform can write `EnrichInput<"tap">`
 * rather than `Parameters<...>[0]`, which collapses the generic to its default. `attributes` is
 * deliberately open: narrowing it would make an open event KIND useless, and it would not tie
 * attributes to `type` either, so it would buy no safety. Per-kind shapes are enforced where
 * events are BUILT.
 */
export type EnrichInput<TType extends string = string> = Partial<
  BaseEvent<TType>
> & {
  type: TType;
  attributes?: Record<string, unknown>;
  /** What makes this event a repeat of another; see `DedupeableEvent`. Omitted: never merged. */
  dedup?: DedupInfo;
};

/**
 * A caller-supplied occurrence time (ns), or `fallback` when it is not usable.
 *
 * Callers may report an event later than it happened — one captured before the
 * SDK could send it and replayed afterwards — so a supplied timestamp is kept.
 * But it is VALIDATED, not merely defaulted: `|| fallback` would swallow 0, which
 * is a legitimate value (the Unix epoch, and what a miscomputed anchor produces),
 * while letting every other truthy number through. A negative or non-finite one
 * would then reach the wire, where `Infinity` serializes as `null` and a bad
 * magnitude misorders the event against its whole session.
 *
 * Shared by the network and non-network branches so the two cannot drift.
 */
function validTimestamp(supplied: number | undefined, fallback: number): number {
  return typeof supplied === "number" && Number.isFinite(supplied) && supplied >= 0 ? supplied : fallback;
}

export interface EventEnricherDeps {
  /**
   * Platform-contributed attributes, merged into every event at enrichment time. Deliberately
   * shapeless, since "the current view" is not a core concept — each platform contributes its
   * own view block. Called lazily per event (a value stored at init would go stale) and
   * merged LAST, so a platform's stamp wins over a user attribute of the same name. Contained,
   * so a throwing contributor yields no attributes rather than aborting enrichment.
   */
  enrichAttributes?: () => Record<string, unknown>;
  /**
   * The top-level keys `enrichAttributes` stamps. Surfaces that merge free-form user attributes
   * into an event (the log paths) strip these first, so user input can't collide with the
   * platform's stamp. Platform-supplied because the stamped key set is platform-specific.
   */
  reservedAttributeKeys?: readonly string[];
  /**
   * Host objects attribute flattening must not descend into (their graphs are huge or cyclic
   * through cross-edges back-edge-only cycle detection can't bound). A match is emitted as a
   * `[ConstructorName]` placeholder.
   */
  isOpaqueNode?: (value: unknown) => boolean;
  idGenerator?: IdGenerator;
}

const MAX_FORMAT_DEPTH = 10;

export class EventEnricher {
  private readonly enrichAttributes: (() => Record<string, unknown>) | null;
  private readonly idGenerator: IdGenerator;
  readonly reservedAttributeKeys: readonly string[];
  private readonly isOpaqueNode: ((value: unknown) => boolean) | null;
  private logger = Logger.getInstance();

  constructor(deps: EventEnricherDeps = {}) {
    this.enrichAttributes = deps.enrichAttributes ?? null;
    this.reservedAttributeKeys = deps.reservedAttributeKeys ?? [];
    this.isOpaqueNode = deps.isOpaqueNode ?? null;
    this.idGenerator = deps.idGenerator ?? new RandomIdGenerator();
  }

  // Contained here rather than relying on every caller: enrich() is the single
  // choke point for every event type on every platform, and a throwing
  // contributor must not take the host's instrumentation down with it.
  private getPlatformAttributes(): Record<string, unknown> {
    if (!this.enrichAttributes) return {};
    try {
      return this.enrichAttributes() ?? {};
    } catch (error) {
      this.logger.log(
        "[event-enricher] platform attribute contributor threw; continuing without it",
        error
      );
      return {};
    }
  }

  private formatEventObject(
    obj: Record<string, unknown>,
    prefix = "",
    visited = new WeakSet<object>(),
    depth = 0
  ): Record<string, unknown> {
    try {
      if (depth >= MAX_FORMAT_DEPTH) {
        return { [prefix || "depth_limit"]: "[Depth Limit]" };
      }
      // Keep these inside the try so a predicate, Proxy or getter that throws
      // falls into the format_error fallback instead of bubbling up to the host.
      if (this.isOpaqueNode?.(obj)) {
        return { [prefix || "opaque_node"]: `[${obj?.constructor?.name || "OpaqueNode"}]` };
      }
      if (visited.has(obj)) {
        return { [prefix || "circular_reference"]: "[Circular]" };
      }
      visited.add(obj);

      return Object.entries(obj).reduce((acc, [key, value]) => {
        const newKey = prefix ? `${prefix}.${key}` : key;

        if (typeof value === "object" && value !== null) {
          if (Array.isArray(value)) {
            acc[newKey] = value.map((item, index) => {
              if (typeof item === "object" && item !== null) {
                return this.formatEventObject(item as Record<string, unknown>, `${newKey}[${index}]`, visited, depth + 1);
              }
              return item;
            });
          } else {
            Object.assign(
              acc,
              this.formatEventObject(value as Record<string, unknown>, newKey, visited, depth + 1)
            );
          }
        } else {
          acc[newKey] = value;
        }
        return acc;
      }, {} as Record<string, unknown>);
    } catch (error) {
      this.logger.log("[event-enricher.formatEventObject] Error formatting event object", error);
      return { [prefix || "format_error"]: "[Error formatting object]" };
    } finally {
      visited.delete(obj);
    }
  }

  // Method-generic rather than class-generic: TType is inferred from the
  // event's own `type`, so a platform emitting its own kind gets it through
  // without having to parameterise the enricher at construction.
  enrich<TType extends string = string>(
    event: EnrichInput<TType>
  ): DedupeableEvent<TType> {
    const now = msToNs(Date.now());
    const eventId = this.idGenerator.generateId();
    const spanId = event.spanId || this.idGenerator.generateSpanId();
    const traceId = event.traceId || this.idGenerator.generateTraceId();
    const parentSpanId = event.parentSpanId || "";
    const formattedAttributes = this.formatEventObject(event.attributes || {});

    const platformAttributes = this.getPlatformAttributes();

    const enrichedEvent: DedupeableEvent<TType> = {
      type: event.type,
      id: eventId,
      spanId,
      parentSpanId,
      traceId,
      attributes: {
        ...formattedAttributes,
        ...platformAttributes,
      },
    };

    if (event.span_name) {
      enrichedEvent.span_name = event.span_name;
    }

    if (event.type === "network") {
      enrichedEvent.start_timestamp = validTimestamp(event.timestamp, now);
      enrichedEvent.end_timestamp = event?.end_timestamp;
    } else {
      // A caller may supply the occurrence time (ns) for an event that is
      // reported later than it happened — one captured before the SDK could
      // send it, and replayed afterwards. Defaults to now, mirroring the
      // network branch above.
      enrichedEvent.timestamp = validTimestamp(event.timestamp, now);
    }

    if (event.dedup) this.attachDedup(enrichedEvent, event.dedup, platformAttributes);

    return enrichedEvent;
  }

  // The same error on another page or screen is a different one, so the key
  // also covers where the event happened: whatever block the platform stamps
  // (the web's `location`, React Native's `screen`).
  //
  // Hidden (non-enumerable): never serialized, and not seen when a hook logs or
  // spreads the event. Frozen: a hook can't change the key in place. Left
  // writable, so a strict-mode hook assigning to it doesn't throw (which would
  // drop the event); the pool saved it before the hooks, so that changes
  // nothing. Contained: a key that can't be built means the event never merges.
  private attachDedup(
    event: DedupeableEvent<string>,
    dedup: DedupInfo,
    platformAttributes: Record<string, unknown>
  ): void {
    try {
      const key = hashText(JSON.stringify([dedup.key, platformAttributes]));
      Object.defineProperty(event, "dedup", {
        value: Object.freeze({ key, countAttribute: dedup.countAttribute }),
        writable: true,
        configurable: true,
      });
    } catch (error) {
      this.logger.log("[event-enricher] could not build the dedup key; the event won't merge", error);
    }
  }
}
