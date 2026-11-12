import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NavigationListener } from "./navigation-listener";
import { _globalThis } from "../../common/global";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";
import { Logger } from "@groundcover/rum-core/common/logger";

describe("NavigationListener", () => {
  let navigationListener: NavigationListener;
  let mockEventsPool: Pick<EventsPool, "addEvent">;
  let mockLogger: Pick<Logger, "log">;
  let originalPushState: typeof history.pushState;
  let originalReplaceState: typeof history.replaceState;

  beforeEach(() => {
    // Store original history methods
    originalPushState = history.pushState;
    originalReplaceState = history.replaceState;

    // Mock location
    vi.stubGlobal("location", {
      href: "https://example.com/initial",
    });

    // Mock event pool and logger
    mockEventsPool = {
      addEvent: vi.fn(),
    };
    mockLogger = {
      log: vi.fn(),
    };

    // DI: the mock events pool is injected through the constructor deps.
    // Config/enricher are real.
    const configManager = new ConfigManager();
    navigationListener = new NavigationListener(
      {
        config: configManager,
        eventsPool: mockEventsPool as unknown as EventsPool,
        enricher: new EventEnricher(),
      },
      { isEnabled: true }
    );
    // @ts-expect-error - Accessing private property for testing purposes.
    navigationListener.logger = mockLogger;
  });

  afterEach(() => {
    navigationListener.destroy();
    // Restore original history methods
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe("handleLocationChange", () => {
    it("still reports back/forward navigations when the history methods can't be wrapped", () => {
      // Deliberate: the history patch and the popstate/hashchange listeners are
      // independent captures. A host whose pushState is read-only loses SPA
      // pushState navigations only — each event carries just the current
      // page_url, so a popstate-only capture can't report a wrong one.
      const descriptor = Object.getOwnPropertyDescriptor(history, "pushState");
      Object.defineProperty(history, "pushState", {
        configurable: true,
        get: () => originalPushState,
        set: () => {
          throw new TypeError("pushState is read-only");
        },
      });
      try {
        expect(() => navigationListener.initialize()).not.toThrow();
        // The group rolled back whole: replaceState isn't left half-wrapped.
        expect(history.replaceState).toBe(originalReplaceState);

        vi.stubGlobal("location", { href: "https://example.com/back" });
        window.dispatchEvent(new PopStateEvent("popstate"));

        expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "navigation",
            attributes: expect.objectContaining({ page_url: "https://example.com/back" }),
          })
        );
      } finally {
        if (descriptor) Object.defineProperty(history, "pushState", descriptor);
        else delete (history as unknown as Record<string, unknown>).pushState;
      }
    });

    it("should trigger event when pathname changes", () => {
      // Initial state is set in beforeEach
      navigationListener.initialize();

      // Simulate URL change with different pathname
      vi.stubGlobal("location", {
        href: "https://example.com/new-path",
      });

      // @ts-expect-error - Accessing private method for testing. In a real scenario, we would test through public API
      navigationListener.handleLocationChange();

      expect(mockEventsPool.addEvent).toHaveBeenCalledTimes(1);
      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation",
          attributes: expect.objectContaining({
            page_url: "https://example.com/new-path",
          }),
        })
      );
    });

    it("should not trigger event when only search params change", () => {
      // Initial state is set in beforeEach
      navigationListener.initialize();

      // Simulate URL change with same pathname but different search params
      vi.stubGlobal("location", {
        href: "https://example.com/initial?param=1",
      });

      // @ts-expect-error - Accessing private method for testing. In a real scenario, we would test through public API
      navigationListener.handleLocationChange();

      expect(mockEventsPool.addEvent).not.toHaveBeenCalled();
    });

    it("should not trigger event when only hash fragment changes", () => {
      // Initial state is set in beforeEach
      navigationListener.initialize();

      // Simulate URL change with same pathname but different hash fragment
      vi.stubGlobal("location", {
        href: "https://example.com/initial#section1",
      });

      // @ts-expect-error - Accessing private method for testing. In a real scenario, we would test through public API
      navigationListener.handleLocationChange();

      expect(mockEventsPool.addEvent).not.toHaveBeenCalled();
    });

    it("should trigger event when hash-based routing changes", () => {
      // Initial state is set in beforeEach
      navigationListener.initialize();

      // Simulate URL change with hash-based routing
      vi.stubGlobal("location", {
        href: "https://example.com/initial#/changed",
      });

      // @ts-expect-error - Accessing private method for testing. In a real scenario, we would test through public API
      navigationListener.handleLocationChange();

      expect(mockEventsPool.addEvent).toHaveBeenCalledTimes(1);
      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation",
          attributes: expect.objectContaining({
            page_url: "https://example.com/initial#/changed",
          }),
        })
      );
    });

    it("should trigger event when changing from hash fragment to hash-based routing", () => {
      // Set initial state with hash fragment
      navigationListener.initialize();
      vi.stubGlobal("location", {
        href: "https://example.com/initial#section1",
      });
      // @ts-expect-error - Accessing private property for testing
      navigationListener.currentUrl = "https://example.com/initial#section1";

      // Change to hash-based routing
      vi.stubGlobal("location", {
        href: "https://example.com/initial#/changed",
      });

      // @ts-expect-error - Accessing private method for testing
      navigationListener.handleLocationChange();

      expect(mockEventsPool.addEvent).toHaveBeenCalledTimes(1);
      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation",
          attributes: expect.objectContaining({
            page_url: "https://example.com/initial#/changed",
          }),
        })
      );
    });

    it("should not trigger event when URL is the same", () => {
      // Initial state is set in beforeEach
      navigationListener.initialize();

      // Simulate same URL
      vi.stubGlobal("location", {
        href: "https://example.com/initial",
      });

      // @ts-expect-error - Accessing private method for testing
      navigationListener.handleLocationChange();

      expect(mockEventsPool.addEvent).not.toHaveBeenCalled();
    });
  });

  describe("initialize", () => {
    it("should patch pushState method", () => {
      navigationListener.initialize();

      // Verify pushState was patched (it should be different from the original)
      expect(history.pushState).not.toBe(originalPushState);
    });

    it("should patch replaceState method", () => {
      navigationListener.initialize();

      // Verify replaceState was patched (it should be different from the original)
      expect(history.replaceState).not.toBe(originalReplaceState);
    });

    it("should add popstate event listener", () => {
      const addEventListenerSpy = vi.spyOn(_globalThis, "addEventListener");

      navigationListener.initialize();

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        "popstate",
        expect.any(Function)
      );
    });

    it("should add hashchange event listener", () => {
      const addEventListenerSpy = vi.spyOn(_globalThis, "addEventListener");

      navigationListener.initialize();

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        "hashchange",
        expect.any(Function)
      );
    });
  });

  describe("destroy", () => {
    it("should restore original history methods", () => {
      navigationListener.initialize();
      
      // Verify methods were patched
      expect(history.pushState).not.toBe(originalPushState);
      expect(history.replaceState).not.toBe(originalReplaceState);

      navigationListener.destroy();

      // Verify original methods were restored
      expect(history.pushState).toBe(originalPushState);
      expect(history.replaceState).toBe(originalReplaceState);
    });

    it("does not restore over a host wrapper installed on top of ours", () => {
      navigationListener.initialize();
      const sdkPushState = history.pushState;
      const sdkReplaceState = history.replaceState;
      expect(sdkPushState).not.toBe(originalPushState);

      // A host router wraps the history methods AFTER us, delegating to the
      // current (our) implementation.
      const hostPushState = function (
        this: History,
        ...args: Parameters<History["pushState"]>
      ) {
        return (sdkPushState as History["pushState"]).apply(this, args);
      } as History["pushState"];
      const hostReplaceState = function (
        this: History,
        ...args: Parameters<History["replaceState"]>
      ) {
        return (sdkReplaceState as History["replaceState"]).apply(this, args);
      } as History["replaceState"];
      history.pushState = hostPushState;
      history.replaceState = hostReplaceState;

      navigationListener.destroy();

      // destroy() must leave the host's wrappers in place — restoring the
      // pre-SDK originals here would silently uninstall the router's own
      // history instrumentation.
      expect(history.pushState).toBe(hostPushState);
      expect(history.replaceState).toBe(hostReplaceState);
    });

    it("should remove event listeners", () => {
      const removeEventListenerSpy = vi.spyOn(_globalThis, "removeEventListener");

      navigationListener.initialize();
      navigationListener.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "popstate",
        expect.any(Function)
      );
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "hashchange",
        expect.any(Function)
      );
    });
  });

  describe("history method patching", () => {
    it("should trigger navigation event when pushState is called", () => {
      navigationListener.initialize();

      // Mock location update to simulate the pushState effect
      vi.stubGlobal("location", {
        href: "https://example.com/new-path",
      });

      // Call pushState
      history.pushState({}, "", "/new-path");

      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation",
          attributes: expect.objectContaining({
            page_url: "https://example.com/new-path",
          }),
        })
      );
    });

    it("should trigger navigation event when replaceState is called", () => {
      navigationListener.initialize();

      // Mock location update to simulate the replaceState effect
      vi.stubGlobal("location", {
        href: "https://example.com/replaced-path",
      });

      // Call replaceState
      history.replaceState({}, "", "/replaced-path");

      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation",
          attributes: expect.objectContaining({
            page_url: "https://example.com/replaced-path",
          }),
        })
      );
    });

    it("should preserve original method functionality", () => {
      navigationListener.initialize();

      const mockState = { test: "data" };
      const mockTitle = "Test Title";
      const mockUrl = "/test-url";

      // Mock location update to simulate the pushState effect
      vi.stubGlobal("location", {
        href: "https://example.com/test-url",
      });

      // Call the patched method
      history.pushState(mockState, mockTitle, mockUrl);

      // Verify that the original functionality is preserved by checking:
      // 1. The method executes without throwing errors
      // 2. The location is updated (in a real browser, this would change the URL)
      // 3. The state is accessible via history.state
      expect(history.pushState).toBeDefined();
      expect(typeof history.pushState).toBe('function');
      
      // Verify that our patched method still calls the original functionality
      // by checking that the navigation event was triggered
      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation",
          attributes: expect.objectContaining({
            page_url: "https://example.com/test-url",
          }),
        })
      );

      // Test that replaceState also works
      vi.stubGlobal("location", {
        href: "https://example.com/replace-url",
      });
      history.replaceState({ replace: "data" }, "Replace Title", "/replace-url");
      
      expect(mockEventsPool.addEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe("startNavigation", () => {
    beforeEach(() => {
      vi.stubGlobal("location", {
        href: "https://example.com/test-page",
      });
    });

    it("should initialize active navigation with correct properties", () => {
      const metadata = { source: "test", action: "click" };
      const mockDateNow = 1234567890;
      vi.spyOn(Date, 'now').mockReturnValue(mockDateNow);

      navigationListener.startNavigation(metadata);

      // @ts-expect-error - Accessing private property for testing
      const activeNavigation = navigationListener.activeNavigation;

      expect(activeNavigation).toEqual({
        page_url: "https://example.com/test-page",
        metadata,
        startTime: mockDateNow,
        endTime: 0,
        duration_ms: 0,
      });
    });

    it("should log the start navigation call", () => {
      const metadata = { source: "test" };

      navigationListener.startNavigation(metadata);

      expect(mockLogger.log).toHaveBeenCalledWith(
        "[navigation-listener.startNavigation] called",
        metadata
      );
    });

    it("should overwrite previous active navigation", () => {
      const firstMetadata = { source: "first" };
      const secondMetadata = { source: "second" };
      const firstTime = 1000;
      const secondTime = 2000;

      vi.spyOn(Date, 'now').mockReturnValueOnce(firstTime);
      navigationListener.startNavigation(firstMetadata);

      vi.spyOn(Date, 'now').mockReturnValueOnce(secondTime);
      navigationListener.startNavigation(secondMetadata);

      // @ts-expect-error - Accessing private property for testing
      const activeNavigation = navigationListener.activeNavigation;

      expect(activeNavigation).toEqual({
        page_url: "https://example.com/test-page",
        metadata: secondMetadata,
        startTime: secondTime,
        endTime: 0,
        duration_ms: 0,
      });
    });

    it("should work with empty metadata", () => {
      const metadata = {};
      const mockDateNow = 1234567890;
      vi.spyOn(Date, 'now').mockReturnValue(mockDateNow);

      navigationListener.startNavigation(metadata);

      // @ts-expect-error - Accessing private property for testing
      const activeNavigation = navigationListener.activeNavigation;

       expect(activeNavigation).not.toBeNull();
       expect(activeNavigation!.metadata).toEqual({});
    });

    // This is the SDK's PUBLIC manual-navigation API — groundcover
    // .startNavigation() calls straight through to here from customer code.
    // Like the automatic path (handleLocationChange), it must be contained: a
    // hostile or instrumented `location` getter would otherwise throw out of
    // the SDK and into the caller's own stack.
    it("does not throw into the caller when `location` is hostile", () => {
      vi.stubGlobal("location", {
        get href(): string {
          throw new Error("blocked by page");
        },
      });

      expect(() => navigationListener.startNavigation({ route: "/checkout" })).not.toThrow();
    });

    it("does not throw into the caller when `location` is missing entirely", () => {
      vi.stubGlobal("location", undefined);

      expect(() => navigationListener.startNavigation({ route: "/checkout" })).not.toThrow();
    });
  });

  describe("endNavigation", () => {
    beforeEach(() => {
      vi.stubGlobal("location", {
        href: "https://example.com/test-page",
      });
    });

    it("should complete active navigation and trigger event", () => {
      const startMetadata = { source: "start" };
      const endMetadata = { result: "success" };
      const startTime = 1000;
      const endTime = 1500;

      // Start navigation
      vi.spyOn(Date, 'now').mockReturnValueOnce(startTime);
      navigationListener.startNavigation(startMetadata);

      // Mock Date.now for endTime
      vi.spyOn(Date, 'now').mockReturnValueOnce(endTime);
      navigationListener.endNavigation(endMetadata);

      // @ts-expect-error - Accessing private property for testing
      const activeNavigation = navigationListener.activeNavigation;

      expect(activeNavigation).not.toBeNull();
      expect(activeNavigation!.endTime).toBe(endTime);
      expect(activeNavigation!.duration_ms).toBe(endTime - startTime);
      expect(mockEventsPool.addEvent).toHaveBeenCalledTimes(1);
    });

    it("should log the end navigation call", () => {
      const startMetadata = { source: "start" };
      const endMetadata = { result: "success" };

      navigationListener.startNavigation(startMetadata);
      navigationListener.endNavigation(endMetadata);

      expect(mockLogger.log).toHaveBeenCalledWith(
        "[navigation-listener.endNavigation] called",
        endMetadata
      );
    });

    it("should return early when no active navigation exists", () => {
      const metadata = { result: "success" };

      navigationListener.endNavigation(metadata);

      expect(mockLogger.log).toHaveBeenCalledWith(
        "[navigation-listener.endNavigation] called",
        metadata
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        "[navigation-listener.endNavigation] no active navigation found"
      );
      expect(mockEventsPool.addEvent).not.toHaveBeenCalled();
    });

    it("should create navigation event with active navigation metadata", () => {
      const startMetadata = { source: "start" };
      const startTime = 1000;
      const endTime = 1500;

      // Start navigation
      vi.spyOn(Date, 'now').mockReturnValueOnce(startTime);
      navigationListener.startNavigation(startMetadata);

      // End navigation
      vi.spyOn(Date, 'now').mockReturnValueOnce(endTime);
      navigationListener.endNavigation({});

      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation",
          attributes: expect.objectContaining({
            page_url: "https://example.com/test-page",
            "metadata.source": "start",
            duration_ms: endTime - startTime,
            start_timestamp: startTime,
            end_timestamp: endTime,
          }),
        })
      );
    });

    it("should handle zero duration navigation", () => {
      const metadata = { source: "test" };
      const sameTime = 1000;

      // Start navigation
      vi.spyOn(Date, 'now').mockReturnValue(sameTime);
      navigationListener.startNavigation(metadata);
      
      // End navigation at same time
      vi.spyOn(Date, 'now').mockReturnValue(sameTime);
      navigationListener.endNavigation(metadata);

      // @ts-expect-error - Accessing private property for testing
      const activeNavigation = navigationListener.activeNavigation;

       expect(activeNavigation).not.toBeNull();
       expect(activeNavigation!.duration_ms).toBe(0);
      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            duration_ms: 0,
          }),
        })
      );
    });

    it("should handle very long duration navigation", () => {
      const metadata = { source: "test" };
      const startTime = 1000;
      const endTime = 60000; // 59 seconds later
      const expectedDuration = endTime - startTime;

      vi.spyOn(Date, 'now').mockReturnValueOnce(startTime);
      navigationListener.startNavigation(metadata);

      vi.spyOn(Date, 'now').mockReturnValueOnce(endTime);
      navigationListener.endNavigation(metadata);

      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            "metadata.source": "test",
            duration_ms: expectedDuration,
          }),
        })
      );
    });
  });

  describe("privacy redaction", () => {
    it("redacts sensitive query params in page_url by default", () => {
      vi.stubGlobal("location", {
        href: "https://example.com/p?token=secret&page=2",
      });
      const event = navigationListener.buildEvent();
      const pageUrl = event.attributes?.["page_url"] as string;
      expect(pageUrl).not.toContain("secret");
      expect(pageUrl).toContain("page=2");
    });

    it("redacts sensitive keys in navigation metadata by default", () => {
      vi.stubGlobal("location", { href: "https://example.com/p" });
      navigationListener.startNavigation({ password: "hunter2", source: "ok" });
      const event = navigationListener.buildEvent();
      const serialized = JSON.stringify(event.attributes);
      expect(serialized).not.toContain("hunter2");
      expect(serialized).toContain("[REDACTED]");
    });
  });

  describe("integration: startNavigation and endNavigation", () => {
    beforeEach(() => {
      vi.stubGlobal("location", {
        href: "https://example.com/integration-test",
      });
    });

    it("should handle multiple start/end cycles", () => {
      const firstStart = { source: "first" };
      const firstEnd = { result: "first-success" };
      const secondStart = { source: "second" };
      const secondEnd = { result: "second-success" };

      // First navigation cycle
      vi.spyOn(Date, 'now').mockReturnValueOnce(1000);
      navigationListener.startNavigation(firstStart);
      vi.spyOn(Date, 'now').mockReturnValueOnce(1200);
      navigationListener.endNavigation(firstEnd);

      // Second navigation cycle
      vi.spyOn(Date, 'now').mockReturnValueOnce(2000);
      navigationListener.startNavigation(secondStart);
      vi.spyOn(Date, 'now').mockReturnValueOnce(2300);
      navigationListener.endNavigation(secondEnd);

      expect(mockEventsPool.addEvent).toHaveBeenCalledTimes(2);
      
      // Check that events contain the correct metadata from their respective start calls
      expect(mockEventsPool.addEvent).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          attributes: expect.objectContaining({
            "metadata.source": "first",
            duration_ms: 200,
          }),
        })
      );

      expect(mockEventsPool.addEvent).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          attributes: expect.objectContaining({
            "metadata.source": "second",
            duration_ms: 300,
          }),
        })
      );
    });

    it("should handle overlapping navigations", () => {
      const firstStart = { source: "first" };
      const secondStart = { source: "second" };
      const endMetadata = { result: "success" };

      // Start first navigation
      vi.spyOn(Date, 'now').mockReturnValueOnce(1000);
      navigationListener.startNavigation(firstStart);

      // Start second navigation (should overwrite first)
      vi.spyOn(Date, 'now').mockReturnValueOnce(1100);
      navigationListener.startNavigation(secondStart);

      // End navigation (should end the second one)
      vi.spyOn(Date, 'now').mockReturnValueOnce(1300);
      navigationListener.endNavigation(endMetadata);

      expect(mockEventsPool.addEvent).toHaveBeenCalledTimes(1);
      expect(mockEventsPool.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            "metadata.source": "second", // Should use second start metadata
            duration_ms: 200, // 1300 - 1100
            start_timestamp: 1100,
            end_timestamp: 1300,
          }),
        })
      );
    });
  });
});
