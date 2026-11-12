import { expect, test } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, collectRumBatches, collectedEvents } from "./utils";

/**
 * End-to-end privacy tests: the playground inits the SDK with the default
 * `mask-sensitive` privacy level (+ a custom sensitiveKey `playground_secret`
 * and a `.gc-mask` maskSelector). These specs fire events carrying sensitive
 * data and assert it is redacted across every capture path before it leaves the
 * browser — network bodies / query params / headers, logs, errors, DOM input,
 * and the per-event `location.url`.
 */
const REDACTED = "[REDACTED]";

test.describe("RUM SDK Privacy", () => {
  let playgroundPage: PlaygroundPage;
  let batches: any[];

  test.beforeEach(async ({ page }) => {
    // Collect batches before any event fires.
    batches = collectRumBatches(page);
    await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");
    playgroundPage = new PlaygroundPage(page);
    // NOTE: intentionally NOT calling validatePage() — it clicks "Update Config"
    // which flips the SDK to privacy.level: mask-all. We want the default
    // mask-sensitive level configured in main.tsx.
    await expect(page.getByText("Privacy Testing")).toBeVisible();
  });

  // Wait for the first event matching `predicate` across all collected batches.
  const waitForEvent = async (
    page: import("@playwright/test").Page,
    type: EventType,
    predicate: (e: any) => boolean
  ): Promise<any> => {
    let match: any;
    await expect
      .poll(
        () => {
          match = collectedEvents(batches, type).find(predicate);
          return Boolean(match);
        },
        { timeout: 30000, message: `no ${type} event matched` }
      )
      .toBeTruthy();
    return match;
  };

  test("redacts network request body, query params and headers", async ({ page }) => {
    await playgroundPage.sendSensitiveNetworkRequest();
    await playgroundPage.flushEvents();

    const event = await waitForEvent(page, EventType.NETWORK, (e) =>
      String(e.attributes?.["url.full"] || "").includes("jsonplaceholder")
    );
    const attrs = event.attributes;

    // Query params: sensitive (incl. OAuth code/state) redacted, benign preserved.
    const url = String(attrs["url.full"]);
    expect(url).not.toContain("supersecret");
    expect(url).not.toContain("oauthcode123"); // OAuth ?code=
    expect(url).not.toContain("csrf456"); // OAuth ?state=
    expect(url).toContain("page=2");

    // Request body: sensitive values redacted, benign preserved.
    const body = String(attrs["gc.request.body"]);
    expect(body).toContain("bob"); // username preserved
    expect(body).not.toContain("hunter2"); // password
    expect(body).not.toContain("4111111111111111"); // card_number
    expect(body).not.toContain("deep-token"); // nested.token
    expect(body).not.toContain("body-secret"); // custom sensitiveKey
    expect(body).not.toContain("fixture-write-key-0000000"); // writeKey
    expect(body).toContain(REDACTED);

    // Headers: built-in + custom sensitive headers redacted, content-type kept.
    expect(attrs["http.request.headers.authorization"]).toBe(REDACTED);
    expect(attrs["http.request.headers.x-api-key"]).toBe(REDACTED);
    expect(attrs["http.request.headers.x-functions-key"]).toBe(REDACTED);
    expect(attrs["http.request.headers.playground_secret"]).toBe(REDACTED);
    expect(attrs["http.request.headers.content-type"]).toContain("application/json");
  });

  test("captures and redacts the network response body", async ({ page }) => {
    await playgroundPage.sendSensitiveNetworkRequest();
    await playgroundPage.flushEvents();

    const event = await waitForEvent(page, EventType.NETWORK, (e) =>
      String(e.attributes?.["url.full"] || "").includes("jsonplaceholder")
    );
    // The endpoint echoes the POST payload, so the response body is captured and
    // its sensitive values are redacted like the request body.
    const responseBody = String(event.attributes?.["gc.response.body"] || "");
    expect(responseBody.length).toBeGreaterThan(0);
    expect(responseBody).not.toContain("hunter2");
    expect(responseBody).not.toContain("4111111111111111");
  });

  test("redacts sensitive data in logs (message + attributes)", async ({ page }) => {
    await playgroundPage.logSensitiveData();
    await playgroundPage.flushEvents();

    const event = await waitForEvent(
      page,
      EventType.LOG,
      (e) => typeof e.attributes?.message === "string" && e.attributes.message.startsWith("user login")
    );
    const attrs = event.attributes;

    // Free-text message scrub.
    expect(attrs.message).not.toContain("hunter2");
    expect(attrs.message).not.toContain("abc123");
    expect(attrs.message).toContain(REDACTED);

    // Structured attributes scrub.
    expect(attrs.username).toBe("bob"); // preserved
    expect(attrs.password).toBe(REDACTED);
    expect(attrs.apiKey).toBe(REDACTED);
    expect(attrs.playground_secret).toBe(REDACTED);
  });

  test("redacts sensitive data in errors (message + metadata)", async ({ page }) => {
    await playgroundPage.captureSensitiveError();
    await playgroundPage.flushEvents();

    const event = await waitForEvent(
      page,
      EventType.EXCEPTION,
      (e) =>
        typeof e.attributes?.error_message === "string" &&
        e.attributes.error_message.startsWith("auth failed")
    );
    const attrs = event.attributes;

    // Message free-text scrub.
    expect(attrs.error_message).not.toContain("secret123");
    expect(attrs.error_message).toContain(REDACTED);

    // Metadata scrub: sensitive redacted, benign preserved.
    expect(attrs["error_metadata.userId"]).toBe("bob");
    expect(attrs["error_metadata.password"]).toBe(REDACTED);
    expect(attrs["error_metadata.playground_secret"]).toBe(REDACTED);
  });

  test("masks DOM input text and keystrokes for sensitive fields", async ({ page }) => {
    await playgroundPage.fillSensitiveInput("4111111111111111");
    await playgroundPage.flushEvents();

    // dom_event_target is flattened to dot-keys by enrichEvent.
    const event = await waitForEvent(
      page,
      EventType.DOM_EVENT,
      (e) => e.attributes?.["dom_event_target.id"] === "credit-card"
    );

    // The typed card number must never appear; masked text/keystroke is "*".
    expect(event.attributes["dom_event_target.text"]).toBe("*");
    const allDom = collectedEvents(batches, EventType.DOM_EVENT).filter(
      (e) => e.attributes?.["dom_event_target.id"] === "credit-card"
    );
    for (const e of allDom) {
      expect(e.attributes["dom_event_target.text"]).toBe("*");
      expect(JSON.stringify(e.attributes)).not.toContain("4111111111111111");
    }
  });

  test("redacts query params in location.url stamped on every event", async ({ page }) => {
    await playgroundPage.addSensitiveUrlParam();
    await playgroundPage.flushEvents();

    // location is attached to every event — check it on the flush logs.
    const event = await waitForEvent(
      page,
      EventType.LOG,
      (e) => e.attributes?.location?.url?.includes("localhost") || e.attributes?.location?.url?.includes("page=2")
    );
    const url = String(event.attributes.location.url);
    expect(url).not.toContain("supersecret");
    expect(url).not.toContain("oauthcode123"); // OAuth ?code=
    expect(url).not.toContain("csrf456"); // OAuth ?state=
    expect(url).toContain("page=2");
  });
});
