import {
  getElementTagName,
  safeGetAttribute,
  shouldMaskElement,
} from "@/privacy/element";
import { normalizeWhitespace, truncate } from "@groundcover/rum-core/common/text";
// Type-only import — erased at runtime, so no import cycle with privacy/config.
import type { WebEffectivePrivacy } from "@/privacy/web-privacy";

// Accessibility metadata captured for a DOM event target, so the app can render
// "what the user pressed" (a button vs a link vs a menu item, with a label)
// instead of a raw tag + a page-sized text blob.
export interface DomEventAccessibility {
  role: string;
  accessibleName: string;
  ariaLabel: string;
  title: string;
  alt: string;
  placeholder: string;
  name: string;
  inputType: string;
  href: string;
}

const EMPTY_ACCESSIBILITY: DomEventAccessibility = {
  role: "",
  accessibleName: "",
  ariaLabel: "",
  title: "",
  alt: "",
  placeholder: "",
  name: "",
  inputType: "",
  href: "",
};

// Cap for page-controlled attribute values (title, alt, href, …), so each one
// stays a readable size.
const MAX_LABEL_LEN = 255;
// Tighter cap for the accessible name specifically. A name over 100 chars is usually content
// leaking in where no real label exists, so the name is hard-capped to this many chars TOTAL
// (ellipsis included) as a safety net on top of the root-cause fixes below (container/body
// detection).
const MAX_ACCESSIBLE_NAME_LEN = 100;
// Above this, the element's text is a page/container dump (e.g. clicking `#root`),
// not a label — drop it entirely rather than store a meaningless prefix.
const MAX_CONTAINER_TEXT_LEN = 1000;
// Bound aria-labelledby id resolution so a pathological reference list can't blow up.
const MAX_LABELLEDBY_REFS = 5;
// A container with this many interactive/item descendants is a menu/list/nav/form,
// not a labelable control — its aggregated text is a dump of child labels, so we
// don't use it as a name. `2` (not `1`) so a control that legitimately nests a
// single child control (e.g. a card link with one close button) keeps its label.
const MIN_ITEMS_FOR_CONTAINER = 2;

// The click usually lands on a deep inner node (an icon <span> inside a button).
// Resolve to the nearest interactive ancestor-or-self so the event describes the
// control the user perceives pressing. `a` is included without an href filter
// because SPAs routinely use bare <a> as JS-driven controls. Role selectors use
// `~=` (whitespace-token match) so a fallback list like role="combobox textbox"
// still resolves.
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  '[role~="button"]',
  '[role~="link"]',
  '[role~="menuitem"]',
  '[role~="menuitemcheckbox"]',
  '[role~="menuitemradio"]',
  '[role~="tab"]',
  '[role~="checkbox"]',
  '[role~="radio"]',
  '[role~="switch"]',
  '[role~="option"]',
  '[role~="treeitem"]',
  // Widget roles whose custom implementations wrap inner nodes — resolve a click
  // on the inner node up to the widget so the event describes the control.
  '[role~="slider"]',
  '[role~="spinbutton"]',
  '[role~="combobox"]',
  '[role~="textbox"]',
  '[role~="searchbox"]',
].join(", ");

// Descendants that mark an element as a *container* of items rather than a single
// control: interactive controls plus list/grid/menu items (native tags and ARIA
// roles). If an element wraps several of these, its `textContent` is a dump of
// their labels (a listbox's options, a nav's links, a form's fields), not a name.
const CONTAINER_ITEM_SELECTOR = [
  INTERACTIVE_SELECTOR,
  "li",
  "option",
  "tr",
  "td",
  "th",
  '[role~="listitem"]',
  '[role~="row"]',
  '[role~="gridcell"]',
  '[role~="cell"]',
].join(", ");

// nodeType 1 === ELEMENT_NODE. Use the literal rather than the `Node` global so
// this never throws in an environment where `Node` is undefined.
function isElement(el: Element | null): el is Element {
  return !!el && el.nodeType === 1;
}

// Page-level containers whose text is the whole page, never a label.
function isPageContainer(el: Element): boolean {
  const tag = getElementTagName(el).toLowerCase();
  return tag === "body" || tag === "html";
}

// True when `el` wraps several interactive/item descendants — i.e. it's a
// menu/list/nav/form/grid, not a labelable control. Uses one native
// `querySelectorAll` (no JS-level subtree walk); never throws.
function isItemContainer(el: Element): boolean {
  try {
    return (
      el.querySelectorAll(CONTAINER_ITEM_SELECTOR).length >=
      MIN_ITEMS_FOR_CONTAINER
    );
  } catch {
    return false;
  }
}

function cap(text: string): string {
  return truncate({ text, maxLength: MAX_LABEL_LEN });
}

