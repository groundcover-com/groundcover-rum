import { describe, it, expect } from "vitest";
import { cssIdentifier, cssStringValue } from "./css-escape";

describe("cssIdentifier", () => {
  // CSS.escape is the reference: cssIdentifier is its serialization, written out
  // so it doesn't depend on the browser having CSS.escape.
  it.each([
    "btn",
    "btn-primary_lg",
    "md:flex",
    "w-1/2",
    "2xl:hidden",
    "-",
    "-2x",
    "--var",
    "a b",
    "[&>svg]:size-4",
    "é",
    "tab\tbed",
  ])("serializes %j as CSS.escape does", (value) => {
    expect(cssIdentifier(value)).toBe(CSS.escape(value));
  });

  it("replaces NUL with U+FFFD, as CSS.escape does", () => {
    expect(cssIdentifier("a\u0000b")).toBe("a\uFFFDb");
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
