export function truncate({
  text,
  maxLength = 10_000,
  ellipsis = '',
}: {text: string, maxLength?: number, ellipsis?: string}): string {
  // Only null/undefined are "absent" → "". Coerce everything else BEFORE the
  // emptiness check so falsy primitives (0, false, NaN) stringify rather than
  // collapse to "", and the coerced value still goes through maxLength/ellipsis.
  if (text == null) return '';
  const str = typeof text === 'string' ? text : String(text);

  if (str.length <= maxLength) {
    return str;
  }

  return str.substring(0, maxLength) + ellipsis;
}

// Collapse runs of whitespace (incl. newlines/tabs) into single spaces and trim,
// for one-line labels built from multi-line source text.
export function normalizeWhitespace(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}
