import { describe, it, expect } from "vitest";
import { formatWebBody } from "./web-body";

describe("formatWebBody", () => {
  it('returns "[document data]" for a Document', () => {
    const doc = document.implementation.createHTMLDocument("Test");
    expect(formatWebBody(doc)).toBe("[document data]");
  });

  it("delegates everything else to core's formatter", () => {
    expect(formatWebBody("plain")).toBe("plain");
    expect(formatWebBody({ a: 1 })).toBe('{"a":1}');
  });

  it("contains a body whose nodeType getter throws, like core's formatter", () => {
    const hostile = {
      get nodeType(): number {
        throw new Error("hostile getter");
      },
    };
    let result: string | undefined;
    expect(() => {
      result = formatWebBody(hostile);
    }).not.toThrow();
    expect(result).toBe("[unreadable body]");
  });

  it("does not crash on other DOM nodes", () => {
    expect(typeof formatWebBody(document.createDocumentFragment())).toBe("string");
    expect(typeof formatWebBody(document.createElement("div"))).toBe("string");
  });
});
