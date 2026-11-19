import { describe, it, expect } from "vitest";
import { shouldIgnoreUrl } from "./url-filter";

describe("shouldIgnoreUrl", () => {
  it("ignores the SDK's own ingest endpoint", () => {
    expect(shouldIgnoreUrl("https://ingest.example/json/rum", { endpoint: "https://ingest.example" })).toBe(true);
    expect(shouldIgnoreUrl("https://api.example/x", { endpoint: "https://ingest.example" })).toBe(false);
  });

  it("ignores data: and blob: URLs, which are read from memory, with no config", () => {
    expect(shouldIgnoreUrl("data:image/png;base64,iVBORw0KGgo=", {})).toBe(true);
    expect(shouldIgnoreUrl("DATA:text/plain,hello", {})).toBe(true);
    expect(shouldIgnoreUrl(" data:text/plain,hello", {})).toBe(true);
    expect(shouldIgnoreUrl("blob:https://app.example/9f1c2e6a-1d2b-4c1e-9a7f-2b6f0d1e3c4a", {})).toBe(true);
    // The scheme must lead: the same words in a path or a query are ordinary URLs.
    expect(shouldIgnoreUrl("https://example.com/data:x", {})).toBe(false);
    expect(shouldIgnoreUrl("https://example.com/?next=blob:x", {})).toBe(false);
    expect(shouldIgnoreUrl("/blob/1", {})).toBe(false);
  });

  it("reads the scheme as the URL parser does", () => {
    // Stripped or dropped by the parser, so these are still data: and blob: URLs.
    expect(shouldIgnoreUrl("\tdata:text/plain,hello", {})).toBe(true);
    expect(shouldIgnoreUrl("\u0001 blob:https://app.example/1", {})).toBe(true);
    expect(shouldIgnoreUrl("da\nt\ra:text/plain,hello", {})).toBe(true);
    // Not stripped: each is a relative path the browser requests over HTTP.
    expect(shouldIgnoreUrl("\u00a0data:release-notes", {})).toBe(false);
    expect(shouldIgnoreUrl("\ufeffdata:release-notes", {})).toBe(false);
    expect(shouldIgnoreUrl("\u3000blob:release-notes", {})).toBe(false);
  });

  it("ignores exact excludedUrls matches only", () => {
    const excludedUrls = ["/api/health", "https://example.com/metrics"];
    expect(shouldIgnoreUrl("/api/health", { excludedUrls })).toBe(true);
    expect(shouldIgnoreUrl("https://example.com/metrics", { excludedUrls })).toBe(true);
    expect(shouldIgnoreUrl("/api/health/details", { excludedUrls })).toBe(false);
    expect(shouldIgnoreUrl("https://example.com/metrics/daily", { excludedUrls })).toBe(false);
  });

  it("ignores RegExp matches", () => {
    const excludedUrls = [/^\/api\/v[0-9]+\//, /\.(jpg|png|gif)$/i];
    expect(shouldIgnoreUrl("/api/v1/users", { excludedUrls })).toBe(true);
    expect(shouldIgnoreUrl("https://example.com/image.PNG", { excludedUrls })).toBe(true);
    expect(shouldIgnoreUrl("/api/users", { excludedUrls })).toBe(false);
    expect(shouldIgnoreUrl("https://example.com/image.svg", { excludedUrls })).toBe(false);
  });

  it("treats a `*` glob as an unanchored wildcard with literal metacharacters", () => {
    const excludedUrls = ["https://cdn.example.com/*"];
    expect(shouldIgnoreUrl("https://cdn.example.com/a.js", { excludedUrls })).toBe(true);
    expect(shouldIgnoreUrl("https://cdn-example.com/a.js", { excludedUrls })).toBe(false);
  });

  it("applies the platform's extra filter", () => {
    const extraIgnore = (url: string) => url.endsWith(".css");
    expect(shouldIgnoreUrl("https://example.com/a.css", { extraIgnore })).toBe(true);
    expect(shouldIgnoreUrl("https://example.com/a.js", { extraIgnore })).toBe(false);
  });

  it("never throws — a failing filter captures the request", () => {
    const extraIgnore = () => {
      throw new Error("boom");
    };
    expect(shouldIgnoreUrl("/x", { extraIgnore })).toBe(false);
  });
});
