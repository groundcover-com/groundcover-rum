import { Logger } from "../../common/logger";

import { EnrichedEvent, CoreEventType } from "../types";
import { EventsPool } from "../events-pool";
import { EventEnricher } from "../event-enricher";
import { ConfigManager } from "../../config/config-manager";

// The dependency bundle every listener receives from the composition root: signal capture is
// the listener's job, while config, enrichment and batching are injected. (The debug Logger
// is the one deliberate ambient exception, a process-wide console wrapper.)
//
// `TExtra` is the platform's own event vocabulary on top of CoreEventType, so a platform
// emitting its own kind wires its pool through without a cast while core's "log"/"custom"
// stay assignable. The default is the open `string`, NOT `never`, so a platform's bare-typed
// fields infer the same argument the constructor does — a `never` default type-checks
// identically but instantiates to a distinct nominal argument those fields reject.
export interface ListenerDeps<TExtra extends string = string> {
  config: ConfigManager;
  eventsPool: EventsPool<CoreEventType | TExtra>;
  enricher: EventEnricher;
}

export abstract class BaseListener<TExtra extends string = string> {
  protected logger = Logger.getInstance();
  protected readonly config: ConfigManager;
  protected readonly eventsPool: EventsPool<CoreEventType | TExtra>;
  protected readonly enricher: EventEnricher;

  constructor(deps: ListenerDeps<TExtra>) {
    this.config = deps.config;
    this.eventsPool = deps.eventsPool;
    this.enricher = deps.enricher;
  }

  abstract handleEvent(...args: unknown[]): void;

  abstract buildEvent(...args: unknown[]): EnrichedEvent<CoreEventType | TExtra>;

  abstract queueEvent(event: EnrichedEvent<CoreEventType | TExtra>): void;

  abstract initialize(): void;
  abstract destroy(): void;
}
