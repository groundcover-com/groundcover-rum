import { expect, test, type Page } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, collectRumBatches, collectedEvents } from "./utils";

/**
 * E2E coverage for the full privacy config surface. The playground reads a
 * base64 `?gcp=` override (see main.tsx) so each test boots the SDK with a
 * specific privacy config, fires the relevant events, and asserts what is
 * redacted vs preserved.
 *
 * Levels: allow / mask-all (+ mask-sensitive via privacy.spec.ts).
 * Toggles: maskNetworkBodies / maskNetworkQueryParams / maskLogs / maskErrors.
 * Keys: custom sensitiveKeys + maskSelectors.
 * Hooks: custom redact (maskTextFn/maskInputFn are rrweb-only → unit-tested,
 * replay payloads are opaque in e2e).
 */
const REDACTED = "[REDACTED]";
const BASE = process.env.PLAYGROUND_URL || "http://localhost:4173";

function urlFor(config: Record<string, unknown>): string {
  const gcp = Buffer.from(JSON.stringify(config)).toString("base64");
  return `${BASE}/?gcp=${encodeURIComponent(gcp)}`;
}

async function boot(page: Page, config: Record<string, unknown>) {
  const batches = collectRumBatches(page);
  await page.goto(urlFor(config));
  const pg = new PlaygroundPage(page);
  await expect(page.getByText("Privacy Testing")).toBeVisible();
  return { batches, pg };
}

async function waitForEvent(
  batches: any[],
  type: EventType,
  predicate: (e: any) => boolean
): Promise<any> {
  let match: any;
  await expect
    .poll(() => {
      match = collectedEvents(batches, type).find(predicate);
      return Boolean(match);
    }, { timeout: 30000, message: `no ${type} event matched` })
    .toBeTruthy();
  return match;
}

const networkEvent = (batches: any[]) =>
  waitForEvent(batches, EventType.NETWORK, (e) =>
    String(e.attributes?.["url.full"] || "").includes("jsonplaceholder")
  );
const logEvent = (batches: any[]) =>
  waitForEvent(batches, EventType.LOG, (e) =>
    typeof e.attributes?.message === "string" && e.attributes.message.startsWith("user login")
  );
const errorEvent = (batches: any[]) =>
  waitForEvent(batches, EventType.EXCEPTION, (e) =>
    typeof e.attributes?.error_message === "string" && e.attributes.error_message.startsWith("auth failed")
  );
const domEventsFor = (batches: any[], id: string) =>
  collectedEvents(batches, EventType.DOM_EVENT).filter(
    (e) => e.attributes?.["dom_event_target.id"] === id
  );

