import { BaseListener, ListenerDeps } from "@groundcover/rum-core/events/listeners/base-listener";
import { EnrichedEvent } from "@groundcover/rum-core/events/types";
import { PageLoadEventAttributes } from "../types";
import { handleError } from "@groundcover/rum-core/common/error-handler";
import { _globalThis } from "../../common/global";
import { redactUrl } from "@groundcover/rum-core/privacy/redaction";

export class PageLoadListener extends BaseListener {
  private loadEventHandler: () => void;

  constructor(deps: ListenerDeps) {
    super(deps);
    this.loadEventHandler = () => {
      this.logger.log("load event");
      this.handleEvent();
    };
  }

  initialize() {
    try {
      this.logger.log("[page-load-listener.initialize] called");
      this.logger.log("globalThis", _globalThis);
      
      if (_globalThis?.document?.readyState === 'complete') {
        this.logger.log("Page already loaded, triggering event immediately");
        this.handleEvent();
      } else {
        _globalThis?.addEventListener("load", this.loadEventHandler);
      }
    } catch (error) {
      this.logger.log("[page-load-listener.initialize] error", error);
      handleError(error);
    }
  }

  destroy() {
    _globalThis?.removeEventListener("load", this.loadEventHandler);
  }

  handleEvent() {
    try {
      this.logger.log("[page-load-listener.handleEvent] called");

      const event = this.buildEvent();
      this.queueEvent(event);
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent(): EnrichedEvent {
    const navigationEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const loadTime = navigationEntry ? navigationEntry.loadEventEnd - navigationEntry.startTime : 0;
    
    const resources = performance.getEntriesByType('resource');
    
    const resourceStats = {
      count: resources.length,
      totalSize: 0,
      totalDuration: 0,
      byType: {} as Record<string, { count: number; size: number; duration: number }>,
    };

    resources.forEach((resource) => {
      const entry = resource as PerformanceResourceTiming;
      const size = entry.transferSize || 0;
      const duration = entry.duration;
      const type = entry.initiatorType;

      resourceStats.totalSize += size;
      resourceStats.totalDuration += duration;

      if (!resourceStats.byType[type]) {
        resourceStats.byType[type] = { count: 0, size: 0, duration: 0 };
      }
      resourceStats.byType[type].count++;
      resourceStats.byType[type].size += size;
      resourceStats.byType[type].duration += duration;
    });

    // page_url / page_referrer carry query strings — redact sensitive params
    // under the active privacy config (same gate as network URLs).
    const privacy = this.config.getPrivacy();
    const maskUrls = privacy.shouldMaskNetworkQueryParams;
    const urlOpts = {
      sensitiveKeys: privacy.sensitiveKeys,
      redact: privacy.redact,
      kind: "query" as const,
    };
    const pageUrl = _globalThis?.location?.href || "";
    const referrer = _globalThis?.document?.referrer || "";

    const attributes: PageLoadEventAttributes = {
      page_url: maskUrls ? redactUrl(pageUrl, urlOpts) : pageUrl,
      page_load_time: loadTime,
      page_referrer: maskUrls ? redactUrl(referrer, urlOpts) : referrer,
      page_resources: resourceStats,
    };

    return this.enricher.enrich({
      type: "pageload",
      attributes,
    });
  }

  queueEvent(event: EnrichedEvent) {
    try {
      this.logger.log("[page-load-listener.queueEvent] called");

      if (event) {
        this.eventsPool.addEvent(event);
      }
    } catch (error) {
      handleError(error);
    }
  }
}
