import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConfigManager } from "@groundcover/rum-core/config/config-manager";

describe("SDK updateConfig Integration", () => {
  let sdk: (typeof import("./index"))["default"];

  beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    delete window.groundcover;
    sdk = (await import("./index")).default;
  });

  afterEach(() => {
    sdk.logger.manager?.destroy();
    vi.restoreAllMocks();
    sessionStorage.clear();
    delete window.groundcover;
  });

  describe("updateConfig functionality", () => {
    it("should not crash when updateConfig is called before initialization", () => {
      expect(() => {
        sdk.updateConfig({
          options: {
            debug: true,
          },
        });
      }).not.toThrow();
    });

    it("should not crash when updateConfig is called with empty object", () => {
      expect(() => {
        sdk.updateConfig({});
      }).not.toThrow();
    });

    it("should not crash when updateConfig is called with options", () => {
      expect(() => {
        sdk.updateConfig({
          options: {
            debug: true,
            transport: {
              batchSize: 50,
              batchTimeout: 2000,
            },
          },
        });
      }).not.toThrow();
    });

    it("should not crash when updateConfig is called with user", () => {
      expect(() => {
        sdk.updateConfig({
          user: {
            id: "test-user",
            email: "test@example.com",
          },
        });
      }).not.toThrow();
    });

    it("should not crash when updateConfig is called with both options and user", () => {
      expect(() => {
        sdk.updateConfig({
          options: {
            debug: false,
            transport: {
              batchSize: 25,
            },
          },
          user: {
            id: "updated-user",
            email: "updated@example.com",
            name: "Updated User",
          },
        });
      }).not.toThrow();
    });

    it("should handle updateConfig after initialization without crashing", () => {
      expect(() => {
        // Initialize first
        sdk.init({
          appId: "test-app",
          options: {
            debug: false,
          },
        });

        // Then update config
        sdk.updateConfig({
          options: {
            debug: true,
            transport: {
              batchSize: 30,
            },
          },
          user: {
            id: "post-init-user",
            email: "post-init@example.com",
          },
        });
      }).not.toThrow();

      const config = (
        sdk.logger.manager as unknown as { core: { config: ConfigManager } }
      ).core.config.getConfig();
      expect(config).toMatchObject({
        options: { debug: true, transport: { batchSize: 30 } },
        user: { id: "post-init-user", email: "post-init@example.com" },
      });
    });
  });

  describe("updateConfig method availability", () => {
    it("should have updateConfig method available on SDK", () => {
      expect(typeof sdk.updateConfig).toBe("function");
    });

    it("should accept partial SDKConfig objects", () => {
      // This test verifies the method signature accepts the right types
      const validUpdateParams = [
        { options: { debug: true } },
        { user: { id: "test" } },
        { options: { transport: { batchSize: 10 } }, user: { email: "test@test.com" } },
        {},
      ];

      validUpdateParams.forEach((params) => {
        expect(() => {
          sdk.updateConfig(params);
        }).not.toThrow();
      });
    });
  });

  describe("updateConfig type contract", () => {
    it("accepts browser-only privacy options like maskSelectors (compile-time)", () => {
      // Type guard. Core's PrivacyOptions has no `maskSelectors` — a documented
      // browser-only option — so typing updateConfig with core `SDKConfig` would
      // make `tsc --noEmit` (run via the test pipeline's build step) fail here
      // with TS2353 "maskSelectors does not exist in type PrivacyOptions". This
      // call must COMPILE. At runtime it's a no-op — the type is the assertion.
      expect(() =>
        sdk.updateConfig({
          options: { privacy: { maskSelectors: [".secret", "#token"] } },
        })
      ).not.toThrow();
    });

    it("rejects sessionId — session identity is rebound via setSessionId (compile-time)", () => {
      // SDKConfig.updateConfig ignores `sessionId`, so accepting it (e.g. via
      // Partial<SDKConfigInput>) would make updateConfig({ sessionId }) a silent
      // no-op. It must NOT compile — if it did, the @ts-expect-error below would
      // be an unused directive and `tsc --noEmit` would fail. Session identity
      // is rebound via setSessionId.
      expect(() =>
        // @ts-expect-error sessionId is not a valid updateConfig field
        sdk.updateConfig({ sessionId: "not-a-config-field" })
      ).not.toThrow();
    });

    it("rejects appId at compile time", () => {
      expect(() =>
        // @ts-expect-error App identity is fixed at initialization.
        sdk.updateConfig({ appId: "not-an-update-field" })
      ).not.toThrow();
    });

    it("accepts user: null to clear identity (compile-time)", () => {
      // Type guard. SDKConfig.updateConfig explicitly treats `user: null` as
      // "clear the current identity" (SDKConfig.user is
      // `Partial<UserIdentifiers> | null`). Deriving the update type from
      // SDKConfigInput alone (whose `user` has no null) would narrow that away
      // and stop this documented runtime call from compiling. It must COMPILE.
      expect(() => sdk.updateConfig({ user: null })).not.toThrow();
    });
  });
});