// The accessible name gets a tighter cap plus an ellipsis to signal truncation.
// The ellipsis counts toward the limit so the result is at most
// MAX_ACCESSIBLE_NAME_LEN chars total (not len + 1).
function capName(text: string): string {
  return truncate({
    text,
    maxLength: MAX_ACCESSIBLE_NAME_LEN - 1,
    ellipsis: "…",
  });
}

/**
 * Nearest interactive ancestor-or-self of `el`, or null when none exists (e.g. a
 * genuine background/container click). `closest` walks up and includes `el`
 * itself, so a click directly on a <button> returns that button.
 */
export function getActionableElement(el: Element | null): Element | null {
  if (!isElement(el)) return null;
  try {
    return el.closest(INTERACTIVE_SELECTOR);
  } catch {
    return null;
  }
}

// Button-like controls whose `value` attribute is a human label (not user PII).
// Text/password/email/etc. inputs are deliberately excluded so typed content is
// never read.
function isButtonLike(el: Element): boolean {
  const tag = getElementTagName(el).toLowerCase();
  if (tag === "button") return true;
  if (tag !== "input") return false;
  const type = safeGetAttribute(el, "type").toLowerCase();
  return type === "submit" || type === "button" || type === "reset";
}

// A small, pragmatic subset of the ARIA implicit-role mapping — the common
// interactive/landmark tags, kept as a switch to stay tiny for the bundle.
function getImplicitRole(el: Element): string {
  const tag = getElementTagName(el).toLowerCase();
  switch (tag) {
    case "a":
      return safeGetAttribute(el, "href") ? "link" : "";
    case "button":
      return "button";
    case "input": {
      const type = safeGetAttribute(el, "type").toLowerCase();
      switch (type) {
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "submit":
        case "button":
        case "reset":
          return "button";
        case "range":
          return "slider";
        case "number":
          return "spinbutton";
        default:
          return "textbox";
      }
    }
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "img":
      return "img";
    case "nav":
      return "navigation";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    default:
      return "";
  }
}

// Explicit `role` attribute wins; otherwise the implicit role from the tag/type.
// `role` may be a space-separated fallback list ("combobox textbox") — the first
// token is the effective role, so return that rather than the whole string.
export function getRole(el: Element): string {
  const explicit = normalizeWhitespace(safeGetAttribute(el, "role"));
  if (explicit) return explicit.split(" ")[0] ?? explicit;
  return getImplicitRole(el);
}

/**
 * The element's own visible text, bounded and single-lined. Returns "" when the
 * element isn't a labelable control:
 *  - `body`/`html`: `textContent` is the whole page (e.g. a keydown that bubbled
 *    to `document.body` with nothing focused);
 *  - an item container (menu/list/nav/form/grid): `textContent` concatenates all
 *    child labels, which is a dump, not a name;
 *  - a page/container dump over `MAX_CONTAINER_TEXT_LEN` (e.g. clicking `#root`).
 * An inline SVG icon contributes no text nodes, so `<button><svg/>Save</button>`
 * → "Save"; a leaf cell keeps its exact text.
 */
export function getOwnTextLabel(el: Element | null): string {
  if (!isElement(el)) return "";
  try {
    if (isPageContainer(el)) return "";
    if (isItemContainer(el)) return "";
    const raw = normalizeWhitespace(el.textContent || "");
    if (!raw) return "";
    if (raw.length > MAX_CONTAINER_TEXT_LEN) return "";
    return truncate({ text: raw, maxLength: MAX_LABEL_LEN });
  } catch {
    return "";
  }
}

// Parse aria-labelledby into a bounded list of referenced ids. Shared so the
// tokenization and MAX_LABELLEDBY_REFS cap stay in sync between the name
// computation and the masking check.
function getLabelledByIds(el: Element): string[] {
  return safeGetAttribute(el, "aria-labelledby")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_LABELLEDBY_REFS);
}

// Resolve aria-labelledby to the joined text of the referenced elements, bounded.
// Each referenced node goes through getOwnTextLabel, so the same container/page
// filtering applies — a labelledby pointing at a listbox/nav/form contributes
// nothing rather than a concatenated dump of its child labels.
function getLabelledByText(el: Element): string {
  const parts: string[] = [];
  for (const id of getLabelledByIds(el)) {
    try {
      const text = getOwnTextLabel(document.getElementById(id));
      if (text) parts.push(text);
    } catch {
      // ignore a single unresolvable reference
    }
  }
  return normalizeWhitespace(parts.join(" "));
}

/**
 * A pragmatic subset of the ARIA accessible-name computation. Ordered fallbacks,
 * first non-empty wins. Never reads the `.value` of text-like inputs (user PII);
 * only button-like `value` *attributes* are considered.
 */
