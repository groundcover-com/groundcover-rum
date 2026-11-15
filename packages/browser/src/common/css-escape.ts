// Escaping for the CSS selectors the SDK builds to name an element. Without it, a
// class or attribute value with characters CSS reads as syntax makes the selector
// invalid or makes it match nothing, and it ends up naming another element.
import { _globalThis } from "./global";

// An attribute value inside a double-quoted CSS string. The backslash and the
// quote are syntax there, and a line break can't appear in a string at all, so
// it becomes a hex escape (its trailing space ends the escape). Everything else,
// spaces included, is left as it is, so a selector that already worked keeps its
// form. CSS.escape would also escape spaces and punctuation.
export const cssStringValue = (value: string): string =>
  value
    .replace(/["\\]/g, "\\$&")
    .replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);

// A class name as a CSS identifier: `md:flex` becomes `md\:flex`, and an ordinary
// class comes out unchanged. Every browser that runs this ES2020 bundle has
// CSS.escape; where it's missing anyway, the class goes in as it is rather than
// throwing in the host page.
export const cssIdentifier = (value: string): string =>
  _globalThis.CSS?.escape?.(value) ?? value;
