import errorStackParser from "error-stack-parser";
import type { EffectivePrivacy } from "../../privacy/config";
import { redactObject, redactText } from "../../privacy/redaction";
import { truncate } from "../../common/text";
import type { ErrorEventAttributes } from "../types";
import type { EnrichInput } from "../event-enricher";
import { capturedValueOf, serializeCapturedValue } from "./coerce-error";
import { exceptionDedup } from "./exception-dedup";

export type StackFrame = { filename: string; function: string; lineno: number; colno: number };

export interface ErrorCaptureOptions {
  /** Reported by the app (captureException) rather than caught by the SDK. */
  handled?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Stack frames via `error-stack-parser`, which handles V8/Hermes and
 * JSC/Safari formats (eval, anonymous and scoped-package frames included).
 * Frames are diagnostic (paths, function names, line/col) and intentionally
 * left un-redacted; a missing or unparseable stack yields [].
 */
export function parseErrorStack(error: Error): StackFrame[] {
  try {
    return errorStackParser.parse(error).map((frame) => ({
      filename: frame.fileName || "unknown",
      function: frame.functionName || "anonymous",
      lineno: frame.lineNumber || 0,
      colno: frame.columnNumber || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * An Error as the `exception` event the backend ingests. Capture — global
 * handlers, rejection trackers — is the platform's; every source hands its
 * Error here so web and mobile exceptions group identically.
 */
export function shapeErrorEvent(
  error: Error,
  options: ErrorCaptureOptions | undefined,
  privacy: EffectivePrivacy
): EnrichInput<"exception"> {
  const shouldMask = privacy.shouldMaskErrors;
  const opts = {
    sensitiveKeys: privacy.sensitiveKeys,
    redact: privacy.redact,
    kind: "error" as const,
    isOpaqueNode: privacy.isOpaqueNode,
  };

  const message = error.message || "Unknown error";
  const safeMessage = shouldMask ? redactText(message, opts) : message;
  // A value the app reported that isn't an Error: its message names only its
  // shape, and the value itself goes here, redacted field by field. The app's
  // own metadata wins a key clash.
  const captured = capturedValueOf(error);
  const capturedJson =
    captured === undefined
      ? undefined
      : serializeCapturedValue(captured, {
          isOpaqueNode: privacy.isOpaqueNode,
          redact: shouldMask ? (copy) => redactObject(copy, opts) : undefined,
        });
  const metadata =
    capturedJson === undefined ? options?.metadata : { captured_value: capturedJson, ...options?.metadata };
  const safeMetadata = shouldMask && metadata ? redactObject(metadata, opts) : metadata;

  const attributes: ErrorEventAttributes = {
    error_type: error.name || "Error",
    // Capped like log messages; the fingerprint below takes the first 400.
    error_message: truncate({ text: safeMessage }),
    error_stacktrace: parseErrorStack(error),
    error_fingerprint: `${error.name}:${truncate({ text: safeMessage, maxLength: 400 })}`,
    error_handled: options?.handled || false,
    error_metadata: safeMetadata,
  };

  return { type: "exception", attributes, dedup: exceptionDedup(attributes) };
}