test.describe("RUM SDK Privacy — config matrix", () => {
  test("level 'allow' disables redaction (but always-sensitive headers stay stripped)", async ({ page }) => {
    const { batches, pg } = await boot(page, { privacy: { level: "allow" } });
    await pg.sendSensitiveNetworkRequest();
    await pg.logSensitiveData();
    await pg.captureSensitiveError();
    await pg.fillSensitiveInput("4111111111111111");
    await pg.clickStaticLabel();
    await pg.addSensitiveUrlParam();
    await pg.flushEvents();

    const net = await networkEvent(batches);
    // Body + query NOT redacted under allow…
    expect(String(net.attributes["gc.request.body"])).toContain("hunter2");
    expect(String(net.attributes["url.full"])).toContain("supersecret");
    // …but built-in sensitive headers are ALWAYS stripped, even under allow.
    expect(net.attributes["http.request.headers.authorization"]).toBe(REDACTED);

    const log = await logEvent(batches);
    expect(log.attributes.message).toContain("hunter2");
    expect(log.attributes.password).toBe("hunter2");

    const err = await errorEvent(batches);
    expect(err.attributes.error_message).toContain("secret123");

    // DOM input not masked → real key codes captured; static text visible.
    const cc = domEventsFor(batches, "credit-card");
    expect(cc.length).toBeGreaterThan(0);
    expect(cc.some((e) => /^[0-9]$/.test(e.attributes["dom_event_key_code"]))).toBe(true);
    const label = domEventsFor(batches, "static-label");
    expect(label.some((e) => e.attributes["dom_event_target.text"] === "VisibleStaticText")).toBe(true);
  });

  test("level 'mask-all' redacts everything mask-sensitive does, plus static text", async ({ page }) => {
    const { batches, pg } = await boot(page, { privacy: { level: "mask-all" } });
    await pg.clickStaticLabel();
    await pg.fillSensitiveInput("4111111111111111");
    await pg.sendSensitiveNetworkRequest();
    await pg.logSensitiveData();
    await pg.captureSensitiveError();
    await pg.addSensitiveUrlParam();
    await pg.flushEvents();

    // Network: body, query and headers all redacted (same as mask-sensitive).
    const net = await networkEvent(batches);
    expect(String(net.attributes["gc.request.body"])).not.toContain("hunter2");
    expect(String(net.attributes["url.full"])).not.toContain("supersecret");
    expect(net.attributes["http.request.headers.authorization"]).toBe(REDACTED);

    // Logs + errors redacted.
    const log = await logEvent(batches);
    expect(log.attributes.message).not.toContain("hunter2");
    expect(log.attributes.password).toBe(REDACTED);
    const err = await errorEvent(batches);
    expect(err.attributes.error_message).not.toContain("secret123");

    // location.url redacted.
    expect(String(net.attributes["url.full"])).not.toContain("oauthcode123");

    // The mask-all distinction over mask-sensitive: ALL inputs and even
    // static (non-input) text are masked — not just the sensitive ones.
    await expect.poll(() => domEventsFor(batches, "static-label").length).toBeGreaterThan(0);
    expect(domEventsFor(batches, "static-label").every((e) => e.attributes["dom_event_target.text"] === "*")).toBe(true);
    const cc = domEventsFor(batches, "credit-card");
    expect(cc.every((e) => e.attributes["dom_event_target.text"] === "*")).toBe(true);
  });

  test("level 'mask-sensitive' masks sensitive inputs but captures non-secret ones", async ({ page }) => {
    const { batches, pg } = await boot(page, { privacy: { level: "mask-sensitive" } });
    await pg.fillSensitiveInput("4111111111111111"); // #credit-card → sensitive by id
    await pg.fillAcctInput("search"); // #acct → not matched by any sensitive pattern
    await pg.clickStaticLabel();
    await pg.flushEvents();

    // Sensitive input: keystrokes masked, real digits never captured.
    await expect.poll(() => domEventsFor(batches, "credit-card").length).toBeGreaterThan(0);
    const cc = domEventsFor(batches, "credit-card");
    expect(cc.some((e) => e.attributes["dom_event_key_code"] === "*")).toBe(true);
    expect(cc.some((e) => /^[0-9]$/.test(e.attributes["dom_event_key_code"]))).toBe(false);

    // Non-secret input: real key codes captured (mask-sensitive masks only
    // sensitive inputs, not every input).
    await expect.poll(() => domEventsFor(batches, "acct").length).toBeGreaterThan(0);
    const acct = domEventsFor(batches, "acct");
    expect(acct.some((e) => /^[a-z]$/i.test(e.attributes["dom_event_key_code"]))).toBe(true);
    expect(acct.every((e) => e.attributes["dom_event_key_code"] !== "*")).toBe(true);

    // Static (non-input) text still visible.
    const label = domEventsFor(batches, "static-label");
    expect(label.some((e) => e.attributes["dom_event_target.text"] === "VisibleStaticText")).toBe(true);
  });

  test("level 'mask-sensitive' masks inputs whose sensitivity is declared on an ANCESTOR", async ({ page }) => {
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", maskSelectors: [".gc-mask"] },
    });
    // Both inputs have benign ids/labels; only their wrappers are sensitive
    // (data-private / .gc-mask). They must still be masked.
    await pg.fillNestedInput("nested-private", "topsecret");
    await pg.fillNestedInput("nested-mask", "alsosecret");
    await pg.flushEvents();

    for (const id of ["nested-private", "nested-mask"]) {
      await expect.poll(() => domEventsFor(batches, id).length).toBeGreaterThan(0);
      const events = domEventsFor(batches, id);
      // Keystrokes masked; the typed letters never appear.
      expect(events.some((e) => e.attributes["dom_event_key_code"] === "*")).toBe(true);
      expect(events.some((e) => /^[a-z]$/i.test(e.attributes["dom_event_key_code"]))).toBe(false);
    }
  });

  test("maskNetworkBodies:false keeps bodies but still redacts query + headers", async ({ page }) => {
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", maskNetworkBodies: false },
    });
    await pg.sendSensitiveNetworkRequest();
    await pg.flushEvents();

    const net = await networkEvent(batches);
    expect(String(net.attributes["gc.request.body"])).toContain("hunter2"); // body NOT redacted
    expect(String(net.attributes["url.full"])).not.toContain("supersecret"); // query still redacted
    expect(net.attributes["http.request.headers.authorization"]).toBe(REDACTED); // headers still redacted
  });

  test("maskNetworkQueryParams:false keeps query but still redacts bodies", async ({ page }) => {
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", maskNetworkQueryParams: false },
    });
    await pg.sendSensitiveNetworkRequest();
    await pg.flushEvents();

    const net = await networkEvent(batches);
    expect(String(net.attributes["url.full"])).toContain("supersecret"); // query NOT redacted
    expect(String(net.attributes["gc.request.body"])).not.toContain("hunter2"); // body still redacted
  });

  test("maskLogs:false keeps log content", async ({ page }) => {
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", maskLogs: false },
    });
    await pg.logSensitiveData();
    await pg.flushEvents();

    const log = await logEvent(batches);
    expect(log.attributes.message).toContain("hunter2");
    expect(log.attributes.password).toBe("hunter2");
  });

  test("maskErrors:false keeps error content", async ({ page }) => {
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", maskErrors: false },
    });
    await pg.captureSensitiveError();
    await pg.flushEvents();

    const err = await errorEvent(batches);
    expect(err.attributes.error_message).toContain("secret123");
    expect(err.attributes["error_metadata.password"]).toBe("hunter2");
  });

  test("custom sensitiveKeys redacts an otherwise-benign key", async ({ page }) => {
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", sensitiveKeys: ["username"] },
    });
    await pg.sendSensitiveNetworkRequest();
    await pg.flushEvents();

    const net = await networkEvent(batches);
    const body = String(net.attributes["gc.request.body"]);
    expect(body).not.toContain("bob"); // username now redacted via custom key
    expect(body).toContain(REDACTED);
  });

  test("custom redact hook overrides a field per leaf (and defers elsewhere)", async ({ page }) => {
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", redactorName: "marker" },
    });
    await pg.sendSensitiveNetworkRequest();
    await pg.flushEvents();

    const net = await networkEvent(batches);
    const body = JSON.parse(String(net.attributes["gc.request.body"]));
    // The hook overrode the `username` leaf (normally preserved as "bob")…
    expect(body.username).toBe("CUSTOM_REDACTED");
    // …and deferred elsewhere, so built-in redaction still applied.
    expect(body.password).toBe(REDACTED);
  });

  test("mask-all masks all text and redacts bodies", async ({ page }) => {
    const { batches, pg } = await boot(page, { privacy: { level: "mask-all" } });
    await pg.clickStaticLabel();
    await pg.sendSensitiveNetworkRequest();
    await pg.flushEvents();

    await expect.poll(() => domEventsFor(batches, "static-label").length).toBeGreaterThan(0);
    expect(domEventsFor(batches, "static-label").every((e) => e.attributes["dom_event_target.text"] === "*")).toBe(true);
    const net = await networkEvent(batches);
    expect(String(net.attributes["gc.request.body"])).not.toContain("hunter2");
  });

  test("allow keeps bodies but still strips auth headers", async ({ page }) => {
    const { batches, pg } = await boot(page, { privacy: { level: "allow" } });
    await pg.sendSensitiveNetworkRequest();
    await pg.flushEvents();

    const net = await networkEvent(batches);
    expect(String(net.attributes["gc.request.body"])).toContain("hunter2"); // not redacted
    expect(net.attributes["http.request.headers.authorization"]).toBe(REDACTED); // still stripped
  });

  test("maskSelectors masks a matched non-input element (selector path only)", async ({ page }) => {
    // #static-label is a button (not an input) and not built-in-sensitive, so at
    // mask-sensitive it is masked ONLY because it matches maskSelectors — this
    // isolates the selector path from the input-level / built-in rules.
    const { batches, pg } = await boot(page, {
      privacy: { level: "mask-sensitive", maskSelectors: ["#static-label"] },
    });
    await pg.clickStaticLabel();
    await pg.flushEvents();

    await expect.poll(() => domEventsFor(batches, "static-label").length).toBeGreaterThan(0);
    expect(domEventsFor(batches, "static-label").every((e) => e.attributes["dom_event_target.text"] === "*")).toBe(true);
  });
});
