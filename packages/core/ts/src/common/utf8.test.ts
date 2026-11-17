import { describe, expect, it } from "vitest";
import { encodeUtf8, encodeUtf8ByHand } from "./utf8";

// The reference implementation core itself can't use (not every host has it);
// these tests run on Node, which does.
// eslint-disable-next-line no-restricted-globals
const reference = (text: string) => Array.from(new TextEncoder().encode(text));

const CASES: Array<[string, string]> = [
  ["empty", ""],
  ["ascii", "hello"],
  ["2-byte", "héllo"],
  ["3-byte", "€ 中文"],
  ["4-byte pairs", "🎉 😀 𝄞"],
  ["lone high surrogate at end", "a\ud800"],
  ["lone high surrogate before a 2-byte char", "\ud800é"],
  ["lone low surrogate", "a\udc00b"],
  ["reversed pair", "\udc00\ud800"],
  ["high, high, low", "\ud800𐀀"],
  ["code point boundaries", "\u007f\u0080߿ࠀ￿\u{10000}\u{10ffff}"],
];

describe("encodeUtf8ByHand", () => {
  it.each(CASES)("matches TextEncoder: %s", (_label, text) => {
    expect(Array.from(encodeUtf8ByHand(text))).toEqual(reference(text));
  });

  it("matches TextEncoder on random UTF-16", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let n = 0; n < 500; n++) {
      let text = "";
      const len = rand() % 40;
      for (let i = 0; i < len; i++) text += String.fromCharCode(rand() % 0x10000);
      expect(Array.from(encodeUtf8ByHand(text))).toEqual(reference(text));
    }
  });
});

describe("encodeUtf8", () => {
  it.each(CASES)("matches TextEncoder on a host that has one: %s", (_label, text) => {
    expect(Array.from(encodeUtf8(text))).toEqual(reference(text));
  });
});
