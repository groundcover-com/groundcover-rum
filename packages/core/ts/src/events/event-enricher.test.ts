import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEnricher } from './event-enricher';
import { msToNs } from '../common/global';

// Core has no view concept: it merges whatever the platform's
// `enrichAttributes` contributor returns. This test-local fake contributor
// reads a mutable view so individual tests can change what it reports.
type ViewAttributes = { name: string };
let currentView: ViewAttributes;

// Deterministic id generator, injected through the constructor.
const idGenerator = {
  generateId: () => 'test-event-id',
  generateSpanId: () => 'test-span-id',
  generateTraceId: () => 'test-trace-id',
};

describe('EventEnricher', () => {
  let enricher: EventEnricher;

  beforeEach(() => {
    vi.clearAllMocks();
    currentView = { name: 'home' };

    enricher = new EventEnricher({
      enrichAttributes: () => ({ view: currentView }),
      idGenerator,
    });
  });

  describe('enrich', () => {
    it('should enrich basic event with required fields', () => {
      const baseEvent = {
        type: 'custom' as const,
        attributes: {
          custom_event_name: 'test-event'
        }
      };

      const enriched = enricher.enrich(baseEvent);

      expect(enriched).toEqual({
        type: 'custom',
        timestamp: expect.any(Number),
        id: 'test-event-id',
        spanId: 'test-span-id',
        parentSpanId: '',
        traceId: 'test-trace-id',
        attributes: {
          'custom_event_name': 'test-event',
          view: {
            name: 'home'
          }
        }
      });
    });

    // View derivation and URL redaction belong to each platform's view
    // provider and are tested by the platform package. Core's enricher stamps
    // whatever final attributes the contributor returns.

    it('should handle nested attributes correctly', () => {
      const event = {
        type: 'custom' as const,
        attributes: {
          custom_event_name: 'test-event',
          user: {
            id: '123',
            preferences: {
              theme: 'dark'
            }
          }
        }
      };

      const enriched = enricher.enrich(event);

      expect(enriched.attributes).toEqual({
        'custom_event_name': 'test-event',
        'user.id': '123',
        'user.preferences.theme': 'dark',
        view: expect.any(Object)
      });
    });

    it('should handle events without attributes', () => {
      const event = {
        type: 'custom' as const
      };

      const enriched = enricher.enrich(event);

      expect(enriched.attributes).toEqual({
        view: expect.any(Object)
      });
    });

    // enrich() is the single choke point for every event type on every
    // platform. A throwing contributor must cost its own attributes and
    // nothing else — not the event, and not the host's instrumentation.
    it('contains a throwing platform contributor instead of aborting enrichment', () => {
      const exploding = new EventEnricher({
        enrichAttributes: () => {
          throw new Error('hostile contributor getter');
        },
      });

      let enriched;
      expect(() => {
        enriched = exploding.enrich({
          type: 'custom' as const,
          attributes: { custom_event_name: 'still-here' },
        });
      }).not.toThrow();

      expect(enriched!.attributes).toEqual({ custom_event_name: 'still-here' });
      expect(enriched!.id).toEqual(expect.any(String));
    });

    it('lets the platform contribution win over a user attribute of the same name', () => {
      const stamping = new EventEnricher({
        enrichAttributes: () => ({ view: { name: 'real' } }),
      });

      const enriched = stamping.enrich({
        type: 'custom' as const,
        attributes: { view: 'user-supplied-string' } as never,
      });

      expect(enriched.attributes?.view).toEqual({ name: 'real' });
    });

    it('stamps an empty contribution verbatim when the platform has no view', () => {
      // The contributor falls back to an empty view; the enricher must stamp
      // it as-is rather than drop or reshape it.
      currentView = { name: '' };

      const event = {
        type: 'custom' as const
      };

      const enriched = enricher.enrich(event);

      expect(enriched?.attributes?.view).toEqual({
        name: ""
      });
    });

    it('should generate consistent timestamps', () => {
      const event = {
        type: 'custom' as const
      };

      const now = Date.now();
      const enriched = enricher.enrich(event);

      // Timestamp should be in nanoseconds
      expect(enriched.timestamp).toBe(msToNs(now));
    });

    it('should set timestamp for non-network events', () => {
      // Mock Date.now for consistent testing
      const mockNow = 1000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      const event = {
        type: 'background' as const,
        attributes: {
          resources: {
            count: 0,
            totalSize: 0,
            totalDuration: 0,
            byType: {}
          },
          source: 'https://test.com',
          load_time: 1000,
          target: 'https://test.com'
        },
      };

      const enriched = enricher.enrich(event);

      expect(enriched.timestamp).toBe(msToNs(mockNow));
      expect(enriched.start_timestamp).toBeUndefined();
      expect(enriched.end_timestamp).toBeUndefined();
      expect(enriched.type).toBe('background');
      expect(enriched.id).toBe('test-event-id');
    });

    it('should honor a caller-provided timestamp for non-network events', () => {
      // An event captured before it could be sent (persisted, re-sent later)
      // must report WHEN IT HAPPENED, not when it was handed to the enricher.
      const mockNow = 5000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);
      const occurredAt = msToNs(1234);

      const enriched = enricher.enrich({
        type: 'exception' as const,
        timestamp: occurredAt,
        attributes: { error_type: 'SIGSEGV', error_message: 'boom' },
      });

      expect(enriched.timestamp).toBe(occurredAt);
      expect(enriched.timestamp).not.toBe(msToNs(mockNow));
    });

    it('should keep a caller timestamp of 0 rather than treating it as absent', () => {
      // `|| now` would swallow it. 0 ns is the Unix epoch — a legitimate value,
      // and the one a miscomputed anchor produces, so silently restamping it to
      // now would hide the very case worth seeing.
      const mockNow = 5000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      const enriched = enricher.enrich({
        type: 'exception' as const,
        timestamp: 0,
        attributes: { error_type: 'SIGSEGV', error_message: 'boom' },
      });

      expect(enriched.timestamp).toBe(0);
    });

    it.each([
      ['negative', -1],
      ['Infinity', Infinity],
      ['NaN', NaN],
    ])('should fall back to now for a %s caller timestamp', (_label, supplied) => {
      // Unvalidated, these would reach the wire unchanged. `Infinity` serializes
      // as `null` in the batch, and a negative magnitude misorders the event
      // against every other one in the session.
      const mockNow = 5000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      const enriched = enricher.enrich({
        type: 'exception' as const,
        timestamp: supplied,
        attributes: { error_type: 'SIGSEGV', error_message: 'boom' },
      });

      expect(enriched.timestamp).toBe(msToNs(mockNow));
    });

    it.each([
      ['negative', -1],
      ['Infinity', Infinity],
    ])('should apply the same validation to a %s NETWORK start_timestamp', (_label, supplied) => {
      // Validating only the non-network branch would leave start_timestamp on
      // `|| now`, and the identical bad values would reach the wire on the busiest
      // event type in the SDK.
      const mockNow = 5000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      const enriched = enricher.enrich({
        type: 'network' as const,
        timestamp: supplied,
        attributes: { type: 'HTTP' },
      });

      expect(enriched.start_timestamp).toBe(msToNs(mockNow));
    });

    it('should keep a NETWORK start_timestamp of 0', () => {
      const mockNow = 5000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      const enriched = enricher.enrich({
        type: 'network' as const,
        timestamp: 0,
        attributes: { type: 'HTTP' },
      });

      expect(enriched.start_timestamp).toBe(0);
    });

    it('should set start_timestamp and end_timestamp for network events', () => {
      // Mock Date.now for consistent testing
      const mockNow = 1000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      const endTimestamp = msToNs(2000);
      const event = {
        type: 'network' as const,
        end_timestamp: endTimestamp,
        attributes: {
          url: 'https://api.example.com',
          statusCode: 200,
        },
      };

      // EnrichInput.attributes is open, so an arbitrary payload is legal input
      // rather than a suppressed error.
      const enriched = enricher.enrich(event);

      expect(enriched.timestamp).toBeUndefined();
      expect(enriched.start_timestamp).toBe(msToNs(mockNow));
      expect(enriched.end_timestamp).toBe(endTimestamp);
      expect(enriched.type).toBe('network');
      expect(enriched.id).toBe('test-event-id');
    });

    // A host object leaking into the attributes would make the formatter walk
    // its internal fields, which can hang the host.
    it('does not recurse into host objects the platform marks opaque', () => {
      class HostNode {
        self: HostNode = this;
      }
      const opaqueEnricher = new EventEnricher({
        isOpaqueNode: (v) => v instanceof HostNode,
      });

      const enriched = opaqueEnricher.enrich({
        type: 'custom' as const,
        attributes: { custom_event_name: 'test-event', leaked: new HostNode() },
      });

      expect(enriched.attributes).toMatchObject({
        custom_event_name: 'test-event',
        leaked: '[HostNode]',
      });
    });

    // Pathological object graphs (e.g. framework nodes linked via cross-edges)
    // would otherwise blow up the recursion budget.
    it('should bail out of deeply nested attribute graphs', () => {
      // Build a 25-level deep nested object — well past MAX_FORMAT_DEPTH (10).
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 25; i++) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      cursor.leaf = 'bottom';

      const event = {
        type: 'custom' as const,
        attributes: {
          custom_event_name: 'test-event',
          deep,
        },
      };

      const enriched = enricher.enrich(event);

      // Somewhere in the flattened values we should see the depth-limit marker
      // instead of the deepest leaf, proving the formatter bailed.
      const values = Object.values(enriched.attributes ?? {});
      expect(values).toContain('[Depth Limit]');
      // And the deepest value from the original graph must NOT appear — if it
      // did, the formatter walked past the limit.
      expect(values).not.toContain('bottom');
    });
  });
});
