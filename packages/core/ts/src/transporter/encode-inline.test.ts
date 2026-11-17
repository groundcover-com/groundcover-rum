import { afterEach, describe, expect, it, vi } from "vitest";

const gzipFails = vi.hoisted(() => ({ value: false }));

vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return {
    ...actual,
    gzipSync: (...args: Parameters<typeof actual.gzipSync>) => {
      if (gzipFails.value) throw new Error("gzip unavailable");
      return actual.gzipSync(...args);
    },
  };
});

// Multi-byte payload so a wrong encoder can't pass by accident on ASCII:
// 2-byte "é" (C3 A9) and 3-byte "中" (E4 B8 AD), spelled out by hand.
const PAYLOAD = '{"m":"é中"}';
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const EXPECTED = [...ascii('{"m":"'), 0xc3, 0xa9, 0xe4, 0xb8, 0xad, ...ascii('"}')];

// fflate decides whether to use TextEncoder once, when it is first imported,
// so stubbing the global afterwards never reaches its fallback. Load the
// transporter fresh with the global already absent.
async function encodeInlineWithoutTextEncoder() {
  vi.stubGlobal("TextEncoder", undefined);
  vi.resetModules();
  return (await import("./transporter")).encodeInline;
}

// encodeInline is the send path on hosts without an async encoder, and not
// every one of those ships a TextEncoder global.
describe("encodeInline without a TextEncoder global", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    gzipFails.value = false;
  });

  it("encodes UTF-8 when compression is off", async () => {
    const encode = await encodeInlineWithoutTextEncoder();

    const out = encode(PAYLOAD, false);

    expect(out.isCompressed).toBe(false);
    expect(Array.from(out.data)).toEqual(EXPECTED);
  });

  it("encodes UTF-8 on the gzip-failure fallback", async () => {
    const encode = await encodeInlineWithoutTextEncoder();
    gzipFails.value = true;

    const out = encode(PAYLOAD, true);

    expect(out.isCompressed).toBe(false);
    expect(Array.from(out.data)).toEqual(EXPECTED);
  });

  // fflate's own fallback gets surrogate pairs wrong ("🚀" F0 9F 9A 80 came out
  // F0 9D AA 80), which is what JSC and Hermes before RN 0.74 used to send.
  it("encodes characters outside the BMP exactly", async () => {
    const encode = await encodeInlineWithoutTextEncoder();

    const out = encode('{"m":"🚀"}', false);

    expect(Array.from(out.data)).toEqual([...ascii('{"m":"'), 0xf0, 0x9f, 0x9a, 0x80, ...ascii('"}')]);
  });

  it("writes U+FFFD for a lone surrogate, as TextEncoder does", async () => {
    const encode = await encodeInlineWithoutTextEncoder();

    const out = encode("a\ud800b", false);

    expect(Array.from(out.data)).toEqual([0x61, 0xef, 0xbf, 0xbd, 0x62]);
  });

  it("gzips the exact bytes", async () => {
    const encode = await encodeInlineWithoutTextEncoder();
    const { gunzipSync } = await import("fflate");

    const out = encode('{"m":"🎉 é中"}', true);

    expect(out.isCompressed).toBe(true);
    expect(Array.from(gunzipSync(out.data))).toEqual([
      ...ascii('{"m":"'), 0xf0, 0x9f, 0x8e, 0x89, 0x20, 0xc3, 0xa9, 0xe4, 0xb8, 0xad, ...ascii('"}'),
    ]);
  });
});
