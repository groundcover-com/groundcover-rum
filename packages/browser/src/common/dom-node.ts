// Walking into a DOM node reaches its React fiber fields, whose cross-edges blow up
// exponentially under back-edge-only cycle detection — so the browser hands core this
// predicate (as `isOpaqueNode`) to reject nodes up front. Structural rather than
// `instanceof Node`, to catch cross-realm nodes too.
//
// `nodeType`+`nodeName` alone is too loose (plain metadata would match), so `ownerDocument` is
// required as well. Property access is wrapped, so a hostile Proxy trap returns false rather
// than throwing out to callers.
export function isDomNode(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  try {
    return (
      typeof (value as { nodeType?: unknown }).nodeType === "number" &&
      typeof (value as { nodeName?: unknown }).nodeName === "string" &&
      "ownerDocument" in value
    );
  } catch {
    return false;
  }
}
