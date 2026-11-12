// A React fiber links to its parent, children, siblings and alternate, so walking one
// reaches the whole tree through cross-edges back-edge-only cycle detection can't bound.
// RN hands core this predicate (as `isOpaqueNode`) so enrichment and redaction never
// descend into one — e.g. a host instance passed as metadata, whose internal handle is a fiber.
//
// Deliberately stricter than fiber-walk's `looksLikeFiber`: that one only ever sees values
// already known to come from React, whereas this one judges USER data, where
// `{ type, return }` is an ordinary shape (a refund record, say) that must not be redacted.
// Property access is wrapped, so a hostile Proxy trap returns false rather than throwing.
export function isReactFiber(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  try {
    const n = value as Record<string, unknown>;
    return (
      typeof n.tag === "number" &&
      "return" in n &&
      "alternate" in n &&
      "stateNode" in n &&
      "memoizedProps" in n
    );
  } catch {
    return false;
  }
}
