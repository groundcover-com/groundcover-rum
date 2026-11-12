import { describe, it, expect } from "vitest";
import {
  NETWORK_BODY_PLACEHOLDER,
  binaryLabel,
  capBody,
  classifyBody,
  isEventStream,
  isKnownEmptyResponse,
  isTextualContentType,
  mimeEssence,
  utf8ByteLength,
} from "./body";

describe("mimeEssence", () => {
  it("strips parameters and lowercases", () => {
    expect(mimeEssence("application/JSON; charset=utf-8")).toBe("application/json");
    expect(mimeEssence("")).toBe("");
  });
});

describe("isTextualContentType", () => {
  it("accepts text and structured-syntax types", () => {
    for (const ct of [
      "text/plain",
      "text/html; charset=utf-8",
      "application/json",
      "application/problem+json",
      "application/atom+xml",
      "application/xml",
      "application/x-www-form-urlencoded",
      "application/javascript",
      "application/graphql",
    ]) {
      expect(isTextualContentType(ct)).toBe(true);
    }
  });

  it("rejects binary and lookalike subtypes", () => {
    for (const ct of [
      "",
      "application/octet-stream",
      "image/png",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/jsonx",
    ]) {
      expect(isTextualContentType(ct)).toBe(false);
    }
  });
});

describe("binaryLabel", () => {
  it.each([
    ["image/png", "[image data]"],
    ["audio/mpeg", "[audio data]"],
    ["video/mp4", "[video data]"],
    ["font/woff2", "[font data]"],
    ["application/font-woff", "[font data]"],
    ["application/vnd.ms-fontobject", "[font data]"],
    ["application/pdf", "[pdf data]"],
    ["application/zip", "[archive data]"],
    ["application/x-gzip", "[archive data]"],
    ["application/wasm", "[wasm data]"],
    ["application/x-protobuf", "[protobuf data]"],
    ["application/grpc-web+proto", "[protobuf data]"],
    ["application/octet-stream", "[binary data]"],
  ])("%s → %s", (ct, label) => {
    expect(binaryLabel(ct)).toBe(label);
  });
});

describe("classifyBody", () => {
  it("returns null for a textual body (read it)", () => {
    expect(classifyBody("application/json")).toBeNull();
  });

  it("labels multipart as form data", () => {
    expect(classifyBody("multipart/form-data; boundary=x")).toBe(NETWORK_BODY_PLACEHOLDER.formData);
  });

  it("fails closed on an absent or opaque content-type", () => {
    expect(classifyBody("")).toBe(NETWORK_BODY_PLACEHOLDER.binary);
    expect(classifyBody("application/octet-stream")).toBe(NETWORK_BODY_PLACEHOLDER.binary);
    expect(classifyBody("image/png")).toBe("[image data]");
  });
});

describe("isKnownEmptyResponse", () => {
  it("recognizes HEAD, null-body statuses and content-length 0", () => {
    expect(isKnownEmptyResponse({ method: "head", status: 200, headers: {} })).toBe(true);
    for (const status of [204, 205, 304]) {
      expect(isKnownEmptyResponse({ method: "GET", status, headers: {} })).toBe(true);
    }
    expect(isKnownEmptyResponse({ method: "GET", status: 200, headers: { "content-length": " 0" } })).toBe(true);
  });

  it("assumes nothing about any other response", () => {
    expect(isKnownEmptyResponse({ method: "GET", status: 200, headers: {} })).toBe(false);
    expect(isKnownEmptyResponse({ status: 200, headers: { "content-length": "10" } })).toBe(false);
  });
});

describe("isEventStream", () => {
  it("matches the SSE essence only", () => {
    expect(isEventStream("text/event-stream; charset=utf-8")).toBe(true);
    expect(isEventStream("text/plain")).toBe(false);
    expect(isEventStream("")).toBe(false);
  });
});

describe("capBody", () => {
  const TOO_LARGE = "[too large]";

  it("keeps a body under the cap", () => {
    expect(capBody("abc", 5, TOO_LARGE)).toBe("abc");
    expect(capBody("", 5, TOO_LARGE)).toBe("");
  });

  it("replaces a body at or over the cap — never truncates", () => {
    expect(capBody("abcde", 5, TOO_LARGE)).toBe(TOO_LARGE);
    expect(capBody("abcdef", 5, TOO_LARGE)).toBe(TOO_LARGE);
  });

  it("measures UTF-8 bytes, not characters", () => {
    // 2 chars, 6 bytes.
    expect(capBody("€€", 6, TOO_LARGE)).toBe(TOO_LARGE);
    expect(capBody("€€", 7, TOO_LARGE)).toBe("€€");
  });
});

describe("utf8ByteLength", () => {
  // The reference implementation core itself can't use (not every host has
  // it); these tests run on Node, which does.
  // eslint-disable-next-line no-restricted-globals
  const reference = (text: string) => new TextEncoder().encode(text).length;

  it.each([
    ["empty", ""],
    ["ascii", "hello"],
    ["2-byte", "héllo"],
    ["3-byte", "€ 中文"],
    ["4-byte pair", "😀 𝄞"],
    ["lone high surrogate at end", "a\ud800"],
    ["lone high surrogate before a 2-byte char", "\ud800é"],
    ["lone high surrogate before ascii", "\ud800a"],
    ["lone low surrogate", "a\udc00b"],
    ["reversed pair", "\udc00\ud800"],
    ["high, high, low", "\ud800𐀀"],
  ])("matches TextEncoder: %s", (_label, text) => {
    expect(utf8ByteLength(text)).toBe(reference(text));
  });

  it("matches TextEncoder on random UTF-16", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let n = 0; n < 500; n++) {
      let text = "";
      const len = rand() % 40;
      for (let i = 0; i < len; i++) text += String.fromCharCode(rand() % 0x10000);
      expect(utf8ByteLength(text)).toBe(reference(text));
    }
  });
});
