import { isSensitiveKey } from "@groundcover/rum-core/privacy/redaction";
// Type-only import — erased at runtime, so no import cycle with privacy/config.
import type { WebEffectivePrivacy } from "@/privacy/web-privacy";

// HTMLFormElement has [LegacyOverrideBuiltIns], so named form controls (e.g.
// <input name="id">) shadow inherited properties like .id/.tagName/.className.
// Reading form.id can return the child input instead of the string — which then
// gets walked through its React fiber in downstream serialization. Bypass the
// named-property lookup by calling the Element.prototype getters directly.
const elementTagNameGetter =
  typeof Element !== "undefined"
    ? Object.getOwnPropertyDescriptor(Element.prototype, "tagName")?.get
    : undefined;

export function safeGetAttribute(el: Element, attr: string): string {
  try {
    return el.getAttribute(attr) || "";
  } catch {
    return "";
  }
}

export function getElementTagName(el: Element): string {
  try {
    const value = elementTagNameGetter?.call(el);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

// Ancestor-aware match: true when `el` OR any ancestor matches `selector`.
// `closest` is what lets a "container" privacy signal (data-private / a mask
// selector on a wrapper) propagate to descendant inputs — mirroring rrweb's
// own closest()-based text masking.
function safeClosest(el: Element, selector: string): boolean {
  try {
    return el.closest?.(selector) != null;
  } catch {
    return false;
  }
}

// Form controls whose values/keystrokes are user input. The built-in
// sensitive-key heuristic only applies to these — see shouldMaskElement.
function isEditableControl(target: Element): boolean {
  const tag = getElementTagName(target).toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

// The element's own identifying attributes, lowercased and non-empty.
function getElementAttrs(target: Element): string[] {
  return ["id", "name", "class", "aria-label", "placeholder"]
    .map((attr) => safeGetAttribute(target, attr))
    .filter(Boolean);
}

// True when an element is sensitive by the BUILT-IN heuristic — password type
// or an attribute (id/name/class/aria-label/placeholder) matching a
// sensitive-key pattern / user `sensitiveKeys`. Element-local by design (a
// parent's class must not mask every child).
export function isSensitiveElement(
  target: Element | null,
  sensitiveKeys: string[]
): boolean {
  if (!target) return false;
  if ((target as HTMLInputElement).type === "password") return true;
  return getElementAttrs(target).some((value) =>
    isSensitiveKey(value, sensitiveKeys)
  );
}

/**
 * The single masking decision shared by the DOM-event listener and the rrweb
 * replay `maskInputFn`. Under `mask-sensitive` (the default): explicit/container
 * signals — `data-private` and `maskSelectors` — mask ANY element (and their
 * subtrees), while the built-in password/sensitive-key heuristic masks only form
 * controls, so static page text stays visible per the documented contract.
 * `mask-all` masks everything; `allow` masks nothing.
 */
export function shouldMaskElement(
  target: Element | null,
  privacy: WebEffectivePrivacy
): boolean {
  if (privacy.level === "allow") return false;
  if (!target) return false;

  // Explicit / container signals — apply to ANY element (marking a wrapper
  // masks its subtree). data-private and maskSelectors are ancestor-aware.
  if (safeClosest(target, "[data-private]")) return true;
  if (
    privacy.maskSelectors.length &&
    privacy.maskSelectors.some((sel) => safeClosest(target, sel))
  ) {
    return true;
  }

  // 'mask-all' masks every element's text/value.
  if (privacy.level === "mask-all") return true;

  // 'mask-sensitive': the built-in sensitive-key heuristic is limited to form
  // controls, so a static <div id="token"> stays visible — use data-private /
  // maskSelectors to mask sensitive static content.
  return (
    isEditableControl(target) &&
    isSensitiveElement(target, privacy.sensitiveKeys)
  );
}