export function getAccessibleName(el: Element, ownText?: string): string {
  // A keydown with nothing focused bubbles to <body>; its accessible name would
  // be the whole page's text. Skip content capture for page-level containers.
  if (isPageContainer(el)) return "";

  // Per the ARIA accessible-name computation, aria-labelledby takes precedence
  // over aria-label when both are present. All branches capped to 100 chars.
  const labelledBy = getLabelledByText(el);
  if (labelledBy) return capName(labelledBy);

  const ariaLabel = normalizeWhitespace(safeGetAttribute(el, "aria-label"));
  if (ariaLabel) return capName(ariaLabel);

  const alt = normalizeWhitespace(safeGetAttribute(el, "alt"));
  if (alt) return capName(alt);

  if (isButtonLike(el)) {
    const value = normalizeWhitespace(safeGetAttribute(el, "value"));
    if (value) return capName(value);
  }

  // Name-from-content: per the ARIA accname algorithm the element's own visible
  // text outranks the title/placeholder tooltip fallbacks (which only apply when
  // there is no content, e.g. an icon-only control). getOwnTextLabel already
  // drops container/page dumps. Reuse a precomputed value when the caller has one
  // (the listener also needs it for the `text` field — compute it once).
  const own = ownText ?? getOwnTextLabel(el);
  if (own) return capName(own);

  const title = normalizeWhitespace(safeGetAttribute(el, "title"));
  if (title) return capName(title);

  const placeholder = normalizeWhitespace(safeGetAttribute(el, "placeholder"));
  if (placeholder) return capName(placeholder);

  return "";
}

/**
 * True when `el`'s subtree contains masked content — used to decide masking for
 * the aggregated `textContent` of a resolved ancestor: a masked *sibling* (e.g.
 * `<span data-private>secret</span>`) would otherwise leak through the parent's
 * text. `shouldMaskElement` on the raw target only covers the upward direction.
 */
export function subtreeHasMaskedContent(
  el: Element,
  privacy: WebEffectivePrivacy
): boolean {
  if (privacy.level === "allow") return false;
  try {
    if (el.querySelector("[data-private]")) return true;
    return privacy.maskSelectors.some((sel) => {
      try {
        return el.querySelector(sel) != null;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * True when `el`'s aria-labelledby references any masked element. The accessible
 * name can pull text from nodes ANYWHERE in the document (not just `el`'s
 * subtree), so a private referenced label would otherwise leak into
 * `accessibleName`. Callers OR this into the mask decision.
 */
export function labelledByHasMaskedContent(
  el: Element,
  privacy: WebEffectivePrivacy
): boolean {
  if (privacy.level === "allow") return false;
  try {
    for (const id of getLabelledByIds(el)) {
      const ref = document.getElementById(id);
      if (!ref) continue;
      // Only refs that actually contribute name text matter: getLabelledByText
      // drops container/empty refs via getOwnTextLabel, so a masked descendant of
      // a dropped ref never reaches the name — masking the event for it would be
      // spurious over-redaction. Skip those.
      if (!getOwnTextLabel(ref)) continue;
      // The name pulls the ref's whole textContent, so a masked DESCENDANT of
      // the ref (e.g. `<div id=lbl>Card <span data-private>4111…</span></div>`)
      // must mask too — shouldMaskElement only checks the ref and its ancestors.
      if (
        shouldMaskElement(ref, privacy) ||
        subtreeHasMaskedContent(ref, privacy)
      ) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

// Structural attributes read via the shadow-safe helpers (getAttribute is immune
// to HTMLFormElement's named-property shadowing; getElementTagName uses the
// prototype getter). Never throws — returns all-empty for a null/non-Element.
export function getAccessibilityInfo(
  el: Element | null,
  ownText?: string
): DomEventAccessibility {
  if (!isElement(el)) return { ...EMPTY_ACCESSIBILITY };
  try {
    // Every field is capped to MAX_LABEL_LEN: these are page-controlled
    // attribute values (a `title` or `data:` `href` can be megabytes) that flow
    // into `dom_event_target` on every event, so keep each one bounded.
    // ownText (the element's own text label) is passed through so the listener's
    // single getOwnTextLabel call is reused for the name's content fallback.
    return {
      role: cap(getRole(el)),
      accessibleName: getAccessibleName(el, ownText), // already capped to 100 chars
      ariaLabel: cap(normalizeWhitespace(safeGetAttribute(el, "aria-label"))),
      title: cap(normalizeWhitespace(safeGetAttribute(el, "title"))),
      alt: cap(normalizeWhitespace(safeGetAttribute(el, "alt"))),
      placeholder: cap(normalizeWhitespace(safeGetAttribute(el, "placeholder"))),
      name: cap(safeGetAttribute(el, "name")),
      inputType: cap(safeGetAttribute(el, "type")),
      href: cap(safeGetAttribute(el, "href")),
    };
  } catch {
    return { ...EMPTY_ACCESSIBILITY };
  }
}
