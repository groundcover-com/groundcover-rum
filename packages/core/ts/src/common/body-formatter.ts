import { handleError } from "./error-handler";

export function formatBody(
  body: unknown,
): string {
  try {
    if (body === null || body === undefined) {
      return "";
    }

    if (typeof body === "string") {
      return body;
    }

    // The body types below are OPTIONAL host globals, not core ECMAScript:
    // types/host-globals.d.ts declares them possibly-absent, and a host that
    // lacks one would throw ReferenceError on a bare `instanceof`.
    // Every probe is `typeof`-guarded for that reason — the eslint-disable
    // marks them as deliberate optional-capability checks rather than the
    // platform coupling `no-restricted-globals` is there to catch.
    /* eslint-disable no-restricted-globals */
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return "[form data]";
    }

    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return "[blob data]";
    }

    if (body instanceof ArrayBuffer) {
      return "[arraybuffer data]";
    }

    // Typed arrays (Uint8Array, …) and DataView are ArrayBuffer VIEWS, not
    // `instanceof ArrayBuffer`; without this they'd JSON.stringify to a
    // numeric-keyed object and leak raw upload bytes.
    if (ArrayBuffer.isView(body)) {
      return "[arraybuffer data]";
    }

    // A ReadableStream body (fetch upload streaming) has no readable snapshot to
    // record here and JSON.stringify would emit "{}"; placeholder it instead.
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      return "[stream data]";
    }

    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      try {
        return body.toString();
      } catch {
        return "[unreadable body]";
      }
    }
    /* eslint-enable no-restricted-globals */

    if (Array.isArray(body)) {
      return JSON.stringify(body);
    }

    if (typeof body === "object") {
      return JSON.stringify(body);
    }

    return String(body);
  } catch (error) {
    handleError(`Failed to format body: ${error}`);
    return "[unreadable body]";
  }
}

