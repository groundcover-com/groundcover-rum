import { hashText } from "../../common/hash";
import type { DedupInfo, ErrorEventAttributes } from "../types";

/**
 * What makes two exceptions the same: type, fingerprint (type plus the first
 * 400 characters of the redacted message), handled or not, and the whole stack.
 * The stack is the code path that threw, so the same message thrown through a
 * shared helper from two call sites stays two events, and a value the SDK
 * wrapped (a rejected object) matches by where it was thrown, not by its
 * contents. Metadata, captured values included, is left out, or a report with a
 * changing detail would never match; a merged event keeps the first one's.
 */
export function exceptionDedup(attributes: ErrorEventAttributes): DedupInfo {
  const { error_type, error_fingerprint, error_handled, error_stacktrace } = attributes;
  return {
    key: hashText(JSON.stringify([error_type, error_fingerprint, error_handled, error_stacktrace])),
    countAttribute: "error_repeat_count",
  };
}
