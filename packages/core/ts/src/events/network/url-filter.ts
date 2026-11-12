import { handleError } from "../../common/error-handler";

export interface IgnoreUrlOptions {
  /** The SDK's own ingest endpoint — its batches are never captured. */
  endpoint?: string | null;
  /** `options.excludedUrls`: a RegExp, a `*`/`?` glob (unanchored), or an exact URL. */
  excludedUrls?: ReadonlyArray<string | RegExp>;
  /** A platform-specific extra filter (the browser drops dev-server module requests). */
  extraIgnore?: (url: string) => boolean;
}

/** Whether a request is left uncaptured: the SDK's own traffic, or excluded by config. */
export function shouldIgnoreUrl(url: string, options: IgnoreUrlOptions): boolean {
  try {
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
