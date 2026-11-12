// Browser implementations of the platform touchpoints core consumes as
// injected dependencies. This module is browser-only by design — the React
// Native package provides its own equivalents (AsyncStorage, device metadata,
// current screen/route).
import { PlatformStorage } from "@groundcover/rum-core/common/storage";
import { LocationAttributes } from "@/config/types";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { redactUrl } from "@groundcover/rum-core/privacy/redaction";
import { _globalThis } from "../common/global";
import { handleError } from "@groundcover/rum-core/common/error-handler";

// sessionStorage-backed storage. Accessing `sessionStorage` itself can throw
// (sandboxed iframes) — degrade to null so SafeStorage runs memory-only.
export function getSessionStoragePlatform(): PlatformStorage | null {
  try {
    return typeof globalThis.sessionStorage !== "undefined"
      ? globalThis.sessionStorage
      : null;
  } catch {
    return null;
  }
}

// The web view provider for event enrichment: reads location + document.title
// lazily at event time and derives the FINAL location to stamp. All the
// web-specific derivation lives here, not in core: hash-route detection
// (#/route paths from hash routers) and query-param redaction (path + url are
// stamped on EVERY event; a hash route carries its own query string, so it is
// redacted too, not just url). A factory over the live config so runtime
// privacy updates apply.
export function makeWebViewProvider(
  config: ConfigManager
): () => LocationAttributes {
  return () => {
    // Read the title FIRST, in its own guard. It is the one field that can
    // still be good when location access or redaction blows up, and the
    // no-location branch below preserves it — so the catch-all must not
    // silently throw it away.
    let title = "";
    try {
      title = _globalThis?.document?.title || "";
    } catch (error) {
      handleError(error);
    }

    // Every read below can throw on a hostile or sandboxed page (an
    // instrumented `location` getter, a cross-origin `document`), and
    // `redactUrl`/`getPrivacy` run user-supplied redactors. This provider is
    // called for EVERY event, so it degrades to the empty view rather than
    // letting one bad page break all instrumentation.
    try {
      const location = _globalThis?.location;

      if (!location) {
        // No location but possibly a document title — keep the title.
        return { path: "", url: "", title };
      }

      const isHashRoute =
        location.hash &&
        !location.hash.match(/^#[a-z0-9-]+$/i) &&
        location.hash.startsWith("#/");

      const rawPath = isHashRoute ? location.hash : location.pathname;

      const privacy = config.getPrivacy();
      const shouldRedact = privacy.shouldMaskNetworkQueryParams;
      const urlOpts = {
        sensitiveKeys: privacy.sensitiveKeys,
        redact: privacy.redact,
        kind: "query" as const,
      };
      const path =
        shouldRedact && isHashRoute ? redactUrl(rawPath, urlOpts) : rawPath;
      const url = shouldRedact ? redactUrl(location.href, urlOpts) : location.href;

      return { path, url, title };
    } catch (error) {
      // Report it — a view provider failing on every event is a real signal,
      // not something to swallow — and keep the title we already have.
      handleError(error);
      return { path: "", url: "", title };
    }
  };
}

// UA-derived session device attributes, stamped on every batch envelope.
// Computed lazily at flush time (provider), not once at init, so tests and
// UA-override scenarios observe current values.
export function getWebDeviceAttributes(): {
  userAgent: string;
  browser: {
    name: string;
    version: string;
    platform: string;
    language: string;
    mobile: boolean;
  };
} {
  const userAgent = navigator.userAgent;
  let browser = "unknown";
  let version = "unknown";
  const platform = navigator.platform || "unknown";
  const mobile = /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent);

  if (/Edg/.test(userAgent)) {
    browser = "Edge";
    version = userAgent.match(/Edg\/([\d.]+)/)?.[1] || version;
  } else if (/Chrome/.test(userAgent) && !/Chromium/.test(userAgent)) {
    browser = "Chrome";
    version = userAgent.match(/Chrome\/([\d.]+)/)?.[1] || version;
  } else if (/Firefox/.test(userAgent)) {
    browser = "Firefox";
    version = userAgent.match(/Firefox\/([\d.]+)/)?.[1] || version;
  } else if (/Safari/.test(userAgent) && !/Chrome/.test(userAgent)) {
    browser = "Safari";
    version = userAgent.match(/Version\/([\d.]+)/)?.[1] || version;
  } else if (/Trident/.test(userAgent)) {
    browser = "Internet Explorer";
    if (/rv:([^)]+)\)/i.test(userAgent)) {
      version = userAgent.match(/rv:([^)]+)\)/i)?.[1] || version;
    } else {
      version = userAgent.match(/MSIE ([^;]+)/)?.[1] || version;
    }
  } else if (/OPR/.test(userAgent)) {
    browser = "Opera";
    version = userAgent.match(/OPR\/([\d.]+)/)?.[1] || version;
  }

  return {
    userAgent,
    browser: {
      name: browser,
      version,
      platform,
      language: navigator.language,
      mobile,
    },
  };
}
