import { hashText } from "../../common/hash";
import type { DedupInfo, ErrorEventAttributes } from "../types";

/**
 * What makes two exceptions the same: type, fingerprint (type plus the first
 * 400 characters of the redacted message), handled or not, and the whole stack.
 * The stack is the code path that threw, so the same message thrown through a
 * shared helper from two call sites stays two events. Metadata, captured values
 * included, is left out, or a report with a changing detail would never match;
 * a merged event keeps the first one's.
 *
 * One limit: an uncaught non-Error value (a rejected object or string, a thrown
 * object) has no stack from the app. The SDK builds the Error when it reports
 * it, so the stack is the SDK's own and the same for every one; those group by
 * the value's shape (its kind and keys, or its text), not by where they came
 * from. A value passed to captureException does keep its caller's stack.
 */
export function exceptionDedup(attributes: ErrorEventAttributes): DedupInfo {
  const { error_type, error_fingerprint, error_handled, error_stacktrace } = attributes;
  return {
    key: hashText(JSON.stringify([error_type, error_fingerprint, error_handled, error_stacktrace])),
    countAttribute: "error_repeat_count",
  };
}
