import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as errorHandler from "./error-handler";
import { PlatformStorage, SafeStorage } from "./storage";
import { MemoryStorage } from "../test-utils/memory-storage";

const hostStorage = new MemoryStorage();

describe("SafeStorage", () => {
  let handleErrorSpy: ReturnType<typeof vi.spyOn>;
  let store: Record<string, string>;
  let backend: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
  };
  let storage: SafeStorage;

  beforeEach(() => {
    handleErrorSpy = vi.spyOn(errorHandler, "handleError");
    store = {};
    backend = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    };
    storage = new SafeStorage(backend as PlatformStorage);
  });

  afterEach(() => {
    handleErrorSpy.mockRestore();
  });

  describe("getItem", () => {
    it("returns value when key exists", () => {
      storage.setItem("foo", "bar");
      expect(storage.getItem("foo")).toBe("bar");
    });

    it("returns null when key does not exist", () => {
      expect(storage.getItem("missing")).toBe(null);
    });

    it("returns null and calls handleError when getItem throws (e.g. private mode, quota)", () => {
      backend.getItem.mockImplementation(() => {
        throw new Error("Storage access denied");
      });
      expect(storage.getItem("any")).toBe(null);
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("setItem", () => {
    it("stores value when storage is available", () => {
      storage.setItem("k", "v");
      expect(storage.getItem("k")).toBe("v");
    });

    it("does not throw and calls handleError when setItem throws (e.g. quota exceeded)", () => {
      backend.setItem.mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      expect(() => storage.setItem("k", "v")).not.toThrow();
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("removeItem", () => {
    it("removes value when storage is available", () => {
      storage.setItem("k", "v");
      storage.removeItem("k");
      expect(storage.getItem("k")).toBe(null);
    });

    it("does not throw and calls handleError when removeItem throws", () => {
      backend.removeItem.mockImplementation(() => {
        throw new Error("Storage disabled");
      });
      expect(() => storage.removeItem("k")).not.toThrow();
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("getNumericItem", () => {
    it("returns parsed number when value is numeric string", () => {
      storage.setItem("n", "42");
      expect(storage.getNumericItem("n", 0)).toBe(42);
    });

    it("returns fallback when key is missing", () => {
      expect(storage.getNumericItem("missing", 99)).toBe(99);
    });

    it("returns fallback when value is not a number (NaN)", () => {
      storage.setItem("bad", "not-a-number");
      expect(storage.getNumericItem("bad", 0)).toBe(0);
    });

    it("returns fallback when value is Infinity", () => {
      storage.setItem("inf", "Infinity");
      expect(storage.getNumericItem("inf", 0)).toBe(0);
    });

    it("returns fallback when getItem throws (handleError called via getItem)", () => {
      backend.getItem.mockImplementation(() => {
        throw new Error("Storage access denied");
      });
      expect(storage.getNumericItem("any", 123)).toBe(123);
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
    });

    it("uses default fallback 0 when not provided", () => {
      expect(storage.getNumericItem("missing")).toBe(0);
    });

    it("parses integer and decimal strings", () => {
      storage.setItem("int", "1000");
      storage.setItem("dec", "3.14");
      expect(storage.getNumericItem("int", 0)).toBe(1000);
      expect(storage.getNumericItem("dec", 0)).toBe(3.14);
    });
  });

  describe("over a Web-Storage-shaped backend", () => {
    beforeEach(() => {
      hostStorage.clear();
    });

    it("round-trips values through the backend", () => {
      const real = new SafeStorage(hostStorage);
      real.setItem("foo", "bar");
      expect(real.getItem("foo")).toBe("bar");
      expect(hostStorage.getItem("foo")).toBe("bar");

      real.removeItem("foo");
      expect(real.getItem("foo")).toBe(null);
    });

    it("parses numeric values stored in the backend", () => {
      const real = new SafeStorage(hostStorage);
      real.setItem("n", "42");
      expect(real.getNumericItem("n", 0)).toBe(42);
      expect(real.getNumericItem("missing", 99)).toBe(99);
    });
  });

  describe("over a null backend (platform without storage)", () => {
    let nullStorage: SafeStorage;

    beforeEach(() => {
      nullStorage = new SafeStorage(null);
    });

    it("getItem returns null without calling handleError", () => {
      expect(nullStorage.getItem("any")).toBe(null);
      expect(handleErrorSpy).not.toHaveBeenCalled();
    });

    it("setItem and removeItem are silent no-ops", () => {
      expect(() => nullStorage.setItem("k", "v")).not.toThrow();
      expect(() => nullStorage.removeItem("k")).not.toThrow();
      expect(nullStorage.getItem("k")).toBe(null);
      expect(handleErrorSpy).not.toHaveBeenCalled();
    });

    it("getNumericItem returns the fallback", () => {
      expect(nullStorage.getNumericItem("any", 123)).toBe(123);
      expect(nullStorage.getNumericItem("any")).toBe(0);
    });
  });
});
