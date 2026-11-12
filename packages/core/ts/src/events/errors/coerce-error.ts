import { truncate } from "../../common/text";

/**
 * The Error to report for whatever the app threw, rejected with or passed to
 * captureException. The browser and React Native SDKs both coerce through
 * here, so a value gives the same message, and so the same
 * `error_fingerprint`, on web and mobile.
 *
 * - An Error, from this realm or another (an iframe's), is returned as-is.
 * - An Error-like object (a string `message`) keeps its own name, message
 *   and stack.
 * - Any other object is described by its shape, never its values, so the
 *   fingerprint stays stable when a field changes per occurrence:
 *   "Object captured as exception with keys: code, requestId". The value
 *   itself rides along for `shapeErrorEvent` to send, redacted, in
 *   `error_metadata.captured_value` (see {@link capturedValueOf}).
 * - A primitive becomes `String(value)`.
 *
 * Never throws: a value whose every read throws still yields an Error.
 */
export function coerceToError(value: unknown, name = "Error"): Error {
  const kind = name === "UnhandledRejection" ? "promise rejection" : "exception";
  const type = typeof value;
  try {
    if (value instanceof Error || isBrandedError(value)) {
      return value as Error;
    }
    if (type === "function") {
      return capturedError(`Function captured as ${kind}`, name, value);
    }
    if (type === "object" && value !== null) {
      return fromObject(value as object, name, kind);
    }
    return named(new Error(String(value)), name);
  } catch {
    // A revoked Proxy, or traps that throw on the checks above.
    const label = type === "function" ? "Function" : "Object";
    return capturedError(`${label} captured as ${kind}`, name, undefined);
  }
}

/** An Error with this message and name that carries `value` for the event's
 * `error_metadata.captured_value`. Platforms use it for values they describe
 * themselves, such as a browser DOM Event. */
export function capturedError(message: string, name: string, value: unknown): Error {
  const error = named(new Error(message), name);
  if (value !== undefined) captured.set(error, value);
  return error;
}

/** The value an Error built by {@link coerceToError} or
 * {@link capturedError} stands for, or undefined. */
export function capturedValueOf(error: Error): unknown {
  return captured.get(error);
}

/**
 * The captured value as compact JSON for `error_metadata.captured_value`:
 * copied with a budget (depth, items, string length, total size) so a huge or
 * hostile value can't stall the thread, then `redact`ed field by field when
 * given, so a sensitive key's whole subtree is masked. Never throws.
 */
export function serializeCapturedValue(
  value: unknown,
  options: {
    redact?: (copy: Record<string, unknown>) => Record<string, unknown>;
    isOpaqueNode?: (value: unknown) => boolean;
  } = {}
): string | undefined {
  try {
    const copy = boundedCopy(value, 0, { visits: 0 }, new WeakSet(), options.isOpaqueNode);
    if (copy === undefined) return undefined;
    const safe =
      copy !== null && typeof copy === "object" && options.redact
        ? options.redact(copy as Record<string, unknown>)
        : copy;
    const json = typeof safe === "string" ? safe : JSON.stringify(safe);
    return json === undefined ? undefined : truncate({ text: json, maxLength: MAX_CAPTURED_LENGTH, ellipsis: "…" });
  } catch {
    return "[Unreadable]";
  }
}

const captured = new WeakMap<Error, unknown>();

const MAX_CAPTURED_LENGTH = 10_000;
const MAX_KEYS_LABEL = 120;
const MAX_KEY_LENGTH = 64;
const MAX_COPY_DEPTH = 6;
const MAX_COPY_ITEMS = 50;
const MAX_COPY_VISITS = 1_000;
const MAX_COPY_STRING = 1_000;

// Non-enumerable, like a native Error's own fields, so the Error serializes
// the same way one the app threw would.
function named(error: Error, name: string): Error {
  Object.defineProperty(error, "name", { value: name, writable: true, configurable: true, enumerable: false });
  return error;
}

// An Error made in another realm fails `instanceof Error` but still carries
// the Error brand.
function isBrandedError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    const isError = (Error as { isError?: (v: unknown) => boolean }).isError;
    if (typeof isError === "function" && isError(value)) return true;
    const tag = Object.prototype.toString.call(value);
    return tag === "[object Error]" || tag === "[object DOMException]";
  } catch {
    return false;
  }
}

