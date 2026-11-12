import { formatBody } from "@groundcover/rum-core/common/body-formatter";

// formatBody plus the DOM-only body XHR accepts: `xhr.send(document)`. Every
// real Document (incl. cross-realm) has nodeType 9 (DOCUMENT_NODE), so the
// check is structural. It must run before core's formatter, whose JSON
// fallback would otherwise serialize the Document's own `location`.
export function formatWebBody(body: unknown): string {
  if (isDocument(body)) {
    return "[document data]";
  }
  return formatBody(body);
}

// Contained like core's formatter: a hostile getter or Proxy trap on the probe
// falls through to formatBody (which reports it as unreadable) instead of
// throwing into the host's fetch/XHR call.
function isDocument(body: unknown): boolean {
  try {
    return (body as { nodeType?: number } | null | undefined)?.nodeType === 9;
  } catch {
    return false;
  }
}
