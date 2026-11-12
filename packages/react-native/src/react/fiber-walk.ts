// Pure, defensive traversal of the React fiber tree to label a tapped node. The single
// version-fragile spot in the SDK: `_targetInst`, `memoizedProps`, `elementType` and the
// Fabric shapes below are React internals that shift between renderer versions. Every
// property access is guarded, and any failure degrades to a coordinate-only result — a
// tap is never lost, only its labels.

export type A11yState = {
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  busy?: boolean;
  expanded?: boolean;
};
export type A11yValue = { min?: number; max?: number; now?: number; text?: string };

export type FiberWalkResult = {
  component: string;
  label: string;
  role: string;
  hint: string;
  state?: A11yState;
  value?: A11yValue;
  componentPath: string;
  /** True when the tapped node or ANY ancestor carries `dataPrivate` — the caller
   *  masks the human-readable fields even under the default privacy level. */
  masked: boolean;
  /**
   * True when the touch happened inside a React Native `Modal`, which renders into a SEPARATE
   * native surface — its own `UIWindow` on iOS, a `Dialog` (and so a second `Window`) on Android.
   *
   * Carried because the native gesture trackers hook one surface kind each and do not all reach a
   * modal: Android attaches per ACTIVITY, and a Dialog is not an Activity. JS suppression consults
   * this so it stands down only where native can actually see the gesture — see
   * {@link shouldSuppressJsGesture}. Free to collect: the walk already climbs these ancestors to
   * build `componentPath`.
   */
  insideModal: boolean;
};

export const EMPTY_WALK: FiberWalkResult = {
  component: "",
  label: "",
  role: "",
  hint: "",
  componentPath: "",
  masked: false,
  insideModal: false,
};

/**
 * The HOST component React Native's `Modal` renders into, on both platforms.
 *
 * Deliberately the host name and not the user-space `Modal`: an app is free to have its own
 * component called `Modal`, and matching that would stop suppression on a surface native DOES
 * cover — reporting the gesture twice. `RCTModalHostView` is React Native's own, registered by
 * `ReactModalHostManager`, so it cannot collide with product code.
 */
const MODAL_HOST_NAMES = new Set<string>(["RCTModalHostView", "ModalHostView"]);

// Host component names that carry no product meaning — skipped when building the
// component path and when picking the labeled component.
export const HOST_NOISE = new Set<string>([
  "View",
  "RCTView",
  "RCTScrollView",
  "ScrollView",
  "Text",
  "RCTText",
  "AnimatedComponent",
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
]);

const MAX_DEPTH = 60;
const MAX_PATH_SEGMENTS = 10;
const MAX_PATH_CHARS = 200;

/**
 * Locate the fiber node a touch event points at, probing the known shapes in
 * order. Pass the SYNTHETIC touch event (not `nativeEvent`): under Fabric
 * `nativeEvent.target` is a numeric native tag, while the fiber is reachable
 * from the synthetic event via `_targetInst` (present on Paper AND Fabric/React
 * 19) or `target.__internalInstanceHandle` (the Fabric public instance). React
 * internals — every access guarded.
 */
