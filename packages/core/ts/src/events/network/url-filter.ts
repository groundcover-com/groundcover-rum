import { handleError } from "../../common/error-handler";

export interface IgnoreUrlOptions {
  /** The SDK's own ingest endpoint — its batches are never captured. */
  endpoint?: string | null;
  /** `options.excludedUrls`: a RegExp, a `*`/`?` glob (unanchored), or an exact URL. */
  excludedUrls?: ReadonlyArray<string | RegExp>;
  /** A platform-specific extra filter (the browser drops dev-server module requests). */
  extraIgnore?: (url: string) => boolean;
}

// data: and blob: URLs are read from memory, not the network, so there is no
// request to trace. A data: URL also carries its whole payload in the URL: an
// app that fetches a multi-MB image preview through one would have it copied
// into every URL field of the event, and the page can freeze serializing it.
// Checked first, before the endpoint and excludedUrls scans read the string.
//
// The scheme is matched as the URL parser reads it, so the SDK and the browser
// agree on which requests stay local: the parser strips leading C0 controls and
// spaces (U+0000 to U+0020) and drops tabs and newlines, and nothing else. A
// leading U+00A0, for one, makes a relative path the browser sends over HTTP.
// Only the start of the URL is read, never a whole multi-MB data: URL.
// eslint-disable-next-line no-control-regex -- the parser's "C0 control or space"
const IN_MEMORY_URL = /^[\x00-\x20]*(?:data|blob):/i;
const TAB_OR_NEWLINE = /[\t\n\r]/g;
const SCHEME_WINDOW = 64;

/**
 * Whether a request is left uncaptured: an in-memory data: or blob: URL, the
 * SDK's own traffic, or excluded by config.
 */
export function shouldIgnoreUrl(url: string, options: IgnoreUrlOptions): boolean {
  try {
    if (IN_MEMORY_URL.test(url.slice(0, SCHEME_WINDOW).replace(TAB_OR_NEWLINE, ""))) return true;
    if (options.endpoint && url.includes(options.endpoint)) return true;
    if (options.extraIgnore?.(url)) return true;

    return (options.excludedUrls ?? []).some((pattern) => {
      if (pattern instanceof RegExp) return pattern.test(url);
      if (typeof pattern === "string" && (pattern.includes("*") || pattern.includes("?"))) {
        const regex = new RegExp(
          pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
        );
        return regex.test(url);
      }
      return url === pattern;
    });
  } catch (error) {
    handleError(error);
    return false;
  }
}
