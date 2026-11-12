import { test, expect } from "@mobilewright/test";
import { clearEvents, expectEvents, waitForEvents, getEvents } from "../support/ingest-client";
import { app } from "../support/app";

test.describe("rn-playground — logs, custom events, identity", () => {
  test.beforeEach(async () => {
    await clearEvents();
  });

  test("logger.info is captured as a log event", async ({ screen }) => {
    // Arrange: go to the Logs screen.
    await screen.getByLabel("Logs tab").tap();

    // Act: invoke the explicit logger.info API.
    await screen.getByText("logger.info").tap();

    // Assert: an info-level log event is captured.
    const [log] = await waitForEvents("log", {
      where: (e) => String((e.attributes as Record<string, unknown>)?.message ?? "").includes("logger.info"),
    });
    expect(log).toBeTruthy();
    expect((log!.attributes as Record<string, unknown>)?.level).toBe("info");
  });

  test(`${app.platformLog.button} is auto-captured as a log event`, async ({ screen }) => {
    // Arrange: go to the Logs screen.
    await screen.getByLabel("Logs tab").tap();

    // Act: log through the platform's own logging, not the SDK's API: console.log on RN, a
    // global console monkeypatch (core's LogEventsListener) that only runs meaningfully against
    // the real Hermes/LogBox console; debugPrint on Flutter, which the SDK wraps. Either is a
    // different code path from the explicit logger.* API above.
    await screen.getByText(app.platformLog.button).tap();

    // Assert: it is captured end to end as a log event.
    await expectEvents("log", {
      where: (e) =>
        String((e.attributes as Record<string, unknown>)?.message ?? "").includes(app.platformLog.message),
      describe: `a log with "${app.platformLog.message}"`,
    });
  });

  test("console.error is auto-captured as an error-level log", { tag: "@rn-only" }, async ({ screen }) => {
    // Arrange: go to the Logs screen.
    await screen.getByLabel("Logs tab").tap();

    // Act: trigger a console.error.
    await screen.getByText("console.error").tap();

    // Assert: it is captured as an error-level log event.
    const [log] = await waitForEvents("log", {
      where: (e) =>
        String((e.attributes as Record<string, unknown>)?.message ?? "").includes("playground console.error"),
    });
    expect(log).toBeTruthy();
    expect((log!.attributes as Record<string, unknown>)?.level).toBe("error");
  });

  test("the SDK's own console output never feeds back into log capture", async ({ screen }) => {
    // The console listener patches console.log, and the SDK logs through the
    // same console — so without the `groundcoverIgnore` marker the transporter's
    // own "Sending batch:" line becomes a log event, which is queued, which
    // produces a batch, which logs again. A feedback loop, not a cosmetic leak.
    //
    // The playground runs with `debug: true`, so that line is emitted on EVERY
    // flush and this assertion is exercised on every run. Searching captured
    // messages for the literal string "groundcoverIgnore" would find nothing,
    // because the marker on that call is an OBJECT argument rather than text, and
    // the only messages that spell it out are error-path warnings a healthy run
    // never emits — such a check would pass without testing anything.
    await screen.getByLabel("Logs tab").tap();

    await screen.getByText(app.platformLog.button).tap();
    await waitForEvents("log");

    const events = await getEvents();
    const leaked = events.filter(
      (e) =>
        e.type === "log" &&
        String((e.attributes as Record<string, unknown>)?.message ?? "").includes("[groundcover]")
    );
    expect(leaked).toHaveLength(0);
  });

  test("sendCustomEvent is captured with its name and attributes", async ({ screen }) => {
    // Arrange: go to the Custom screen.
    await screen.getByLabel("Custom tab").tap();

    // Act: emit a custom event.
    await screen.getByText("sendCustomEvent").tap();

    // Assert: it is captured with its name and attributes.
    const [custom] = await waitForEvents("custom", {
      where: (e) => (e.attributes as Record<string, unknown>)?.custom_event_name === "checkout_completed",
    });
    expect(custom).toBeTruthy();
    expect((custom!.attributes as Record<string, unknown>)?.["custom_event_attributes.total"]).toBe(42);
  });

  test("identifyUser stamps the user on session attributes", async ({ screen }) => {
    // Arrange: go to the Custom screen.
    await screen.getByLabel("Custom tab").tap();

    // Act: identify the user, then emit a custom event so a batch flushes
    // carrying the updated identity.
    await screen.getByText("identifyUser").tap();
    await screen.getByText("sendCustomEvent").tap();
    await waitForEvents("custom");

    // Assert: a batch emitted AFTER identifyUser carries the user on its session
    // attributes. (Don't assume the FIRST batch has it — an earlier tap may have
    // flushed its own batch before identify ran.)
    const events = await getEvents();
    const identified = events.some(
      (e) => ((e.__sessionAttributes as { user?: { id?: string } })?.user)?.id === "user-123"
    );
    expect(identified).toBe(true);
  });
});
