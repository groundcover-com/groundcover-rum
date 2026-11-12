import { describe, it, expect } from "vitest";
import { shouldIgnoreUrl } from "./url-filter";

describe("shouldIgnoreUrl", () => {
  it("ignores the SDK's own ingest endpoint", () => {
    expect(shouldIgnoreUrl("https://ingest.example/json/rum", { endpoint: "https://ingest.example" })).toBe(true);
    expect(shouldIgnoreUrl("https://api.example/x", { endpoint: "https://ingest.example" })).toBe(false);
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
