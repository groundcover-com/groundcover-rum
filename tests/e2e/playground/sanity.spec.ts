import { expect, test } from "@playwright/test";
import PlaygroundPage from "./playground.page";
import { EventType, validateRumEvent, isValidRumEvent, waitForRumRequest, trackRumBatches, collectRumBatches, collectedEvents } from "./utils";

/**
 * End-to-end tests for the RUM SDK Playground
 * Tests various event capturing capabilities of the RUM SDK
 */
test.describe("RUM SDK Playground", () => {
  let playgroundPage: PlaygroundPage;

  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");
    playgroundPage = new PlaygroundPage(page);
    await playgroundPage.validatePage();
  });

  test.describe("Page Load Events", () => {
    test("should capture initial page load with performance metrics", async ({ page, browserName }) => {
      test.skip(browserName === 'webkit', 'Skipping performance metrics test on WebKit');

      // Start fresh by navigating again with request capture
      const requestPromise = waitForRumRequest(page);
      await page.goto(process.env.PLAYGROUND_URL || "http://localhost:4173");

      const rumRequest = await requestPromise;
      const requestBody = JSON.parse((await rumRequest.postData()) || '{}');

      // Validate pageload event
      const pageloadEvent = requestBody.events.find((e: any) => e.type === EventType.PAGELOAD);
      expect(pageloadEvent).toBeTruthy();
      expect(pageloadEvent.attributes.page_url).toContain("/");
      expect(pageloadEvent.attributes.page_load_time).toBeDefined();

      // Validate performance events
      const performanceEvents = requestBody.events
        .filter((e: any) => e.type === EventType.PERFORMANCE);

      expect(performanceEvents.length).toBeGreaterThan(0);

      const metricNames = performanceEvents.map((e: any) => e.attributes.performance_metric_name);
      // TTFB should always be present
      expect(metricNames).toContain('TTFB');

      // Validate each performance event structure
      performanceEvents.forEach((e: any) => {
        expect(isValidRumEvent(e, EventType.PERFORMANCE)).toBeTruthy();
        expect(e.attributes).toMatchObject({
          performance_metric_name: expect.any(String),
          performance_metric_value: expect.any(Number),
          performance_metric_id: expect.any(String)
        });
      });
    });

    test("should set correct location and session attributes", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);

      const rumRequest = await requestPromise;
      const requestBody = JSON.parse((await rumRequest.postData()) || '{}');

      console.log(requestBody);
      const event = requestBody.events[0];
      expect(event.attributes.location).toBeTruthy();
      expect(event.attributes.location.path).toBe('/');

      expect(requestBody.sessionAttributes).toMatchObject({
        cluster: expect.any(String),
        env: expect.any(String),
        namespace: expect.any(String),
        session_id: expect.any(String),
        session_start_time: expect.any(Number),
        'service.name': 'playground',
        userAgent: expect.stringContaining('Mozilla'),
        browser: {
          name: expect.any(String),
          version: expect.any(String),
          platform: expect.any(String),
          language: expect.any(String),
          mobile: expect.any(Boolean)
        }
      });

      console.log("pre navigating");
      const navRequestPromise = waitForRumRequest(page);
      console.log("navigating");
      await playgroundPage.navigate();
      console.log("post navigating");

      const navRumRequest = await navRequestPromise;
      const navRequestBody = JSON.parse((await navRumRequest.postData()) || '{}');
      console.log("navRequestBody", navRequestBody);

      const navEvent = navRequestBody.events[0];
      expect(["/", "/other-page"]).toContain(navEvent.attributes.location.path);

      console.log("navRequestBody.sessionAttributes", navRequestBody.sessionAttributes);
      // Session attributes should persist
      expect(navRequestBody.sessionAttributes).toMatchObject({
        session_id: requestBody.sessionAttributes.session_id, // Same session
        'service.name': 'playground',
        browser: expect.any(Object)
      });
    });
  });

  test.describe("User Interactions", () => {
    test("should capture custom events", async ({ page }) => {
      // Start listening for the request before the action
      const requestPromise = waitForRumRequest(page);
      await playgroundPage.sendCustomEvent();
      await playgroundPage.sendCustomEvent();

      await validateRumEvent(page, EventType.CUSTOM, {
        custom_event_name: "button_click",
        "custom_event_attributes.button_text": "Click me"
      }, { waitForRequest: false });
    });

    test("should capture DOM click events", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);
      await playgroundPage.simulateClickEvent();

      await validateRumEvent(page, EventType.DOM_EVENT, {
        dom_event_type: "click",
        "dom_event_target.tagName": expect.any(String),
        "dom_event_target.className": expect.any(String),
        dom_event_selector: expect.any(String)
      }, { waitForRequest: false });
    });
  });

  test.describe("Error Tracking", () => {
    test("should capture unhandled errors", async ({ page }) => {
      const batches = trackRumBatches(page);
      for (let i = 0; i < 4; i++) await playgroundPage.throwError();
      // The four throws are one error, merged into a single event (or a few,
      // if another send cut between them) that stays under batchSize. Flush
      // Events crosses batchSize so it ships now, not at the 10s heartbeat.
      await playgroundPage.flushEvents();

      await validateRumEvent(page, EventType.EXCEPTION, {
        error_type: "Error",
        error_message: "This is a simulated error!",
        error_handled: false,
        error_fingerprint: "Error:This is a simulated error!"
      }, { waitForRequest: false });
      // Every throw is counted: a merged event stands for error_repeat_count throws.
      const thrown = () =>
        collectedEvents(batches, EventType.EXCEPTION)
          .filter((event) => event.attributes?.error_message === "This is a simulated error!")
          .reduce((sum, event) => sum + (event.attributes?.error_repeat_count ?? 1), 0);
      await expect.poll(thrown).toBe(4);
    });

    test("should capture manually captured exceptions with metadata", async ({ page }) => {
      trackRumBatches(page);

      await page.evaluate(() => {
        window.groundcover?.captureException(
          new Error('Manual error with metadata'),
          { userId: '123', feature: 'checkout', nested: { value: 42 } }
        );
      });

      // Push the buffer past batchSize so the exception ships now, not at the
      // 10s heartbeat. One custom event isn't enough: it crosses batchSize only
      // if the browser has already reported FCP, which WebKit often has not by
      // this point. Flush Events logs 10 lines, which crosses batchSize in every
      // browser.
      await playgroundPage.flushEvents();

      await validateRumEvent(page, EventType.EXCEPTION, {
        error_type: "Error",
        error_message: "Manual error with metadata",
        error_handled: true,
        "error_metadata.userId": "123",
        "error_metadata.feature": "checkout",
        "error_metadata.nested.value": 42
      }, { waitForRequest: false });
    });
  });

  test.describe("Logging", () => {
    test("should capture console logs", async ({ page }) => {
      waitForRumRequest(page);

      await playgroundPage.clickConsoleLog();
      await playgroundPage.clickConsoleLog();

      await validateRumEvent(page, EventType.LOG, {
        message: "Debug log",
        level: "log"
      }, { waitForRequest: false });
    });
  });

  test.describe("Logger API", () => {
    test("logger.warn from the demo button emits a structured log event", async ({ page }) => {
      waitForRumRequest(page);

      await playgroundPage.clickLoggerWarn();
      // Force a flush by piggybacking on the existing console-log capture.
      await playgroundPage.clickConsoleLog();

      await validateRumEvent(page, EventType.LOG, {
        message: "Playground checkout failed",
        level: "warn",
        appId: "playground",
        environment: "dev",
        "order.id": "ord_42",
        "order.total": 199.99,
      }, { waitForRequest: false });
    });

    test("console.log with a structured object promotes its keys to attributes", async ({ page }) => {
      waitForRumRequest(page);

      await playgroundPage.clickConsoleLogWithObject();
      await playgroundPage.clickConsoleLog();

      await validateRumEvent(page, EventType.LOG, {
        level: "log",
        appId: "playground",
        environment: "dev",
        "userAction.type": "click",
        "userAction.target": "demo-button",
      }, { waitForRequest: false });
    });

    test("window.groundcover.logger.info emits a structured log event", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);

      await page.evaluate(() => {
        window.groundcover?.logger.info("via window logger", {
          region: "us-east",
          attempt: 1,
        });
      });
      // Trigger a flush by emitting an additional console.log (counts toward batchSize).
      await playgroundPage.clickConsoleLog();

      const rumRequest = await requestPromise;
      const body = JSON.parse((await rumRequest.postData()) || "{}");
      const event = body.events.find(
        (e: any) =>
          e.type === EventType.LOG &&
          e.attributes.message === "via window logger"
      );
      expect(event, "logger.info event should be in the captured batch").toBeTruthy();
      expect(event.attributes).toMatchObject({
        level: "info",
        region: "us-east",
        attempt: 1,
      });
    });

    test("reserved keys (message/level/location) cannot be overridden by user attributes", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);

      await page.evaluate(() => {
        window.groundcover?.logger.warn("real message", {
          message: "USER_OVERRIDE",
          level: "error",
          location: "checkout-step-2",
          keep: "should-survive",
        });
      });
      await playgroundPage.clickConsoleLog();

      const rumRequest = await requestPromise;
      const body = JSON.parse((await rumRequest.postData()) || "{}");
      const event = body.events.find(
        (e: any) =>
          e.type === EventType.LOG && e.attributes.message === "real message"
      );
      expect(event, "logger.warn event with the real message should exist").toBeTruthy();
      expect(event.attributes.level).toBe("warn");
      expect(event.attributes.keep).toBe("should-survive");
      // location must be the enriched browser-location object, not the user string.
      expect(typeof event.attributes.location).toBe("object");
      expect(event.attributes.location).not.toBe("checkout-step-2");
    });
  });

  test.describe("Navigation", () => {
    test("should track page navigation", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);
      await playgroundPage.navigate();

      // add a console.log to make sure the rum call is made since we are not flushing after navigation events
      await playgroundPage.clickConsoleLog();

      await validateRumEvent(page, EventType.NAVIGATION, {
        page_url: expect.stringContaining("/other-page")
      }, { waitForRequest: false });
    });
  });

  test.describe("User Identity", () => {
    test("should update session with user identity", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);
      await playgroundPage.identifyUser();
      await requestPromise;

      const rumRequest = await requestPromise;
      const requestBody = JSON.parse((await rumRequest.postData()) || "{}");
      expect(requestBody.sessionAttributes.user).toMatchObject({
        id: "123",
        name: "John Doe",
        email: "john.doe@example.com"
      });
    });
  });

  test.describe("Multiple Events", () => {
    test("should handle multiple custom events in sequence", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);

      // Send multiple events in quick succession
      for (let i = 0; i < 3; i++) {
        await playgroundPage.sendCustomEvent();
      }

      const rumRequest = await requestPromise;
      const requestBody = JSON.parse((await rumRequest.postData()) || "{}");
      const customEvents = requestBody.events.filter((e: any) => e.type === EventType.CUSTOM);

      expect(customEvents.length).toBeGreaterThanOrEqual(1);
      customEvents.forEach(event => {
        expect(isValidRumEvent(event, EventType.CUSTOM)).toBeTruthy();
      });
    });
  });

  test.describe("Release ID", () => {
    test("should include releaseId in session attributes", async ({ page }) => {
      const requestPromise = waitForRumRequest(page);
      
      // Click the test release ID button to trigger a custom event
      await playgroundPage.testReleaseId();
      // Send another event to ensure flush
      await playgroundPage.sendCustomEvent();

      const rumRequest = await requestPromise;
      const requestBody = JSON.parse((await rumRequest.postData()) || '{}');

      // Verify releaseId is present in sessionAttributes
      expect(requestBody.sessionAttributes).toHaveProperty('releaseId');
      expect(requestBody.sessionAttributes.releaseId).toBe('v1.0.0-playground');
    });

    test("should persist releaseId across multiple requests", async ({ page }) => {
      // First request
      const firstRequestPromise = waitForRumRequest(page);
      await playgroundPage.sendCustomEvent();
      await playgroundPage.sendCustomEvent();
      
      const firstRumRequest = await firstRequestPromise;
      const firstRequestBody = JSON.parse((await firstRumRequest.postData()) || '{}');
      
      expect(firstRequestBody.sessionAttributes.releaseId).toBe('v1.0.0-playground');

      // Navigate to trigger another request
      const secondRequestPromise = waitForRumRequest(page);
      await playgroundPage.navigate();
      await playgroundPage.clickConsoleLog();
      
      const secondRumRequest = await secondRequestPromise;
      const secondRequestBody = JSON.parse((await secondRumRequest.postData()) || '{}');
      
      // releaseId should be the same across requests
      expect(secondRequestBody.sessionAttributes.releaseId).toBe('v1.0.0-playground');
    });
  });

  test.describe("Window Object Exposure", () => {
    test("should expose groundcover SDK on window object", async ({ page }) => {
      // Verify that the groundcover SDK is properly exposed on the window object
      await playgroundPage.verifyGroundcoverOnWindow();
    });

    test("should be able to call groundcover methods via window object", async ({ page }) => {
      // First verify it's exposed
      await playgroundPage.verifyGroundcoverOnWindow();

      // Test calling identifyUser via window.groundcover
      const requestPromise = waitForRumRequest(page);
      await playgroundPage.callGroundcoverMethod('identifyUser', {
        id: '456',
        name: 'Jane Doe',
        email: 'jane.doe@example.com'
      });

      const rumRequest = await requestPromise;
      const requestBody = JSON.parse((await rumRequest.postData()) || "{}");

      // Verify the user identity was set correctly
      expect(requestBody.sessionAttributes.user).toMatchObject({
        id: "456",
        name: "Jane Doe",
        email: "jane.doe@example.com"
      });
    });

    test("should be able to send custom events via window object", async ({ page }) => {
      // Collect every batch from here on and wait for the event itself: the
      // flush that carries it can land after the click returns.
      const batches = collectRumBatches(page);
      await playgroundPage.callGroundcoverMethod('sendCustomEvent', {
        event: 'test_via_window',
        attributes: {
          source: 'window_object',
          test: true
        }
      });

      // A genuine click opens the send gate and releases the buffered event.
      await playgroundPage.sendCustomEvent();

      await expect
        .poll(
          () =>
            collectedEvents(batches, EventType.CUSTOM).find(
              (e) => e.attributes?.custom_event_name === "test_via_window"
            ),
          { timeout: 30_000 }
        )
        .toBeTruthy();
      const event = collectedEvents(batches, EventType.CUSTOM).find(
        (e) => e.attributes?.custom_event_name === "test_via_window"
      );
      expect(event.attributes).toMatchObject({
        "custom_event_attributes.source": "window_object",
        "custom_event_attributes.test": true
      });
    });
  });
});
