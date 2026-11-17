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

  it("still sends a batch with characters outside the BMP — encoded wrongly", async () => {
    // A known limitation of fflate's fallback (see the RN README's encoding
    // note): a surrogate pair is mis-encoded, "🚀" F0 9F 9A 80 → F0 9D AA 80.
    // The batch is delivered, not dropped; hosts with TextEncoder are exact.
    const encode = await encodeInlineWithoutTextEncoder();

    const out = encode('{"m":"🚀"}', false);

    expect(out.data.length).toBe(12);
    expect(Array.from(out.data.slice(6, 10))).toEqual([0xf0, 0x9d, 0xaa, 0x80]);
  });
});
