import { EnrichedEvent } from "@groundcover/rum-core/events/types";
import { NavigationEventAttributes } from "../types";

import { handleError } from "@groundcover/rum-core/common/error-handler";
import { _globalThis } from "../../common/global";
import { redactMetadata, redactUrl } from "@groundcover/rum-core/privacy/redaction";

import { BaseListener, ListenerDeps } from "@groundcover/rum-core/events/listeners/base-listener";
import { PatchSet, type PatchSpec } from "@groundcover/rum-core/common/patch";

export class NavigationListener extends BaseListener {
  private currentUrl: string = '';
  // Our pushState/replaceState wrappers. destroy() restores a method only where
  // it is still ours, so a router that wrapped us on top keeps its wrapper.
  private patches = new PatchSet();
  private isInitialized: boolean = false;
  private isAutomaticNavigationEnabled: boolean = false;

  private activeNavigation: {
    page_url: string;
    metadata: Record<string, unknown>;
    startTime: number;
    endTime: number;
    duration_ms: number;
  } | null = null;
  
  private popStateHandler = () => {
    this.handleLocationChange();
  };
  
  private hashChangeHandler = () => {
    this.handleLocationChange();
  };

  constructor(deps: ListenerDeps, { isEnabled }: { isEnabled: boolean }) {
    super(deps);
    
    if (this.isInBrowserEnvironment() && isEnabled) {
      try {
        this.isAutomaticNavigationEnabled = isEnabled;
        this.currentUrl = _globalThis.location.href;
      } catch (error) {
        handleError(error);
      }
    }
  }

  private isInBrowserEnvironment(): boolean {
    try {
      return typeof _globalThis !== 'undefined' && 
             typeof _globalThis.location !== 'undefined' && 
             typeof _globalThis.history !== 'undefined' &&
             typeof _globalThis.addEventListener === 'function';
    } catch (error) {
      handleError(error);
      return false;
    }
  }

  initialize() {
    try {
      this.logger.log("[navigation-listener.initialize] called");

      if (!this.isInBrowserEnvironment() ||
          typeof history.pushState !== 'function' ||
          typeof history.replaceState !== 'function') {
        this.logger.log("[navigation-listener.initialize] Browser environment not available, skipping initialization");
        return;
      }

      if (!this.isAutomaticNavigationEnabled) {
        this.logger.log("[navigation-listener.initialize] Automatic navigation is disabled, skipping initialization");
        return;
      }

      this.patches.install([
        this.historyPatch("pushState"),
        this.historyPatch("replaceState"),
      ]);

      if (_globalThis && typeof _globalThis.addEventListener === 'function') {
        _globalThis.addEventListener('popstate', this.popStateHandler);
        _globalThis.addEventListener('hashchange', this.hashChangeHandler);
      }

      this.isInitialized = true;
    } catch (error) {
      handleError(error);
    }
  }

  private historyPatch(method: "pushState" | "replaceState"): PatchSpec<History["pushState"]> {
    return {
      get: () => history[method],
      set: (fn) => {
        history[method] = fn;
      },
      wrap: (original) => (...args) => {
        const result = original.apply(history, args);
        this.handleLocationChange();
        return result;
      },
    };
  }

  destroy() {
    try {
      this.logger.log("[navigation-listener.destroy] called");
      
      // Unwrap only where WE are still the current history method — restoring
      // the pre-SDK original under a router would silently uninstall the
      // router's own instrumentation. A wrapper left reachable through the
      // router goes inert: handleLocationChange needs isInitialized.
      this.patches.restore();

      if (_globalThis && typeof _globalThis.removeEventListener === 'function') {
        _globalThis.removeEventListener('popstate', this.popStateHandler);
        _globalThis.removeEventListener('hashchange', this.hashChangeHandler);
      }

      this.isInitialized = false;
    } catch (error) {
      handleError(error);
    }
  }

