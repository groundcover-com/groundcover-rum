import { Page, expect, test } from '@playwright/test';

export enum EventType {
  PAGELOAD = 'pageload',
  CUSTOM = 'custom',
  LOG = 'log',
  EXCEPTION = 'exception',
  NAVIGATION = 'navigation',
  PERFORMANCE = 'performance',
  DOM_EVENT = 'dom.event',
  NETWORK = 'network',
  REPLAY = 'replay'
}

export const eventFixtures = {
  [EventType.PAGELOAD]: {
    attributes: ['page_url', 'page_load_time']
  },
  [EventType.CUSTOM]: {
    attributes: ['custom_event_name']
  },
  [EventType.LOG]: {
    attributes: ['message', 'level']
  },
  [EventType.EXCEPTION]: {
    attributes: ['error_type', 'error_message', 'error_handled', 'error_fingerprint']
  },
  [EventType.NAVIGATION]: {
    attributes: ['page_url']
  },
  [EventType.PERFORMANCE]: {
    attributes: ['performance_metric_name', 'performance_metric_value', 'performance_metric_id']
  },
  [EventType.DOM_EVENT]: {
    attributes: ['dom_event_type', 'dom_event_selector']
  },
  [EventType.NETWORK]: {
    attributes: ['http.method', 'http.status', 'url.full']
  }
};

export type ValidationOptions = {
  timeout?: number;
  retries?: number;
  additionalAttributes?: Record<string, any>;
  waitForRequest?: boolean;
}

// Every RUM batch each page has sent since tracking started on it. Keyed by
// page, so a test only ever sees its own page's batches — never a batch left
// over from an earlier test in the same worker.
const rumBatchesByPage = new WeakMap<Page, any[]>();

/**
 * Start recording every RUM batch `page` sends (idempotent per page). Call it
 * before the actions under test: batches sent earlier are not recorded.
 */
export function trackRumBatches(page: Page): any[] {
  let batches = rumBatchesByPage.get(page);
  if (!batches) {
    batches = collectRumBatches(page);
    rumBatchesByPage.set(page, batches);
  }
  return batches;
}

/**
 * Creates a promise that waits for a RUM event request. Also starts
 * `trackRumBatches(page)`, which `validateRumEvent(..., { waitForRequest: false })`
 * reads.
 */
export function waitForRumRequest(page: Page, timeout = 30000): Promise<any> {
  trackRumBatches(page);

  return page.waitForRequest(
    (request) => request.url().includes('json/rum'),
    { timeout }
  );
}

function findMatchingEvent(
  events: any[],
  eventType: EventType,
  expectedAttributes: Record<string, any>
): any {
  return events.find((e: any) => {
    if (e.type !== eventType) return false;
    try {
      expect(e.attributes).toMatchObject(expectedAttributes);
      return true;
    } catch {
      return false;
    }
  });
}

function expectFixtureAttributes(event: any, eventType: EventType): void {
  const attributes = eventFixtures[eventType]?.attributes || [];
  for (const attribute of attributes) {
    expect(event.attributes).toHaveProperty(attribute);
  }
}

/**
 * Validates a RUM event against expected attributes.
 *
 * `waitForRequest: true` (default) checks the next RUM request the page sends.
 * `waitForRequest: false` waits until ANY batch this page has sent since
 * tracking started (see `trackRumBatches`) carries a matching event. The SDK
 * sends a batch only once the buffer reaches `batchSize` or the `batchTimeout`
 * heartbeat fires, so the event can still be buffered when this is called.
 */
export async function validateRumEvent(
  page: Page,
  eventType: EventType,
  expectedAttributes: Record<string, any> = {},
  options: ValidationOptions = {}
): Promise<any> {
  const { timeout = 30000, retries = 1, waitForRequest = true } = options;

  if (!waitForRequest) {
    const batches = trackRumBatches(page);
    let event: any;
    await expect
      .poll(
        () => (event = findMatchingEvent(collectedEvents(batches), eventType, expectedAttributes)),
        { message: `Event of type ${eventType} with matching attributes should be sent`, timeout }
      )
      .toBeTruthy();
    expectFixtureAttributes(event, eventType);
    return event;
  }

  try {
    const rumRequest = await waitForRumRequest(page, timeout);

    const requestBody = JSON.parse((await rumRequest.postData()) || '{}');

    expect(requestBody, 'Request body should exist').toHaveProperty('events');
    expect(Array.isArray(requestBody.events), 'Events should be an array').toBeTruthy();

    const matchingEvents = requestBody.events.filter((e: any) => e.type === eventType);
    expect(matchingEvents.length, `At least one event of type ${eventType} should exist`).toBeGreaterThan(0);

    const event = findMatchingEvent(matchingEvents, eventType, expectedAttributes);

    expect(event, `Event of type ${eventType} with matching attributes should exist`).toBeTruthy();

    expectFixtureAttributes(event, eventType);

    return event;
  } catch (error) {
    if (retries > 0) {
      await page.waitForTimeout(1000);
      return validateRumEvent(page, eventType, expectedAttributes, {
        ...options,
        retries: retries - 1
      });
    }
    throw error;
  }
}

/**
 * Start collecting every RUM batch the page sends. Returns an array that fills
 * as requests go out — combine with `collectedEvents` + `expect.poll` to wait
 * for a specific event across batches (privacy redaction can land in any batch).
 *
 * Each batch is collected once. A page-hide (keepalive) request the browser
 * rejects is sent again with the same bytes, and the playground's default
 * collector isn't running, so every such batch goes out twice. Two different
 * batches never have the same bytes: every event has a random id.
 */
export function collectRumBatches(page: Page): any[] {
  const batches: any[] = [];
  const seen = new Set<string>();
  page.on('request', (request) => {
    if (request.url().includes('json/rum')) {
      const data = request.postData();
      if (data && !seen.has(data)) {
        seen.add(data);
        try {
          batches.push(JSON.parse(data));
        } catch {
          // ignore non-JSON / compressed payloads
        }
      }
    }
  });
  return batches;
}

/** Flatten all events from collected batches, optionally filtered by type. */
export function collectedEvents(batches: any[], type?: EventType): any[] {
  const events = batches.flatMap((b) => b?.events || []);
  return type ? events.filter((e) => e.type === type) : events;
}

export interface TestContext {
  rumRequestPromise?: Promise<any>;
}

export function isValidRumEvent(received: any, eventType: EventType): boolean {
  return received?.type === eventType &&
    received?.attributes &&
    received?.timestamp;
}

expect.extend({
  toBeValidRumEvent(received: any, eventType: EventType) {
    const pass = isValidRumEvent(received, eventType);
    return {
      pass,
      message: () =>
        pass
          ? `Expected event not to be a valid ${eventType} event`
          : `Expected event to be a valid ${eventType} event`
    };
  }
});

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidRumEvent(eventType: EventType): R;
    }
  }
} 