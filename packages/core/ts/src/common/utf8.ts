import { strToU8 } from "fflate";

// UTF-8 for the wire, exact on every host.
//
// fflate's `strToU8` uses the global TextEncoder when one existed when fflate
// was imported, and otherwise its own encoder, whose surrogate-pair arithmetic
// is wrong: "🎉" comes out F0 9D AE 89 instead of F0 9F 8E 89. That fallback is
// what runs on JSC and on Hermes before RN 0.74. Core may not reach for
// TextEncoder itself (it is not on every host; see eslint.config.mjs), so it
// asks fflate once, at load, whether it encodes an astral character right:
// the same moment fflate made its own choice. If it does, every call goes to
// fflate (native speed where TextEncoder exists); if not, to the encoder below.

const PROBE = "\u{1F389}";
const PROBE_UTF8 = [0xf0, 0x9f, 0x8e, 0x89];

const fflateEncodesExactly: boolean = (() => {
  try {
    const bytes = strToU8(PROBE);
    return bytes.length === PROBE_UTF8.length && PROBE_UTF8.every((byte, i) => bytes[i] === byte);
  } catch {
    return false;
  }
})();

/** UTF-8 bytes of `text`, identical to `new TextEncoder().encode(text)` on any host. */
export function encodeUtf8(text: string): Uint8Array {
  return fflateEncodesExactly ? strToU8(text) : encodeUtf8ByHand(text);
}

/**
 * The encoder used when the host has no TextEncoder. Matches TextEncoder byte
 * for byte, including the 3-byte U+FFFD it writes for a lone surrogate.
 * Exported for tests; call {@link encodeUtf8}.
 */
export function encodeUtf8ByHand(text: string): Uint8Array {
  const out = new Uint8Array(utf8ByteLength(text));
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      const next = text.charCodeAt(i + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    }
    if (code < 0x80) {
      out[o++] = code;
    } else if (code < 0x800) {
      out[o++] = 0xc0 | (code >> 6);
      out[o++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[o++] = 0xe0 | (code >> 12);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    } else {
      out[o++] = 0xf0 | (code >> 18);
      out[o++] = 0x80 | ((code >> 12) & 0x3f);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/**
 * UTF-8 encoded length, identical to `new TextEncoder().encode(text).length`
 * (which not every host has). A lone surrogate counts as the 3-byte U+FFFD
 * TextEncoder substitutes for it; only a high+low pair is 4 bytes.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}
