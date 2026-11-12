// Request/response body classification and capping, shared by every
// platform's network capture. Reading a body (streams, FileReader, clone()) is
// transport-specific and stays in the platform; deciding WHETHER to read it,
// and what a body that can't be kept becomes, lives here so both platforms
// emit the same placeholders for the same payloads.

// Emitted in place of a body that redaction can't safely handle (binary,
// oversized, or partial/slow). A truncated prefix would break redactBody, so a
// body is either complete or a placeholder — never cut.
export const NETWORK_BODY_PLACEHOLDER = {
  requestTooLarge: "[request body too large]",
  requestUnavailable: "[request body unavailable]",
  responseTooLarge: "[response body too large]",
  responseUnavailable: "[response body unavailable]",
  responseUnreadable: "[unreadable response body]",
  formData: "[form data]",
  binary: "[binary data]",
} as const;

// MIME essence: type without parameters, lowercased (e.g. "application/json"
// from "application/JSON; charset=utf-8").
export function mimeEssence(contentType: string): string {
  return (contentType.split(";")[0] || "").trim().toLowerCase();
}

export function isTextualContentType(contentType: string): boolean {
  // Match the MIME essence with precise rules, not substrings: `includes("xml")`
  // would pass xlsx/docx and leak binary uploads. Absent/opaque → not textual.
  const mime = mimeEssence(contentType);
  if (!mime) return false;
  if (mime.startsWith("text/")) return true;
  if (
    mime === "application/x-www-form-urlencoded" ||
    mime === "application/javascript" ||
    mime === "application/ecmascript" ||
    mime === "application/graphql"
  ) {
    return true;
  }
  // Structured JSON/XML syntaxes: application/json, application/xml, and any
  // `application/<subtype>+json` / `+xml` (e.g. application/problem+json,
  // application/atom+xml) — but not subtypes that merely contain the letters.
  return /^application\/([\w.-]+\+)?(json|xml)$/.test(mime);
}

// Descriptive, fail-closed label for a non-textual content-type: known media
// families get a specific tag, anything else → "[binary data]". Never decoded.
export function binaryLabel(contentType: string): string {
  const mime = mimeEssence(contentType);
  if (mime.startsWith("image/")) return "[image data]";
  if (mime.startsWith("audio/")) return "[audio data]";
  if (mime.startsWith("video/")) return "[video data]";
  if (mime.startsWith("font/") || mime.startsWith("application/font") || mime === "application/vnd.ms-fontobject") {
    return "[font data]";
  }
  if (mime === "application/pdf") return "[pdf data]";
  if (
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-gzip" ||
    mime === "application/x-tar" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/x-rar-compressed"
  ) {
    return "[archive data]";
  }
  if (mime === "application/wasm") return "[wasm data]";
  if (mime.includes("protobuf") || mime.startsWith("application/grpc")) return "[protobuf data]";
  return NETWORK_BODY_PLACEHOLDER.binary;
}

/**
 * The read gate for a non-empty body: multipart or non-textual → the
 * placeholder to record without reading it; textual → null (read it, capped).
 * Fails closed: an absent or opaque content-type is not read. A caller that
 * knows the body is EMPTY records "" before asking — emptiness isn't binary.
 */
export function classifyBody(contentType: string): string | null {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("multipart/form-data")) return NETWORK_BODY_PLACEHOLDER.formData;
  if (!isTextualContentType(ct)) return binaryLabel(ct);
  return null;
}

/**
 * Whether a response is known to have no body without touching it: a HEAD, a
 * null-body status (204/205/304 — where fetch exposes `response.body === null`),
 * or `content-length: 0`. Such a response records "" instead of going through
 * classifyBody, which would label its absent content-type as binary.
 */
export function isKnownEmptyResponse(response: {
  method?: string;
  status: number;
  headers: Record<string, string>;
}): boolean {
  if ((response.method || "").toUpperCase() === "HEAD") return true;
  if (response.status === 204 || response.status === 205 || response.status === 304) return true;
  return (response.headers["content-length"] ?? "").trim() === "0";
}

/** A server-sent-events stream never closes, so its body is never read. */
export function isEventStream(contentType: string): boolean {
  return mimeEssence(contentType || "") === "text/event-stream";
}

/**
 * An in-memory body, or its too-large placeholder. At/over the cap →
 * placeholder, `>=` so a body capped while streaming and one read whole are
 * treated identically. Measured in UTF-8 bytes, not UTF-16 units.
 */
export function capBody(text: string, maxBytes: number, tooLargePlaceholder: string): string {
  if (!text) return text;
  if (text.length >= maxBytes) return tooLargePlaceholder;
  if (utf8ByteLength(text) >= maxBytes) return tooLargePlaceholder;
  return text;
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
