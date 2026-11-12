import { describe, it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import { capturedError, capturedValueOf, coerceToError } from "./coerce-error";

describe("coerceToError", () => {
  it("returns an Error as-is, keeping its own name", () => {
    const error = new TypeError("bad");

    expect(coerceToError(error, "UnhandledRejection")).toBe(error);
    expect(error.name).toBe("TypeError");
  });

  it("returns an Error from another realm as-is", () => {
    const foreign = runInNewContext('new TypeError("bad input")') as Error;
    expect(foreign instanceof Error).toBe(false);

    const error = coerceToError(foreign);
    expect(error).toBe(foreign);
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("bad input");
  });

  it("uses an Error-like object's own name, message and stack", () => {
    const value = {
      name: "ApiError",
      message: "quota exceeded",
      stack: "ApiError: quota exceeded\n    at load (https://app.example/main.js:3:7)",
      status: 429,
    };
    const error = coerceToError(value);

    expect(error.name).toBe("ApiError");
    expect(error.message).toBe("quota exceeded");
    expect(error.stack).toBe(value.stack);
    expect(capturedValueOf(error)).toBe(value);
  });

  it("gives an Error-like object without a name the default name", () => {
    expect(coerceToError({ message: "x" }).name).toBe("Error");
    expect(coerceToError({ message: "x" }, "UnhandledRejection").name).toBe("UnhandledRejection");
  });

  it("uses String() for a primitive", () => {
    expect(coerceToError("boom").message).toBe("boom");
    expect(coerceToError(42).message).toBe("42");
    expect(coerceToError(null).message).toBe("null");
    expect(coerceToError(undefined).message).toBe("undefined");
    expect(capturedValueOf(coerceToError("boom"))).toBeUndefined();
  });

  it("names a plain object by its sorted keys, not its values", () => {
    const first = coerceToError({ requestId: "ff599b27", code: "PAYMENT_DECLINED" });
    const second = coerceToError({ code: "PAYMENT_DECLINED", requestId: "f4940978" });

    expect(first.message).toBe("Object captured as exception with keys: code, requestId");
    expect(second.message).toBe(first.message);
  });

  it("names a class instance by its class", () => {
    class FakeResponse {}
    class Order {
      id = 1;
      self: unknown = this;
    }

    expect(coerceToError(new FakeResponse()).message).toBe("FakeResponse captured as exception");
    expect(coerceToError(new Order()).message).toBe("Order captured as exception with keys: id, self");
    expect(coerceToError(new Map([["a", 1]])).message).toBe("Map captured as exception");
  });

  it("counts an array's items", () => {
    expect(coerceToError([1, 2, 3]).message).toBe("Array captured as exception with 3 items");
    expect(coerceToError(["a"]).message).toBe("Array captured as exception with 1 item");
  });

  it("names a function without its source", () => {
    function loadCart() {
      return "source that must not ship";
    }

    expect(coerceToError(loadCart).message).toBe("Function captured as exception");
  });

  it("says promise rejection for an unhandled rejection", () => {
    expect(coerceToError({ code: 1 }, "UnhandledRejection").message).toBe(
      "Object captured as promise rejection with keys: code"
    );
  });

  it("caps a long key list", () => {
    const value = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field_number_${i}`, i]));
    const message = coerceToError(value).message;

    expect(message.startsWith("Object captured as exception with keys: field_number_0, ")).toBe(true);
    expect(message.endsWith(", …")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it("never throws, even for a value that throws on every read", () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = new Proxy({}, {
      get() { throw new Error("no reads"); },
      getPrototypeOf() { throw new Error("no prototype"); },
      ownKeys() { throw new Error("no keys"); },
    });
    const throwingFn = Object.assign(() => 0, {
      toString() { throw new Error("no string"); },
    });

    expect(coerceToError(revoked).message).toBe("Object captured as exception");
    expect(coerceToError(hostile).message).toBe("Object captured as exception");
    expect(coerceToError(throwingFn).message).toBe("Function captured as exception");
  });

  it("keeps the value of an object, and only an object, for the event's metadata", () => {
    const value = { code: 1 };

    expect(capturedValueOf(coerceToError(value))).toBe(value);
    expect(capturedValueOf(coerceToError("x"))).toBeUndefined();
    expect(capturedValueOf(new Error("x"))).toBeUndefined();
  });

  it("adds no enumerable properties to the Error it builds", () => {
    expect(Object.keys(coerceToError({ code: 1 }, "UnhandledRejection"))).toEqual([]);
  });
});

describe("capturedError", () => {
  it("builds a named Error that carries a value for the event's metadata", () => {
    const error = capturedError("Event captured as exception (type=error)", "Error", { type: "error" });

    expect(error.name).toBe("Error");
    expect(error.message).toBe("Event captured as exception (type=error)");
    expect(capturedValueOf(error)).toEqual({ type: "error" });
  });
});
