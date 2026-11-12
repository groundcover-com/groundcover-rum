import { Logger } from "../common/logger";
import { handleError } from "../common/error-handler";
import { truncate } from "../common/text";
import { redactLogFields } from "../privacy/redaction";
import { ConfigManager } from "../config/config-manager";
import { EventsPool } from "./events-pool";
import { EventEnricher } from "./event-enricher";
import { CoreEventType, LogLevel } from "./types";

// `TExtra` (default `string` — see base-listener.ts for why not `never`)
// lets a platform hand in its OWN pool type (`EventsPool<CoreEventType |
// TExtra>`) without a cast. The emitter itself only ever produces the shared
// `"custom"` and `"log"` kinds, so the parameter exists purely to keep the pool
// type compatible with the platform's listeners.
export interface ManualEventEmitterDeps<TExtra extends string = string> {
  config: ConfigManager;
  pool: EventsPool<CoreEventType | TExtra>;
  enricher: EventEnricher;
}

// The manual (public-API) event surface: groundcover.sendCustomEvent and
// groundcover.logger.*. Owns the reserved-key stripping and redaction
// contract so every platform's public API emits identical events.
export class ManualEventEmitter<TExtra extends string = string> {
  private logger = Logger.getInstance();
  private readonly config: ConfigManager;
  private readonly pool: EventsPool<CoreEventType | TExtra>;
  private readonly enricher: EventEnricher;

  constructor(deps: ManualEventEmitterDeps<TExtra>) {
    this.config = deps.config;
    this.pool = deps.pool;
    this.enricher = deps.enricher;
  }

  sendCustomEvent(event: {
    event: string;
    attributes: Record<string, unknown>;
  }) {
    this.logger.log("[manual-event-emitter.sendCustomEvent] called", event);

    try {
      const enrichedEvent = this.enricher.enrich({
        type: "custom",
        attributes: {
          custom_event_name: event?.event,
          custom_event_attributes: event?.attributes,
        },
      });

      this.pool.addEvent(enrichedEvent);
    } catch (error) {
      handleError(error);
    }
  }

  emitLog(
    message: string,
    level: LogLevel,
    attributes?: Record<string, unknown>
  ) {
    this.logger.log("[manual-event-emitter.emitLog] called", {
      message,
      level,
      attributes,
    });

    try {
      // Strip reserved log-attribute keys so user input cannot collide with
      // values stamped later (message/level here, the platform's keys in
      // enrichment).
      const userAttributes = { ...(attributes || {}) };
      delete userAttributes.message;
      delete userAttributes.level;
      for (const key of this.enricher.reservedAttributeKeys) delete userAttributes[key];

      // Apply the same log masking the console-capture listener uses, so
      // groundcover.logger.* honors the privacy contract too (it bypasses that
      // listener entirely).
      const { message: safeMessage, attributes: safeAttributes } = redactLogFields(
        this.config.getPrivacy(),
        message,
        userAttributes
      );

      const enrichedEvent = this.enricher.enrich({
        type: "log",
        attributes: {
          ...safeAttributes,
          message: truncate({ text: safeMessage }),
          level,
        },
      });

      this.pool.addEvent(enrichedEvent);
    } catch (error) {
      handleError(error);
    }
  }
}
