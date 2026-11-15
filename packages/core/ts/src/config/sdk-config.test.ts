import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SDKConfig } from "./sdk-config";
import { SDKOptions } from "./types";
import { DEFAULT_SDK_CONFIG_OPTIONS, DEFAULT_SESSION_MAX_DURATION_MS } from "./constants";

const CREDS = { apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a" };

describe("SDKConfig", () => {
  describe("sessionMaxDuration validation", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("uses the 4-hour default when no value is provided", () => {
      const config = new SDKConfig({ apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a" });
      expect(config.options.sessionMaxDuration).toBe(DEFAULT_SESSION_MAX_DURATION_MS);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("preserves a valid value >= 4 hours", () => {
      const eightHours = 8 * 60 * 60 * 1000;
      const config = new SDKConfig({
        apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a",
        options: { sessionMaxDuration: eightHours },
      });
      expect(config.options.sessionMaxDuration).toBe(eightHours);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ["negative", -1],
      ["zero", 0],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["string", "4h"],
      ["below 1-minute floor", 30_000],
      ["above 8-hour ceiling", 9 * 60 * 60 * 1000],
      ["far above ceiling (24 hours)", 24 * 60 * 60 * 1000],
    ])("warns and clamps to default when value is %s", (_label, value) => {
      const config = new SDKConfig({
        apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a",
        options: { sessionMaxDuration: value as number },
      });
      expect(config.options.sessionMaxDuration).toBe(DEFAULT_SESSION_MAX_DURATION_MS);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("preserves a value at the minimum floor", () => {
      const config = new SDKConfig({
        apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a",
        options: { sessionMaxDuration: 60_000 },
      });
      expect(config.options.sessionMaxDuration).toBe(60_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("preserves a value at the maximum ceiling", () => {
      const eightHours = 8 * 60 * 60 * 1000;
      const config = new SDKConfig({
        apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a",
        options: { sessionMaxDuration: eightHours },
      });
      expect(config.options.sessionMaxDuration).toBe(eightHours);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns and clamps to default when value is null (type doesn't allow null)", () => {
      const config = new SDKConfig({
        apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a",
        options: { sessionMaxDuration: null as unknown as number },
      });
      expect(config.options.sessionMaxDuration).toBe(DEFAULT_SESSION_MAX_DURATION_MS);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("applies validation in updateConfig", () => {
      const config = new SDKConfig({ apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a" });
      config.updateConfig({ options: { sessionMaxDuration: -100 } });
      expect(config.options.sessionMaxDuration).toBe(DEFAULT_SESSION_MAX_DURATION_MS);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("updateConfig preserves valid sessionMaxDuration", () => {
      const config = new SDKConfig({ apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a" });
      const sixHours = 6 * 60 * 60 * 1000;
      config.updateConfig({ options: { sessionMaxDuration: sixHours } });
      expect(config.options.sessionMaxDuration).toBe(sixHours);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ConfigManager is not a singleton, so multiple SDKConfig instances coexist
  // in one host. Were nested groups the caller didn't provide taken straight
  // off DEFAULT_SDK_CONFIG_OPTIONS by REFERENCE, every instance would share one
  // `tracing`/`transport`/`privacy` object (and one `tracing.origin`) — a
  // single in-place mutation would leak everywhere, including into the
  // module-level defaults themselves.
  describe("nested option groups are never shared between instances", () => {
    it("gives each instance its own nested group objects", () => {
      const a = new SDKConfig({ ...CREDS });
      const b = new SDKConfig({ ...CREDS });

      for (const key of ["transport", "tracing", "privacy"] as const) {
        expect(a.options[key]).toEqual(b.options[key]);
        expect(a.options[key]).not.toBe(b.options[key]);
      }
    });

    it("does not alias the module-level defaults", () => {
      const config = new SDKConfig({ ...CREDS });

      expect(config.options.transport).not.toBe(DEFAULT_SDK_CONFIG_OPTIONS.transport);
      expect(config.options.tracing).not.toBe(DEFAULT_SDK_CONFIG_OPTIONS.tracing);
      expect(config.options.tracing?.origin).not.toBe(
        DEFAULT_SDK_CONFIG_OPTIONS.tracing?.origin
      );
    });

    it("isolates a mutation of one instance's group from every other", () => {
      const a = new SDKConfig({ ...CREDS });
      const b = new SDKConfig({ ...CREDS });
      const defaultBatchSize = DEFAULT_SDK_CONFIG_OPTIONS.transport?.batchSize;

      (a.options.transport as { batchSize: number }).batchSize = 999;

      expect(b.options.transport?.batchSize).toBe(defaultBatchSize);
      expect(DEFAULT_SDK_CONFIG_OPTIONS.transport?.batchSize).toBe(defaultBatchSize);
    });

    it("keeps groups unshared after a partial update that omits them", () => {
      const a = new SDKConfig({ ...CREDS });
      const b = new SDKConfig({ ...CREDS });
      // Snapshot BEFORE mutating: if the groups were shared, reading the
      // expectation off DEFAULT_SDK_CONFIG_OPTIONS afterwards would read the
      // mutated value and the assertion would pass vacuously.
      const defaultHeaderName = DEFAULT_SDK_CONFIG_OPTIONS.tracing?.traceIdHeaderName;

      a.updateConfig({ options: { debug: true } });
      (a.options.tracing as { traceIdHeaderName: string }).traceIdHeaderName = "x-mine";

      expect(b.options.tracing?.traceIdHeaderName).toBe(defaultHeaderName);
      expect(DEFAULT_SDK_CONFIG_OPTIONS.tracing?.traceIdHeaderName).toBe(defaultHeaderName);
    });
  });

  describe("mergeOptions nested-group null-safety", () => {
    // Untyped JS callers can pass a nested group as null/non-object. The shallow
    // spread would set the group to that value; the deep-merge must restore the
    // defaults instead of letting it wipe them.
    it("keeps transport defaults when a JS caller passes transport: null", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { transport: null } as unknown as Partial<SDKOptions>,
      });
      expect(config.options.transport).toEqual(DEFAULT_SDK_CONFIG_OPTIONS.transport);
    });

    it("keeps privacy defaults when a JS caller passes privacy: null", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { privacy: null } as unknown as Partial<SDKOptions>,
      });
      expect(config.options.privacy).toEqual(DEFAULT_SDK_CONFIG_OPTIONS.privacy);
    });

    it("ignores a non-object nested group and preserves defaults", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { tracing: "nope" } as unknown as Partial<SDKOptions>,
      });
      expect(config.options.tracing).toEqual(DEFAULT_SDK_CONFIG_OPTIONS.tracing);
    });

    it("still deep-merges a valid partial nested group", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { transport: { batchSize: 5 } },
      });
      expect(config.options.transport).toEqual({
        ...DEFAULT_SDK_CONFIG_OPTIONS.transport,
        batchSize: 5,
      });
    });

    it("ignores a nested group inherited from the prototype (not own input)", () => {
      // Pollution-safe: an inherited `transport` was never passed by the caller
      // and must not override the defaults.
      const opts = Object.create({ transport: { batchSize: 999 } });
      const config = new SDKConfig({ ...CREDS, options: opts });
      expect(config.options.transport).toEqual(DEFAULT_SDK_CONFIG_OPTIONS.transport);
    });
  });


  // A platform declares its own option slots and removed options through a
  // ConfigExtension; core owns neither set.
  describe("platform config extension", () => {
    const EXTENSION = {
      nestedOptions: { recording: [], privacy: ["masking"] },
      defaults: { recording: {} },
      removedOptions: { legacyFlag: "[groundcover] `options.legacyFlag` was removed" },
    };
    const withExtension = (options?: Record<string, unknown>) =>
      new SDKConfig({ ...CREDS, options: options as never }, EXTENSION);
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("applies the platform's defaults, never aliased between instances", () => {
      const a = withExtension();
      const b = withExtension();
      const recording = (c: SDKConfig) => (c.options as Record<string, unknown>).recording;

      expect(recording(a)).toEqual({});
      expect(recording(a)).not.toBe(recording(b));
    });

    it("merges a platform group one level deep on update", () => {
      const config = withExtension({ recording: { a: 1, b: 2 } });

      config.updateConfig({ options: { recording: { b: 3 } } as never });

      expect((config.options as Record<string, unknown>).recording).toEqual({ a: 1, b: 3 });
    });

    it("merges a platform sub-key of a core group one level deeper", () => {
      const config = withExtension({ privacy: { masking: { x: 1, y: 2 } } });

      config.updateConfig({ options: { privacy: { masking: { y: 3 } } } as never });

      const privacy = config.options.privacy as Record<string, unknown>;
      expect(privacy.masking).toEqual({ x: 1, y: 3 });
    });

    it("warns and strips a removed option on init and on update", () => {
      const config = withExtension({ legacyFlag: true });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("`options.legacyFlag` was removed"));
      expect(config.options).not.toHaveProperty("legacyFlag");
      expect(config.providedOptions).not.toHaveProperty("legacyFlag");

      warnSpy.mockClear();
      config.updateConfig({ options: { legacyFlag: false, sessionSampleRate: 0.5 } as never });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(config.options).not.toHaveProperty("legacyFlag");
      expect(config.options.sessionSampleRate).toBe(0.5);
    });

    it("ignores a removed option that is only inherited", () => {
      const config = new SDKConfig(
        { ...CREDS, options: Object.create({ legacyFlag: true }) },
        EXTENSION
      );
      expect(warnSpy).not.toHaveBeenCalled();
      expect(config.options).not.toHaveProperty("legacyFlag");
    });

    it("still strips a removed option when the host's console.warn throws", () => {
      warnSpy.mockImplementation(() => {
        throw new Error("patched console.warn");
      });
      const config = withExtension({ legacyFlag: true });
      expect(config.options).not.toHaveProperty("legacyFlag");
    });

    it("names no platform slot or removed option without an extension", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { legacyFlag: true, recording: { a: 1 } } as never,
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect((config.options as Record<string, unknown>).legacyFlag).toBe(true);
      expect(config.options).not.toHaveProperty("replay");
    });
  });

  describe("prototype-pollution safety", () => {
    it("does not pollute the prototype chain via __proto__/constructor keys", () => {
      const malicious = JSON.parse(
        '{"transport":{"batchSize":3},"__proto__":{"polluted":true},"constructor":{"x":1}}'
      );
      const config = new SDKConfig({ ...CREDS, options: malicious });

      // No global pollution, and the merged options keep a normal prototype.
      expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(config.options)).toBe(Object.prototype);
      expect(typeof config.options.hasOwnProperty).toBe("function");
      // Legit sibling still merges through.
      expect(config.options.transport?.batchSize).toBe(3);
    });

    it("does not pollute via a nested __proto__ payload", () => {
      const malicious = JSON.parse('{"transport":{"__proto__":{"polluted":true},"batchSize":7}}');
      const config = new SDKConfig({ ...CREDS, options: malicious });
      expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(config.options.transport)).toBe(Object.prototype);
      expect(config.options.transport?.batchSize).toBe(7);
    });
  });

  describe("updateConfig deep-merges two-level-deep nested objects", () => {
    it("merges a partial tracing.origin instead of dropping the sibling field", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { tracing: { origin: { name: "orig-name", value: "orig-value" } } },
      });

      config.updateConfig({ options: { tracing: { origin: { name: "new-name" } } as never } });

      // The untouched sibling (`value`) must survive the partial origin update.
      expect(config.options.tracing?.origin).toEqual({
        name: "new-name",
        value: "orig-value",
      });
    });

    it("replaces arrays wholesale rather than merging by index", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { tracing: { propagationUrls: ["https://a.com/*", "https://b.com/*"] } },
      });

      config.updateConfig({ options: { tracing: { propagationUrls: ["https://c.com/*"] } } });

      expect(config.options.tracing?.propagationUrls).toEqual(["https://c.com/*"]);
    });

    it("keeps the base deep sub-object when a partial update sets it to null", () => {
      const config = new SDKConfig({
        ...CREDS,
        options: { tracing: { origin: { name: "n", value: "v" } } },
      });

      // Untyped JS caller nulls the deep sub-object — must not wipe siblings.
      config.updateConfig({ options: { tracing: { origin: null } } as never });

      expect(config.options.tracing?.origin).toEqual({ name: "n", value: "v" });
    });
  });

  describe("updateConfig user", () => {
    it("clears the user when updateConfig is called with user: null", () => {
      const config = new SDKConfig({ ...CREDS, user: { id: "u1", email: "a@b.com" } });
      config.updateConfig({ user: null });
      expect(config.user).toBeNull();
    });

    it("merges a partial user update and leaves it untouched when user is omitted", () => {
      const config = new SDKConfig({ ...CREDS, user: { id: "u1", email: "a@b.com" } });

      config.updateConfig({ user: { id: "u2" } });
      expect(config.user).toEqual({ id: "u2", email: "a@b.com" });

      config.updateConfig({}); // user omitted → no change
      expect(config.user).toEqual({ id: "u2", email: "a@b.com" });
    });
  });

  describe("updateConfig privacy merge", () => {
    it("merges a partial privacy update instead of replacing the whole object", () => {
      const redact = () => undefined;
      const config = new SDKConfig({
        apiKey: "k", cluster: "c", environment: "e", dsn: "d", appId: "a",
        options: { privacy: { level: "mask-all", sensitiveKeys: ["x"], redact } },
      });

      config.updateConfig({ options: { privacy: { maskLogs: false } } });

      // Pre-existing privacy fields survive the partial update...
      expect(config.options.privacy?.level).toBe("mask-all");
      expect(config.options.privacy?.sensitiveKeys).toEqual(["x"]);
      expect(config.options.privacy?.redact).toBe(redact);
      // ...and the new field is applied, on both options and providedOptions.
      expect(config.options.privacy?.maskLogs).toBe(false);
      expect(config.providedOptions?.privacy?.level).toBe("mask-all");
      expect(config.providedOptions?.privacy?.maskLogs).toBe(false);
    });
  });
});
