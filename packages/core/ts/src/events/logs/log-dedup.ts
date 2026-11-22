import { hashText } from "../../common/hash";
import type { DedupInfo } from "../types";

/**
 * Error-level logs merge by their (redacted) message; other levels never
 * merge. The log's other attributes are left out, like an exception's
 * metadata; a merged event keeps the first one's.
 */
export function errorLogDedup(message: string, level: string): DedupInfo | undefined {
  if (level !== "error") return undefined;
  return { key: hashText(message), countAttribute: "log_repeat_count" };
}