  handleEvent() {
    try {
      this.logger.log("[navigation-listener.handleEvent] called");

      const event = this.buildEvent();
      this.queueEvent(event);
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent(): EnrichedEvent  {
    this.logger.log("[navigation-listener.buildEvent] called", _globalThis.location.href);

    // Redact sensitive query params in the URL and any sensitive keys in
    // user-supplied navigation metadata, under the active privacy config.
    const privacy = this.config.getPrivacy();
    const pageUrl = _globalThis.location.href;
    const metadata = this.activeNavigation?.metadata;

    const attributes: NavigationEventAttributes = {
      page_url: privacy.shouldMaskNetworkQueryParams
        ? redactUrl(pageUrl, {
            sensitiveKeys: privacy.sensitiveKeys,
            redact: privacy.redact,
            kind: "query",
          })
        : pageUrl,
      // Unlike page_url (URL semantics → maskNetworkQueryParams), metadata is
      // arbitrary user data, redacted whenever masking is on.
      metadata: redactMetadata(metadata, privacy),
      duration_ms: this.activeNavigation?.duration_ms || 0,
      start_timestamp: this.activeNavigation?.startTime || 0,
      end_timestamp: this.activeNavigation?.endTime || 0,
    };

    return this.enricher.enrich({
      type: "navigation",
      attributes,
    });
  }

  queueEvent(event: EnrichedEvent) {
    try {
      this.logger.log("[navigation-listener.queueEvent] called");

      if (event) {
        this.eventsPool.addEvent(event);
      }
    } catch (error) {
      handleError(error);
    }
  }

  // startNavigation/endNavigation are the MANUAL navigation API, reachable
  // straight from customer code via groundcover.startNavigation(). Like the
  // automatic path (handleLocationChange), both are contained: a throwing
  // `location` getter — or anything else going wrong in here — would otherwise
  // propagate out of the SDK and into the caller's own call stack. The SDK must
  // never crash its host, least of all through its public surface.
  startNavigation(metadata: Record<string, unknown>) {
    try {
      this.logger.log("[navigation-listener.startNavigation] called", metadata);

      this.activeNavigation = {
        page_url: _globalThis?.location?.href || "",
        metadata,
        startTime: Date.now(),
        endTime: 0,
        duration_ms: 0,
      };
    } catch (error) {
      handleError(error);
    }
  }

  endNavigation(metadata: Record<string, unknown>) {
    try {
      this.logger.log("[navigation-listener.endNavigation] called", metadata);

      if (!this.activeNavigation) {
        this.logger.log("[navigation-listener.endNavigation] no active navigation found");
        return;
      }

      this.logger.log("[navigation-listener.endNavigation] active navigation", this.activeNavigation);
      this.activeNavigation.endTime = Date.now();
      this.activeNavigation.duration_ms = this.activeNavigation.endTime - this.activeNavigation.startTime;

      this.handleEvent();
    } catch (error) {
      handleError(error);
    }
  }
  
  private handleLocationChange() {
    try {
      if (!this.isInitialized) {
        return;
      }

      this.logger.log("[navigation-listener.handleLocationChange] called");
      
      if (this.currentUrl === _globalThis.location.href) {
        return;
      }

      let newUrl: URL;
      let currentUrl: URL;
      
      try {
        newUrl = new URL(_globalThis.location.href);
        currentUrl = new URL(this.currentUrl);
      } catch (error) {
        handleError(error);
        return;
      }

      const isHashRouting = (hash: string) => hash.startsWith('#/');
      const isHashRoutingChange = isHashRouting(newUrl.hash) || isHashRouting(currentUrl.hash);

      if (newUrl.pathname !== currentUrl.pathname || 
          (isHashRoutingChange && newUrl.hash !== currentUrl.hash)) {
        this.currentUrl = _globalThis.location.href;
        this.handleEvent();
      }
    } catch (error) {
      handleError(error);
    }
  }
}
