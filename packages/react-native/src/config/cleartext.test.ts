import { describe, expect, it } from "vitest";
import { cleartextDsnWarning } from "./cleartext";

/**
 * The case this exists for: a release build against an `http://` DSN sends nothing and says
 * nothing. Android has no `usesCleartextTraffic` outside the debug manifest, iOS ATS refuses
 * plain HTTP, and with ingest responses unchecked the result is indistinguishable from success.
 */
describe("cleartextDsnWarning", () => {
  it("warns about a cleartext DSN in a production bundle", () => {
    const warning = cleartextDsnWarning("http://ingest.example.com/json/rum", false);

    expect(warning).toContain("plain HTTP");
    // Names the endpoint, so the warning identifies WHICH config is wrong.
    expect(warning).toContain("http://ingest.example.com/json/rum");
    // Never re-captured as our own telemetry.
    expect(warning).toContain("groundcoverIgnore");
  });

  it("stays quiet in a development bundle, where cleartext genuinely works", () => {
    // The debug manifest carries usesCleartextTraffic, so this DSN is reachable. Warning here
    // would be false, and a warning people learn to ignore protects nobody.
    expect(cleartextDsnWarning("http://localhost:18026/json/rum", true)).toBeNull();
  });

  it("stays quiet for https, in either build", () => {
    expect(cleartextDsnWarning("https://ingest.example.com/json/rum", false)).toBeNull();
    expect(cleartextDsnWarning("https://ingest.example.com/json/rum", true)).toBeNull();
  });

  /**
   * `getEndpoint()` prefixes a scheme-less DSN with `https://`, so a bare host is already safe by
   * the time it reaches here. Asserted rather than assumed: if that ever changes, a bare DSN would
   * start arriving unprefixed and this would have to decide about it.
   */
  it("stays quiet for an endpoint that carries no scheme at all", () => {
    expect(cleartextDsnWarning("ingest.example.com", false)).toBeNull();
  });

  /**
   * Schemes are case-insensitive per RFC 3986, and a DSN is hand-written config. `HTTP://` is the
   * same risk and a `startsWith("http://")` test alone would wave it through.
   */
  it("recognizes an uppercase scheme", () => {
    expect(cleartextDsnWarning("HTTP://ingest.example.com/json/rum", false)).toContain("plain HTTP");
  });

  /**
   * `https` also starts with the four characters `http`, which is exactly how a naive prefix check
   * on `"http"` would silence every secure DSN — the mistake this pins shut.
   */
  it("does not mistake https for cleartext", () => {
    expect(cleartextDsnWarning("https://http.example.com/json/rum", false)).toBeNull();
  });
});
