import { onCLS, onLCP, onFCP, onTTFB, onINP, Metric } from "web-vitals";
import { BaseListener } from "@groundcover/rum-core/events/listeners/base-listener";
import { PerformanceEventAttributes } from "@groundcover/rum-core/events/types";
import { BaseEvent } from "@groundcover/rum-core/events/types";
import { handleError } from "@groundcover/rum-core/common/error-handler";

export class PerformanceListener extends BaseListener {
  initialize() {
    onCLS(this.handleEvent);
    onLCP(this.handleEvent);
    onFCP(this.handleEvent);
    onTTFB(this.handleEvent);
    onINP(this.handleEvent);
  }

  destroy() {
  }

  handleEvent = (metric: Metric) => {
    try {
      const fullEvent = this.buildEvent(metric);
      this.queueEvent(fullEvent);
    } catch (error) {
      handleError(error);
    }
  };

  buildEvent(metric: Metric) {
    const event: PerformanceEventAttributes = {
      performance_metric_name: metric.name,
      performance_metric_value: metric.value,
      performance_metric_id: metric.id,
      performance_metric_navigation_type: metric.navigationType || "",
    };

    return this.enricher.enrich({
      type: "performance",
      attributes: event,
    });
  }

  queueEvent(event: BaseEvent) {
    try {
      this.logger.log("[performance-listener.queueEvent] called");

      if (event) {
        this.eventsPool.addEvent(event);
      }
    } catch (error) {
      handleError(error);
    }
  }
}