function fromObject(value: object, name: string, kind: string): Error {
  const message = readString(value, "message");
  if (message !== undefined) {
    const error = capturedError(message, readString(value, "name") || name, value);
    const stack = readString(value, "stack");
    if (stack) error.stack = stack;
    return error;
  }
  if (Array.isArray(value)) {
    const count = value.length;
    return capturedError(`Array captured as ${kind} with ${count} ${count === 1 ? "item" : "items"}`, name, value);
  }
  const keys = keysLabel(value);
  const label = `${className(value)} captured as ${kind}`;
  return capturedError(keys ? `${label} with keys: ${keys}` : label, name, value);
}

function readString(value: object, key: string): string | undefined {
  try {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
  } catch {
    return undefined;
  }
}

/** The value's class name ("Object" for a plain or unnameable object). */
export function className(value: object): string {
  try {
    const proto = Object.getPrototypeOf(value) as { constructor?: unknown } | null;
    const ctor = proto?.constructor;
    const n = typeof ctor === "function" ? ctor.name : "";
    return /^[\w$]{1,64}$/.test(n) ? n : "Object";
  } catch {
    return "Object";
  }
}

function keysLabel(value: object): string {
  let keys: string[];
  try {
    keys = Object.keys(value).sort();
  } catch {
    return "";
  }
  let label = "";
  for (const key of keys) {
    const part = key.length > MAX_KEY_LENGTH ? `${key.slice(0, MAX_KEY_LENGTH)}…` : key;
    const next = label ? `${label}, ${part}` : part;
    if (next.length > MAX_KEYS_LABEL) return `${label}, …`;
    label = next;
  }
  return label;
}

function boundedCopy(
  value: unknown,
  depth: number,
  budget: { visits: number },
  seen: WeakSet<object>,
  isOpaqueNode?: (value: unknown) => boolean
): unknown {
  if (budget.visits++ >= MAX_COPY_VISITS) return "[…]";
  switch (typeof value) {
    case "string":
      return value.length > MAX_COPY_STRING ? `${value.slice(0, MAX_COPY_STRING)}…` : value;
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${functionName(value)}]`;
  }
  if (value === null) return null;
  const obj = value as object;
  if (depth > MAX_COPY_DEPTH) return "[…]";
  if (seen.has(obj)) return "[Circular]";
  try {
    if (isOpaqueNode?.(obj)) return `[${className(obj)}]`;
    if (ArrayBuffer.isView(obj)) {
      const length = (obj as { length?: unknown }).length;
      return `[${className(obj)}(${typeof length === "number" ? length : obj.byteLength})]`;
    }
    if (obj instanceof ArrayBuffer) return `[ArrayBuffer(${obj.byteLength})]`;
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "[Invalid Date]" : obj.toISOString();
    if (obj instanceof Map || obj instanceof Set) return `[${className(obj)}(${obj.size})]`;
  } catch {
    return "[Unreadable]";
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_COPY_ITEMS).map((item) => boundedCopy(item, depth + 1, budget, seen, isOpaqueNode));
      if (obj.length > MAX_COPY_ITEMS) items.push(`[… ${obj.length - MAX_COPY_ITEMS} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const key of keys.slice(0, MAX_COPY_ITEMS)) {
      let field: unknown;
      try {
        field = (obj as Record<string, unknown>)[key];
      } catch {
        field = "[Unreadable]";
      }
      out[key] = boundedCopy(field, depth + 1, budget, seen, isOpaqueNode);
    }
    if (keys.length > MAX_COPY_ITEMS) out["…"] = `${keys.length - MAX_COPY_ITEMS} more keys`;
    return out;
  } catch {
    return "[Unreadable]";
  } finally {
    seen.delete(obj);
  }
}

function functionName(fn: unknown): string {
  try {
    const n = (fn as { name?: unknown }).name;
    return typeof n === "string" && n ? n.slice(0, MAX_KEY_LENGTH) : "anonymous";
  } catch {
    return "anonymous";
  }
}
