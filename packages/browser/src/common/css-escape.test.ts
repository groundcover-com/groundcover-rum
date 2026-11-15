import { describe, it, expect, afterEach, vi } from "vitest";
import { cssIdentifier, cssStringValue } from "./css-escape";

describe("cssIdentifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("escapes what utility-class frameworks put in class names", () => {
    expect(cssIdentifier("md:flex")).toBe("md\\:flex");
    expect(cssIdentifier("w-1/2")).toBe("w-1\\/2");
    expect(cssIdentifier("2xl:hidden")).toBe("\\32 xl\\:hidden");
    expect(cssIdentifier("[&>svg]:size-4")).toBe("\\[\\&\\>svg\\]\\:size-4");
  });

  it("leaves an ordinary class as it is", () => {
    expect(cssIdentifier("btn-primary_lg")).toBe("btn-primary_lg");
  });

  it("returns the class unescaped when the browser has no CSS.escape", () => {
    vi.stubGlobal("CSS", undefined);
    expect(cssIdentifier("md:flex")).toBe("md:flex");
  });
});

describe("cssStringValue", () => {
  it("escapes the quote and the backslash", () => {
    expect(cssStringValue('say "hi" in C:\\temp')).toBe('say \\"hi\\" in C:\\\\temp');
  });

  it("turns line breaks into hex escapes", () => {
    expect(cssStringValue("a\nb\rc\fd")).toBe("a\\a b\\d c\\c d");
  });

  it("leaves everything else, spaces included, as it is", () => {
    expect(cssStringValue("Save changes: 50% off!")).toBe("Save changes: 50% off!");
  });
});