export function resolveFiber(event: unknown): unknown {
  try {
    const e = event as Record<string, unknown> | null;
    if (!e || typeof e !== "object") return null;
    // Paper synthetic event AND Fabric/React 19 synthetic event both expose this.
    if (e._targetInst) return e._targetInst;
    // Fabric: the synthetic event's `target` is the host public instance.
    const target = e.target as Record<string, unknown> | undefined;
    if (target && typeof target === "object") {
      if (target.__internalInstanceHandle) return target.__internalInstanceHandle;
      const stateNode = target.stateNode as Record<string, unknown> | undefined;
      if (stateNode && typeof stateNode === "object" && stateNode.canonical) {
        return stateNode.canonical;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function looksLikeFiber(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  return "return" in n && ("elementType" in n || "type" in n || "stateNode" in n);
}

type FiberNode = {
  return?: unknown;
  type?: unknown;
  elementType?: unknown;
  memoizedProps?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// How deep to chase a control's text through nested child ELEMENTS. A control's visible label is
// usually a Text DESCENDANT — <Pressable accessibilityRole="button"><Text>Save</Text></Pressable> —
// and the walk only ascends, so a tap that resolves to the Pressable (its padding, or iOS resolving
// the target above the Text) would otherwise never reach the string. iOS resolves taps that way
// often enough that a large share of button taps would arrive with a role but no label.
//
// `memoizedProps.children` holds the child elements React was handed, each a `{ props: { children }}`
// object — so recover the text by recursing element children, not just flat strings.
const MAX_LABEL_DESCENT = 6;

// A subtree is wide as well as deep, and depth alone bounds neither the text nor the work. A tap on
// blank space in a container — the provider's root View bubbles touches, so list padding or a flex
// gap resolves to the CONTAINER — descends its whole child array: thousands of characters for a
// 100-row ScrollView, on a descent that runs synchronously in the touch handler before the
// interaction is enqueued.
//
// So two more budgets, spent across the whole descent and checked before each step rather than
// trimmed at the end. The browser package answers the same question in
// `common/accessibility.ts` — a name over 100 chars is usually "content leaking in where no real
// label exists" — and its answer is the one used here: past the cap the text is a
// container dump, not a name, so it is DROPPED rather than stored as a prefix. Dropping resumes the
// ascent (`walkFiber` fills the label from the nearest node that has one), so the fallback is the
// author's own `accessibilityLabel` on an ancestor.
const MAX_LABEL_CHARS = 200;
const MAX_LABEL_NODES = 32;

// Recovered child text, plus whether any element descended through carried `dataPrivate`. The
// walk sets `masked` from the fiber chain it ASCENDS, but this descent reaches text the ascent
// never sees — so a private leaf under a tapped control would otherwise have its text pulled up as
// a public label. The flag rides back up so `walkFiber` can mask it.
//
// `truncated` rides up the same way, and any truncation voids the whole label. That is a privacy
// rule before it is a size one: a descent that stopped early scanned only PART of the subtree, so a
// `dataPrivate` on an unvisited sibling was never read, and the text already collected would ship
// unmasked. Text from a partial scan is never trustworthy enough to send.
type ChildText = { text: string; masked: boolean; truncated: boolean };

// Remaining budget for one top-level descent, mutated as it is spent so siblings and nested levels
// draw on the same pool rather than each getting a fresh allowance.
type LabelBudget = { chars: number; nodes: number };

const NO_TEXT: ChildText = { text: "", masked: false, truncated: false };

// Nothing recovered AND the subtree was not fully read — the result `labelOf` must void. Distinct
// from NO_TEXT, which means "read it all, there was no text": both carry an empty string, and only
// this one is unsafe to build a label around.
const PARTIAL_SCAN: ChildText = { text: "", masked: false, truncated: true };

// `<>…</>`. React renders nothing for it, so it is structure the author used to group children, not
// a level of nesting — see TRANSPARENT WRAPPERS in textOfChildren. `Symbol.for` is registry-wide,
// so this matches across React copies.
const REACT_FRAGMENT = Symbol.for("react.fragment");

// What React renders as nothing: `{cond && <X/>}` when false, `{maybe}` when null, a `.map()` over
// no items. Not the same as "yielded no text" — that is only knowable AFTER descending, and paying
// for the descent is the point of the budget.
function rendersNothing(child: unknown): boolean {
  return child == null || typeof child === "boolean" || (Array.isArray(child) && child.length === 0);
}

function isFragment(node: unknown): boolean {
  return typeof node === "object" && node !== null && (node as { type?: unknown }).type === REACT_FRAGMENT;
}

// A leaf string, charged to the budget. Over the remaining allowance it is not a name at all, so it
// reports truncation instead of a prefix and zeroes the pool to stop the siblings behind it.
function chargeText(text: string, budget: LabelBudget): ChildText {
  if (text.length > budget.chars) {
    budget.chars = 0;
    return { text: "", masked: false, truncated: true };
  }
  budget.chars -= text.length;
  return { text, masked: false, truncated: false };
}

// Walk an array of children, under one budget, masking and truncation rule for every segment.
function textOfSequence(children: Iterable<unknown>, depth: number, budget: LabelBudget): ChildText {
  // Drop decorative segments AS they compose, not just the joined whole: an icon beside a label
  // (`["★", "Favorite"]`) must yield "Favorite", but the joined "★ Favorite" contains letters and
  // would survive a single end-of-line decorative check. Privacy ORs across siblings — one
  // private segment marks the recovered whole.
  let masked = false;
  let truncated = false;
  const parts: string[] = [];
  for (const child of children) {
    // Skipped before the budget is even consulted. A child that renders nothing costs nothing to
    // pass over — no text, no subtree, no recursion — so it must neither spend the budget that
    // bounds real work nor, once the budget is gone, count as content left unread. Conditional
    // rendering makes these routine: `{items.map(i => visible(i) && <Row/>)}` emits one `false`
    // per hidden entry, and charging them would let a row of holes void the label beside them.
    if (rendersNothing(child)) continue;
    // Checked BEFORE the step, so an exhausted budget stops the traversal rather than letting it
    // run to the end of a 500-child array and trimming the result.
    if (budget.nodes <= 0 || budget.chars <= 0) {
      truncated = true;
      break;
    }
    budget.nodes--;
    // Same depth, not depth + 1 — see TRANSPARENT WRAPPERS above.
    const part = textOfChildren(child, depth, budget);
    if (part.masked) masked = true;
    if (part.truncated) truncated = true;
    if (part.text && !isDecorativeText(part.text)) parts.push(part.text);
  }
  return { text: parts.join(" ").trim(), masked, truncated };
}

function textOfChildren(
  children: unknown,
  depth = 0,
  budget: LabelBudget = { chars: MAX_LABEL_CHARS, nodes: MAX_LABEL_NODES }
): ChildText {
  if (typeof children === "string") return chargeText(children, budget);
  // React renders a number child verbatim, so `<Text>{7}</Text>` is a real label — and `{0}` is
  // the one to be careful of: falsy, so a truthiness guard silently drops it. Non-finite numbers
  // (NaN/Infinity) are not labels.
  if (typeof children === "number") {
    return Number.isFinite(children) ? chargeText(String(children), budget) : NO_TEXT;
  }
  // TRANSPARENT WRAPPERS. MAX_LABEL_DESCENT counts nested child ELEMENTS, as its name says, and
  // React flattens arrays and fragments — neither is a level the author wrote or the user can see.
  // Charging them would exhaust the budget on shapes like `{sections.map(s => s.items.map(...))}`,
  // erasing a label sitting only a few real elements down. So both recurse at the SAME depth and
  // pay a NODE instead. That charge is load-bearing: with depth not bounding them, the node
  // budget is what terminates a chain of nested arrays or fragments.
  //
  // The depth bound is checked INSIDE the branch that would descend, not before it.
  //
  // Bottoming out on a real subtree is a PARTIAL scan, exactly as an exhausted budget is:
  // everything below goes unread, so a `dataPrivate` down there is never seen while a shallower
  // sibling's text would still be accepted, and the label would ship unmasked. Voiding is right
  // there. But it is only right THERE. Checked up here instead, the bound would also catch every
  // terminal child — `{cond && <X/>}` renders `false`, `{maybe}` renders `null`, a `.map()` over
  // an empty list renders `[]` — none of which has anything underneath to leave unread. Voiding
  // on those loses a name that was fully and safely recovered, for the crime of rendering a
  // conditional deep in the tree.
  if (Array.isArray(children)) {
    // Nothing to leave unread, at any depth.
    if (children.length === 0) return NO_TEXT;
    return textOfSequence(children, depth, budget);
  }
  // A React element: descend its own children. Not the rendered fiber — the element React was
  // handed — so `props.children` is the next level down. A `dataPrivate` here marks everything
  // recovered from beneath it, matching the subtree-masking the ascent already applies upward.
  if (children && typeof children === "object") {
    const props = (children as { props?: unknown }).props;
    if (props && typeof props === "object") {
      // A fragment is a transparent wrapper like an array: it costs a node, not a level.
      const transparent = isFragment(children);
      if (!transparent && depth >= MAX_LABEL_DESCENT) {
        // An element we decline to walk: its subtree — and any `dataPrivate` in it — goes unread.
        return PARTIAL_SCAN;
      }
      if (transparent) {
        // The charge that bounds a fragment chain, since depth does not.
        if (budget.nodes <= 0) return PARTIAL_SCAN;
        budget.nodes--;
      }
      const p = props as { children?: unknown; dataPrivate?: unknown };
      const inner = textOfChildren(p.children, transparent ? depth : depth + 1, budget);
      return {
        text: inner.text,
        masked: inner.masked || Boolean(p.dataPrivate),
        truncated: inner.truncated,
      };
    }
    // Object-shaped and unrecognised: a thenable child (React 19 unwraps those), a portal, an
    // iterable such as a Set or generator. We did not read it, so we cannot report that we did —
    // NO_TEXT asserts "read it all, there was no text", which here would be a guess, and it is the
    // guess that lets a sibling's public label ship while a `dataPrivate` in here goes unseen.
    return PARTIAL_SCAN;
  }
  return NO_TEXT;
}

function propsOf(node: FiberNode): Record<string, unknown> {
  const props = node.memoizedProps;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

// The component's display name, from the modern `elementType` or the legacy `type` slot.
// Both a FUNCTION and an object have to be accepted: an ordinary component is a function,
// so checking only objects would skip every plain one and leave the name to whatever React
// internals happen to be objects — a FlatList row would report
// `interaction_target.component: "VirtualizedListContext"`.
function nameOf(node: FiberNode): string {
  const candidates = [node.elementType, node.type];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
    if (candidate && (typeof candidate === "object" || typeof candidate === "function")) {
      const c = candidate as { displayName?: unknown; name?: unknown };
      const name = asString(c.displayName) || asString(c.name);
      if (name) return name;
    }
  }
  return "";
}

/**
 * Text with no letter and no digit in it — an icon glyph, a bullet, an arrow. Not a name, whatever
 * the font renders it as.
 *
 * `@react-navigation/elements` draws `MissingIcon` for a tab with no icon configured and its text
 * is `⏷`, so without this every tab switch would store `interaction_target.label: "⏷"`. A real
 * icon font is no better: the text is a private-use codepoint. Rejecting it here lets the walk
 * continue to the pressable ancestor's `accessibilityLabel`, which is the name the author gave
 * the control.
 *
 * Deliberately narrow. Text that reads as anything at all still WINS over an ancestor's
 * `accessibilityLabel`, because that is the established contract — the e2e suite asserts a
 * control's visible text over its (different) a11y label, and inverting it would relabel
 * annotated controls in existing dashboards.
 */
function isDecorativeText(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

// The label, and whether it was recovered from a `dataPrivate` descendant. An explicit
// `accessibilityLabel` is the author's chosen public name and never carries the private flag; only
// the child-text fallback can, because only it descends past the tapped node.
function labelOf(props: Record<string, unknown>): { label: string; masked: boolean } {
  const explicit = asString(props.accessibilityLabel) || asString(props["aria-label"]);
  if (explicit) return { label: explicit, masked: false };
  const { text, masked, truncated } = textOfChildren(props.children);
  // A truncated descent yields no label at all — see ChildText. Same outcome as a decorative glyph,
  // and for the same reason: what came back does not name the control, so let the ascent continue.
  if (truncated) return { label: "", masked: false };
  return isDecorativeText(text) ? { label: "", masked: false } : { label: text, masked };
}

const STATE_KEYS = ["disabled", "selected", "checked", "busy", "expanded"] as const;

// accessibilityState → a normalized subset of the known boolean flags (checked
// may also be "mixed"). Returns undefined when the element declares none, so the
// field is omitted from the event rather than shipped empty.
function pickState(raw: unknown): A11yState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const out: A11yState = {};
  let has = false;
  for (const k of STATE_KEYS) {
    const v = src[k];
    const ok = k === "checked" ? typeof v === "boolean" || v === "mixed" : typeof v === "boolean";
    if (ok) {
      (out as Record<string, unknown>)[k] = v;
      has = true;
    }
  }
  return has ? out : undefined;
}

// accessibilityValue → numeric min/max/now + optional text. Undefined when empty.
function pickValue(raw: unknown): A11yValue | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const out: A11yValue = {};
  let has = false;
  if (typeof src.min === "number") {
    out.min = src.min;
    has = true;
  }
  if (typeof src.max === "number") {
    out.max = src.max;
    has = true;
  }
  if (typeof src.now === "number") {
    out.now = src.now;
    has = true;
  }
  if (typeof src.text === "string") {
    out.text = src.text;
    has = true;
  }
  return has ? out : undefined;
}

// Walk up from the tapped fiber, collecting a component path and the best label.
// Every access is defensive; ANY failure yields EMPTY (a tap is never lost, only
// its labels).
export function walkFiber(fiber: unknown): FiberWalkResult {
  try {
    if (!looksLikeFiber(fiber)) return EMPTY_WALK;

    // The tapped fiber is usually the innermost host node (e.g. the RCTText
    // inside a button), while accessibilityRole / accessibilityLabel / hint /
    // state / value sit on an ancestor (the Pressable/Button). So collect each
    // from the NEAREST node that carries it while walking up — not the target
    // alone.
    let role = "";
    let label = "";
    let hint = "";
    let component = "";
    let state: A11yState | undefined;
    let value: A11yValue | undefined;
    let masked = false;
    let insideModal = false;
    const segments: string[] = []; // innermost → outermost
    const seen = new Set<unknown>();

    let node: unknown = fiber;
    let depth = 0;
    while (node && depth < MAX_DEPTH && looksLikeFiber(node)) {
      if (seen.has(node)) break;
      seen.add(node);

      const fn = node as FiberNode;
      const props = propsOf(fn);
      if (!role) role = asString(props.accessibilityRole) || asString(props.role);
      if (!label) {
        const found = labelOf(props);
        label = found.label;
        // A label recovered from a private descendant masks the whole target, the same as a
        // `dataPrivate` on the tapped node or an ancestor does below.
        if (found.label && found.masked) masked = true;
      }
      if (!hint) hint = asString(props.accessibilityHint);
      if (!state) state = pickState(props.accessibilityState);
      if (!value) value = pickValue(props.accessibilityValue);
      // Per-element masking opt-out: a truthy `dataPrivate` on the target or any
      // ancestor masks the whole subtree (we walk UP, so a tap inside a marked
      // container passes through it).
      if (!masked && props.dataPrivate) masked = true;

      const name = nameOf(fn);
      // Checked before the noise filter: the modal host is structural, so it is exactly the kind
      // of name the path builder skips — but it is the one thing that tells us which native
      // surface this touch landed on.
      if (!insideModal && name && MODAL_HOST_NAMES.has(name)) insideModal = true;
      if (name && !HOST_NOISE.has(name)) {
        if (segments.length < MAX_PATH_SEGMENTS) segments.push(name);
        if (!component) component = name; // innermost meaningful component
      }

      node = fn.return;
      depth++;
    }

    let componentPath = segments.reverse().join(" > ");
    if (componentPath.length > MAX_PATH_CHARS) {
      componentPath = componentPath.slice(0, MAX_PATH_CHARS);
    }

    return { component, label, role, hint, state, value, componentPath, masked, insideModal };
  } catch {
    return EMPTY_WALK;
  }
}

export const __internals = {
  looksLikeFiber,
  MAX_DEPTH,
  MAX_PATH_SEGMENTS,
  MAX_PATH_CHARS,
};
