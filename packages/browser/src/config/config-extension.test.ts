import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SDKConfig } from "@groundcover/rum-core/config/sdk-config";
import type { SDKConfigInput } from "@groundcover/rum-core/config/types";
import { DEFAULT_SDK_CONFIG_OPTIONS } from "@groundcover/rum-core/config/constants";
import { BROWSER_CONFIG_EXTENSION } from "./config-extension";

const CREDS = { apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a" };

// The browser's config schema runs through core's real SDKConfig, so these pin
// the browser-visible merge/migration behavior end to end.
const browserConfig = (input: SDKConfigInput) => new SDKConfig(input, BROWSER_CONFIG_EXTENSION);

describe("browser config extension", () => {
  describe("replay option slots", () => {
    it("defaults options.replay to its own object per instance", () => {
      const a = browserConfig({ ...CREDS });
      const b = browserConfig({ ...CREDS });
      const replayOf = (c: SDKConfig) => (c.options as { replay?: unknown }).replay;

      expect(replayOf(a)).toEqual({});
      expect(replayOf(a)).not.toBe(replayOf(b));
    });

    it("merges a partial privacy.replay instead of dropping the other callback", () => {
      const maskTextFn = (t: string) => t;
      const maskInputFn = (t: string) => t;
      const newMaskTextFn = (t: string) => `${t}!`;

      const config = browserConfig({
        ...CREDS,
        options: { privacy: { replay: { maskTextFn, maskInputFn } } } as never,
      });

      config.updateConfig({
        options: { privacy: { replay: { maskTextFn: newMaskTextFn } } } as never,
      });

      const replay = (config.options.privacy as { replay?: Record<string, unknown> }).replay;
      expect(replay?.maskTextFn).toBe(newMaskTextFn);
      // The sibling callback must not be dropped by the partial replay update.
      expect(replay?.maskInputFn).toBe(maskInputFn);
    });

    it("merges a partial replay.canvas instead of dropping `enabled`", () => {
      const config = browserConfig({
        ...CREDS,
        options: { replay: { canvas: { enabled: true, imageType: "image/jpeg" } } } as never,
      });

      config.updateConfig({
        options: { replay: { canvas: { fps: 8 } } } as never,
      });

      const replay = (config.options as { replay?: Record<string, unknown> }).replay;
      // A fps-only update must not silently switch canvas capture off.
      expect(replay?.canvas).toEqual({ enabled: true, imageType: "image/jpeg", fps: 8 });
    });
  });

  describe("removed legacy masking options", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns when the removed `enableMasking` option is passed", () => {
      browserConfig({
        ...CREDS,
        options: { enableMasking: true } as unknown as never,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("enableMasking"));
    });

    it("warns when the removed `maskFields` option is passed", () => {
      browserConfig({
        ...CREDS,
        options: { maskFields: ["ssn"] } as unknown as never,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("maskFields"));
    });

    it("does not warn for a config free of removed options", () => {
      browserConfig({ ...CREDS, options: { privacy: { level: "mask-all" } } });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn for a removed key only inherited from the prototype", () => {
      // `enableMasking` lives on the prototype, not as an own property — it was
      // never actually passed, so it must not trigger a migration warning.
      const opts = Object.create({ enableMasking: true });
      browserConfig({ ...CREDS, options: opts });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("strips removed flags from the stored options (not just warns)", () => {
      const config = browserConfig({
        ...CREDS,
        options: { enableMasking: true, maskFields: ["x"] } as unknown as never,
      });
      expect(Object.hasOwn(config.options, "enableMasking")).toBe(false);
      expect(Object.hasOwn(config.options, "maskFields")).toBe(false);
      expect(Object.hasOwn(config.providedOptions ?? {}, "enableMasking")).toBe(false);
      expect(Object.hasOwn(config.providedOptions ?? {}, "maskFields")).toBe(false);
    });

    it("warns on updateConfig too", () => {
      const config = browserConfig({ ...CREDS });
      warnSpy.mockClear();
      config.updateConfig({
        options: { enableMasking: false } as unknown as never,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT fall back — `enableMasking: false` does not become level 'allow'", () => {
      // Breaking change: the legacy option is ignored, not reinterpreted. Masking
      // stays at the default level; providedOptions carries no privacy.level.
      const config = browserConfig({
        ...CREDS,
        options: { enableMasking: false } as unknown as never,
      });
      expect(config.providedOptions?.privacy?.level).toBeUndefined();
      // The effective level must also stay at the default — guards against the
      // legacy flag leaking into the resolved privacy config.
      expect(config.options.privacy?.level).toBe(DEFAULT_SDK_CONFIG_OPTIONS.privacy?.level);
    });

    it("does not throw if the host's console.warn throws", () => {
      // A host page that patches console.warn to throw must not be able to abort
      // SDK init via the removed-option warning.
      warnSpy.mockImplementation(() => {
        throw new Error("patched console.warn");
      });
      expect(
        () =>
          browserConfig({
            ...CREDS,
            options: { enableMasking: true } as unknown as never,
          })
      ).not.toThrow();
    });
  });

  describe("removed event sampling option", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      warnSpy.mockClear();
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it.each([0, 0.05, 1, undefined])("warns and strips eventSampleRate %s on initialization without changing session sampling", (eventSampleRate) => {
      const options = { eventSampleRate, sessionSampleRate: 0.25 };
      const config = browserConfig({ ...CREDS, options });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("`options.eventSampleRate` was removed and is ignored")
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("options.sessionSampleRate"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Migrating from 1.x to 2.0.0"));
      expect(config.options).not.toHaveProperty("eventSampleRate");
      expect(config.providedOptions).not.toHaveProperty("eventSampleRate");
      expect(config.options.sessionSampleRate).toBe(0.25);
      expect(config.providedOptions?.sessionSampleRate).toBe(0.25);
      expect(options).toHaveProperty("eventSampleRate", eventSampleRate);
    });

    it("warns and strips eventSampleRate on updates without dropping supported changes", () => {
      const config = browserConfig({ ...CREDS });
      expect(warnSpy).not.toHaveBeenCalled();
      const options = { eventSampleRate: 0.05, transport: { batchSize: 25 } };

      config.updateConfig({ options });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("`options.eventSampleRate` was removed and is ignored")
      );
      expect(config.options).not.toHaveProperty("eventSampleRate");
      expect(config.providedOptions).not.toHaveProperty("eventSampleRate");
      expect(config.options.sessionSampleRate).toBe(DEFAULT_SDK_CONFIG_OPTIONS.sessionSampleRate);
      expect(config.providedOptions).not.toHaveProperty("sessionSampleRate");
      expect(config.options.transport?.batchSize).toBe(25);
      expect(config.providedOptions?.transport?.batchSize).toBe(25);
      expect(options.eventSampleRate).toBe(0.05);
    });

    it("ignores an inherited eventSampleRate without warning", () => {
      const options = Object.create({ eventSampleRate: 0.05 });
      const config = browserConfig({ ...CREDS, options });
      config.updateConfig({ options });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(config.options).not.toHaveProperty("eventSampleRate");
      expect(config.providedOptions).not.toHaveProperty("eventSampleRate");
    });

    it("still strips eventSampleRate when the host's console.warn throws", () => {
      warnSpy.mockImplementation(() => {
        throw new Error("patched console.warn");
      });
      const options = { eventSampleRate: 0.05, sessionSampleRate: 1 };
      const config = browserConfig({ ...CREDS, options });

      expect(config.options).not.toHaveProperty("eventSampleRate");
      expect(config.providedOptions).not.toHaveProperty("eventSampleRate");
      expect(() => config.updateConfig({ options })).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(config.options).not.toHaveProperty("eventSampleRate");
      expect(config.providedOptions).not.toHaveProperty("eventSampleRate");
    });
  });
});
