import { describe, expect, it } from "vitest";

import {
  DEVICE_PROPAGATION_URLS,
  DEVICE_TRACE_TARGETS,
  MOCK_API_KEY,
  MOCK_DSN,
  matchesPropagationUrl,
  resolveIngest,
  resolvePreset,
} from "./config-env";

// These two functions decide which config a build boots on and where it posts. Both fail
// SILENTLY on a phone when they are wrong — a defaulted preset or a defaulted DSN produces an
// app that launches, runs, raises nothing and reports nowhere — so each test below is written
// against the specific silent outcome, not against the happy path.

describe("resolvePreset", () => {
  it("prefers the env var so a device build needs no source edit", () => {
    expect(resolvePreset("device", "default")).toBe("device");
  });

  it.each([undefined, "", "   "])("falls back to the compiled-in preset for %o", (value) => {
    // The e2e app scripts pass an EMPTY EXPO_PUBLIC_GC_PRESET precisely to land here, which is
    // what stops a developer's `.env` (EXPO_PUBLIC_GC_PRESET=device) from hijacking a suite
    // run (@expo/env lets an empty shell value win over the file).
    expect(resolvePreset(value, "hang-sampling")).toBe("hang-sampling");
  });

  it("THROWS on an unknown name rather than falling back to default", () => {
    // The whole reason this function exists. Falling back would boot the mock-ingest config
    // against a real cluster: 500ms batches, trace headers to every host, 1s hangs — and
    // nothing on the device would say so. The test that matters is that it is loud.
    expect(() => resolvePreset("devise", "default")).toThrow(/not a known preset/);
  });

  it("names the valid presets in the error, since the failure is always a typo", () => {
    expect(() => resolvePreset("nope", "default")).toThrow(/device/);
  });

  it("trims, so a trailing space in .env selects the preset instead of throwing", () => {
    expect(resolvePreset(" device ", "default")).toBe("device");
  });
});

describe("resolveIngest", () => {
  it("falls back to the mock ingest for e2e presets, so a fresh checkout boots", () => {
    expect(resolveIngest("default", undefined, undefined)).toEqual({
      dsn: MOCK_DSN,
      apiKey: MOCK_API_KEY,
    });
  });

  it.each([
    ["no DSN", undefined, "k", /EXPO_PUBLIC_GC_DSN/],
    ["no API key", "host.example", undefined, /EXPO_PUBLIC_GC_API_KEY/],
    ["neither", "", "", /DSN and EXPO_PUBLIC_GC_API_KEY/],
  ])("refuses to boot the device preset with %s", (_label, dsn, apiKey, expected) => {
    // NOT a style preference. Without this the phone posts to its own localhost:9999 — no
    // error, no dropped-event warning, no data. A device run that appears to succeed and
    // measured nothing costs more than one that never launched.
    expect(() => resolveIngest("device", dsn, apiKey)).toThrow(expected);
  });

  it("rejects a DSN carrying the ingest path", () => {
    // A cluster's setup page shows the full https://host/json/rum, and the transporter
    // appends /json/rum to whatever it is given.
    // The result posts to /json/rum/json/rum and 404s with no other symptom.
    expect(() => resolveIngest("device", "https://ingest.example.invalid/json/rum", "k")).toThrow(
      /HOST only/
    );
    expect(() => resolveIngest("device", "https://host.example/json/rum/", "k")).toThrow(
      /HOST only/
    );
  });

  it("accepts a host whose name merely contains the path's words", () => {
    // Guards the regex against being loosened to a bare `includes("/json/rum")`, which would
    // reject legitimate hosts.
    expect(resolveIngest("device", "https://json.rum.example.com", "k").dsn).toBe(
      "https://json.rum.example.com"
    );
  });

  it("passes a bare host through — the SDK upgrades it to https", () => {
    expect(resolveIngest("device", "ingest.example.invalid", "k")).toEqual({
      dsn: "ingest.example.invalid",
      apiKey: "k",
    });
  });

  it("trims both values, so a stray newline in .env is not part of the API key", () => {
    // An apiKey with a trailing newline is rejected by the ingest as an auth failure, which
    // looks nothing like a whitespace bug from the device side.
    expect(resolveIngest("device", " host.example\n", " key123\n")).toEqual({
      dsn: "host.example",
      apiKey: "key123",
    });
  });

  it("leaves the path check to the device preset only", () => {
    // The e2e mock ingest is addressed as a bare host:port and never trips this, but scoping
    // the guard keeps a future e2e DSN shape from being rejected at launch.
    expect(resolveIngest("default", "http://localhost:9393/json/rum", "e2e-key").dsn).toBe(
      "http://localhost:9393/json/rum"
    );
  });
});

describe("device trace propagation", () => {
  // The failure this guards against ships no error: the SDK anchors each propagation pattern
  // `^…$` against the FULL request URL, so a bare host matches nothing and every device-run
  // request goes out WITHOUT a `traceparent`. The only way to see it is to inspect a stored
  // request, so it lives here as an assertion over the two lists.

  it("injects a traceparent into every URL the device build actually calls", () => {
    for (const url of Object.values(DEVICE_TRACE_TARGETS)) {
      expect(matchesPropagationUrl(DEVICE_PROPAGATION_URLS, url)).toBe(true);
    }
  });

  it("a bare host pattern matches no real URL", () => {
    // "httpbin.org" compiles to ^httpbin.org$, which cannot match https://httpbin.org/anything.
    expect(matchesPropagationUrl(["httpbin.org"], DEVICE_TRACE_TARGETS.echo)).toBe(false);
  });

  it("does not inject into unrelated third-party hosts", () => {
    // The reason the patterns stay bounded to the two known hosts rather than "*": a device build
    // must not leak trace headers to arbitrary origins the app happens to call.
    expect(matchesPropagationUrl(DEVICE_PROPAGATION_URLS, "https://analytics.evil.example/beacon")).toBe(
      false
    );
    // A SUFFIX lookalike is stopped by the trailing `/`: after the host the pattern needs a literal
    // slash, and this URL has more host there instead.
    expect(
      matchesPropagationUrl(DEVICE_PROPAGATION_URLS, "https://httpbin.org.evil.example/x")
    ).toBe(false);
  });

  it("is not a strict host match — a single-glyph substitution still matches (mirrors production)", () => {
    // Documented, not aspirational: the SDK widens only `*` and does not escape the `.`, so the dot
    // in `httpbin.org` matches any character. This helper mirrors `shouldAddTraceHeader` exactly, so
    // it inherits that looseness rather than "fixing" it and lying about what production does. It is
    // harmless in practice — the app only ever calls the two literal DEVICE_TRACE_TARGETS.
    expect(matchesPropagationUrl(DEVICE_PROPAGATION_URLS, "https://httpbinXorg/anything")).toBe(true);
  });
});
