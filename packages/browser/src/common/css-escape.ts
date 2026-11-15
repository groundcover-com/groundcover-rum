// Escaping for the CSS selectors the SDK builds to name an element. Without it, a
// class or attribute value with characters CSS reads as syntax makes the selector
// invalid or makes it match nothing, and it ends up naming another element.

// An attribute value inside a double-quoted CSS string. The backslash and the
// quote are syntax there, and a line break can't appear in a string at all, so
// it becomes a hex escape (its trailing space ends the escape). Everything else,
// spaces included, is left as it is.
export const cssStringValue = (value: string): string =>
  value
    .replace(/["\\]/g, "\\$&")
    .replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);

// A class name as a CSS identifier, serialized as CSS.escape does (CSSOM's
// "serialize an identifier"). Written out rather than calling CSS.escape so it
// behaves the same in every browser. An ordinary class (letters, digits, `-`,
// `_`) comes out unchanged; `md:flex` becomes `md\:flex`, and a leading digit a
// hex escape (`2xl` becomes `\32 xl`).
export const cssIdentifier = (value: string): string => {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 0x30 && code <= 0x39;
    if (code === 0) {
      out += "\uFFFD";
    } else if (
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && isDigit) ||
      (i === 1 && isDigit && value.charCodeAt(0) === 0x2d)
    ) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && code === 0x2d && value.length === 1) {
      out += "\\-";
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      isDigit ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      out += value.charAt(i);
    } else {
      out += `\\${value.charAt(i)}`;
    }
  }
  return out;
};
