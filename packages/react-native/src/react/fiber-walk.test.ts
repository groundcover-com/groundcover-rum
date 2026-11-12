import { describe, it, expect } from "vitest";
import { resolveFiber, walkFiber, EMPTY_WALK } from "./fiber-walk";

// Synthetic fiber nodes — the SDK never controls real ones, so these stand in
// for what React hands us. `type`/`elementType` name the component; a host-noise
// name (View) should be skipped; `memoizedProps` carries testID/label/role.
type Fiber = {
  return: Fiber | null;
  type?: unknown;
  elementType?: { displayName?: string; name?: string };
  memoizedProps?: Record<string, unknown>;
  stateNode?: unknown;
};

function fiber(
  name: string,
  props: Record<string, unknown> = {},
  parent: Fiber | null = null
): Fiber {
  return {
    return: parent,
    type: name,
    elementType: { name },
    memoizedProps: props,
  };
}

describe("resolveFiber — probe order across renderer shapes", () => {
  it("reads Paper's _targetInst", () => {
    const inst = { marker: "paper" };
    expect(resolveFiber({ _targetInst: inst })).toBe(inst);
  });

  it("reads Fabric's target.__internalInstanceHandle", () => {
    const handle = { marker: "fabric" };
    expect(resolveFiber({ target: { __internalInstanceHandle: handle } })).toBe(handle);
  });

  it("reads Fabric's target.stateNode.canonical", () => {
    const canonical = { marker: "canonical" };
    expect(resolveFiber({ target: { stateNode: { canonical } } })).toBe(canonical);
  });

  it("returns null for shapes it doesn't recognize, never throws", () => {
    expect(resolveFiber(null)).toBeNull();
    expect(resolveFiber(42)).toBeNull();
    expect(resolveFiber({})).toBeNull();
  });
});

describe("walkFiber — labeling", () => {
  it("extracts label, role, hint, state and value from the tapped node", () => {
    const node = fiber("PayButton", {
      accessibilityLabel: "Pay now",
      accessibilityRole: "button",
      accessibilityHint: "Completes your purchase",
      accessibilityState: { disabled: false, selected: true },
      accessibilityValue: { now: 3, text: "three items" },
    });
    const r = walkFiber(node);
    expect(r.label).toBe("Pay now");
    expect(r.role).toBe("button");
    expect(r.hint).toBe("Completes your purchase");
    expect(r.state).toEqual({ disabled: false, selected: true });
    expect(r.value).toEqual({ now: 3, text: "three items" });
    expect(r.component).toBe("PayButton");
  });

  it("does not extract testID (not part of the interaction target)", () => {
    const r = walkFiber(fiber("PayButton", { testID: "pay", accessibilityLabel: "Pay" })) as Record<
      string,
      unknown
    >;
    expect(r).not.toHaveProperty("testId");
    expect(r.label).toBe("Pay"); // still labels the node
  });

  it("omits hint/state/value when the node carries none", () => {
    const r = walkFiber(fiber("Plain", { accessibilityLabel: "x" }));
    expect(r.hint).toBe("");
    expect(r.state).toBeUndefined();
    expect(r.value).toBeUndefined();
  });

  it("flags masked when the tapped node has dataPrivate", () => {
    expect(walkFiber(fiber("Field", { dataPrivate: true, accessibilityLabel: "SSN" })).masked).toBe(true);
  });

  it("flags masked when any ANCESTOR has dataPrivate (subtree masking)", () => {
    const container = fiber("PrivateCard", { dataPrivate: true });
    const inner = fiber("Text", { children: "secret" }, container);
    expect(walkFiber(inner).masked).toBe(true);
  });

  it("is not masked without the dataPrivate marker", () => {
    expect(walkFiber(fiber("Plain", { accessibilityLabel: "ok" })).masked).toBe(false);
  });

  it("builds an outermost→innermost component path, skipping host noise", () => {
    const screen = fiber("CheckoutScreen");
    const card = fiber("Card", {}, screen);
    const host = fiber("View", {}, card); // noise — should be skipped
    const button = fiber("PayButton", { testID: "pay" }, host);
    const r = walkFiber(button);
    expect(r.componentPath).toBe("CheckoutScreen > Card > PayButton");
  });

  it("names a plain function component — the shape almost every app component has", () => {
    // The `fiber()` helper models `type` as a host string and `elementType` as an object, which
    // covers host nodes and memo/forwardRef wrappers — but an ordinary `function ProductRow() {}`
    // is neither, and reading only those two slots would skip it silently. On a real screen that
    // collapses `component` to whatever React internals happen to be objects: a scroll over a
    // FlatList row would report `interaction_target.component: "VirtualizedListContext"`.
    function ProductRow(): null {
      return null;
    }
    const composite = {
      return: null,
      type: ProductRow,
      elementType: ProductRow,
      memoizedProps: {},
    } as unknown as Fiber;
    const host = {
      return: composite,
      type: "Text",
      elementType: { name: "Text" },
      memoizedProps: { children: "Row 3" },
    } as unknown as Fiber;

    const r = walkFiber(host);
    expect(r.component).toBe("ProductRow");
    expect(r.componentPath).toBe("ProductRow");
  });

  it("falls back to the node's text when there is no accessibilityLabel", () => {
    const node = fiber("Text", { children: "Add to cart" });
    const r = walkFiber(node);
    expect(r.label).toBe("Add to cart");
  });

  /**
   * An icon-only tab bar, which is what most real apps ship.
   *
   * `@react-navigation/elements` renders `MissingIcon` for a tab with no icon configured, and its
   * text is the glyph `⏷`. A walk that takes the label from the FIRST node that has one, counting
   * child text, would let the glyph beat the `accessibilityLabel` on the pressable ancestor, and
   * every tab switch would store `interaction_target.label: "⏷"`. With a real icon font the glyph
   * is a private-use codepoint instead, which is no better.
   *
   * An explicit `accessibilityLabel` is the author saying what this control is CALLED — it is what a
   * screen reader announces — so it outranks text found deeper in the subtree.
   */
  it("prefers an ancestor's accessibilityLabel over an icon's glyph text", () => {
    const pressable = fiber("Pressable", {
      accessibilityLabel: "Config tab",
      accessibilityRole: "tab",
    });
    const icon = fiber("MissingIcon", { children: "⏷" }, pressable);

    const r = walkFiber(icon);

    expect(r.label).toBe("Config tab");
    expect(r.role).toBe("tab");
  });

  /**
   * The other half of that preference, and the behaviour it must not break: a bare control with no
   * a11y annotation anywhere still degrades to its visible text rather than to nothing.
   */
  it("still uses child text when no ancestor declares an accessibilityLabel", () => {
    const pressable = fiber("Pressable", { accessibilityRole: "button" });
    const text = fiber("Text", { children: "Bare button" }, pressable);

    expect(walkFiber(text).label).toBe("Bare button");
  });

  /**
   * On iOS a button tap often resolves to the Pressable rather than its Text.
   * A control's visible label is a Text DESCENDANT, but the walk only ascends — so a tap
   * that resolves to the Pressable itself (its padding, or iOS resolving the target above the
   * Text) reads `accessibilityRole`/`state`/`value` off that Pressable yet would never reach the
   * string. Most controls carry no `accessibilityLabel`, so the label lives only in the child.
   *
   * `memoizedProps.children` is the child ELEMENT React was handed — `{ props: { children: "…" } }`
   * — not a rendered fiber and not a bare string, which is why a string-only extractor misses it.
   */
  it("labels a control from its Text child ELEMENT when the tap resolves above the text", () => {
    const textElement = { props: { children: "Bare button" } };
    const pressable = fiber("Pressable", { accessibilityRole: "button", children: textElement });

    const r = walkFiber(pressable);
    expect(r.label).toBe("Bare button");
    // The role comes off the same walk either way — the label is the part at risk.
    expect(r.role).toBe("button");
  });

  /**
   * Such a control can carry `accessibilityValue` and `accessibilityState` on the Pressable while
   * its label sits in a Text child element — the walk reaches the control, not its text.
   * Recovering the label must not disturb the state and value read off the same control.
   */
  it("recovers the label without losing the state and value read off the same control", () => {
    const textElement = { props: { children: "A11y annotated button" } };
    const pressable = fiber("Pressable", {
      accessibilityRole: "button",
      accessibilityState: { selected: true },
      accessibilityValue: { text: "forty two percent" },
      children: textElement,
    });

    const r = walkFiber(pressable) as Record<string, unknown>;
    expect(r.label).toBe("A11y annotated button");
    expect((r.state as { selected?: boolean }).selected).toBe(true);
    expect((r.value as { text?: string }).text).toBe("forty two percent");
  });

  /**
   * Composed children — an icon element beside the text — still yield the readable part. The icon's
   * decorative glyph is dropped by the same rule that drops a glyph-only label.
   */
  it("composes child text across sibling elements, dropping the decorative glyph", () => {
    const children = [{ props: { children: "★" } }, { props: { children: "Favorite" } }];
    const pressable = fiber("Pressable", { accessibilityRole: "button", children });

    expect(walkFiber(pressable).label).toBe("Favorite");
  });

  /**
   * An explicit `accessibilityLabel` on the control still wins over its child text, unchanged: the
   * descent is a FALLBACK, reached only when the label prop is absent.
   */
  it("still prefers an explicit accessibilityLabel over the recovered child text", () => {
    const textElement = { props: { children: "raw visible text" } };
    const pressable = fiber("Pressable", {
      accessibilityRole: "button",
      accessibilityLabel: "Increment counter",
      children: textElement,
    });

    expect(walkFiber(pressable).label).toBe("Increment counter");
  });

  /**
   * Nearest still wins, so a decorative glyph must not promote a CONTAINER's label over the
   * pressable's own — skipping the glyph resumes the walk, it does not restart it at the top.
   */
  it("takes the nearest usable label, not the outermost", () => {
    const outer = fiber("TabBar", { accessibilityLabel: "Main navigation" });
    const inner = fiber("Pressable", { accessibilityLabel: "Config tab" }, outer);
    const icon = fiber("MissingIcon", { children: "⏷" }, inner);

    expect(walkFiber(icon).label).toBe("Config tab");
  });

  /**
   * The line the glyph rule must NOT cross. Visible text still outranks an ancestor's
   * `accessibilityLabel` — the e2e suite asserts exactly that against the playground's
   * "Well-tagged button", whose a11y label is the different string "Increment counter" — so only
   * text with nothing readable in it is skipped.
   */
  it("still prefers visible text over an ancestor's different accessibilityLabel", () => {
    const pressable = fiber("Pressable", { accessibilityLabel: "Increment counter" });
    const text = fiber("Text", { children: "Well-tagged button (tapped 3)" }, pressable);

    expect(walkFiber(text).label).toBe("Well-tagged button (tapped 3)");
  });

  /**
   * Digits alone are a legitimate label — a numeric keypad key, a page number, a quantity stepper.
   * A "no letters" rule would swallow those.
   */
  it("treats digit-only text as a real label", () => {
    const pressable = fiber("Pressable", { accessibilityLabel: "Keypad seven" });
    const text = fiber("Text", { children: "7" }, pressable);

    expect(walkFiber(text).label).toBe("7");
  });

  /**
   * With no annotation anywhere to fall back to, a decorative glyph yields an EMPTY label rather
   * than the glyph. `component` and `componentPath` still identify what was pressed, which is more
   * than a meaningless character conveys.
   */
  it("reports no label at all for an unannotated icon", () => {
    const pressable = fiber("Pressable", { accessibilityRole: "button" });
    const icon = fiber("ChevronIcon", { children: "" }, pressable);

    const r = walkFiber(icon);
    expect(r.label).toBe("");
    // `Pressable` is host noise, so the icon is the whole path — still an identification.
    expect(r.component).toBe("ChevronIcon");
    expect(r.componentPath).toBe("ChevronIcon");
    expect(r.role).toBe("button");
  });

  /**
   * A numeric-only label — a quantity stepper, a page number, a keypad digit rendered as
   * `<Text>{7}</Text>`. React treats a number as a valid child, so a child-text extractor that
   * accepted only string leaves would recover an empty label and ship the control unlabelled.
   * `{0}` is the trap inside the trap: falsy, so any `child && …` guard drops it too.
   */
  it("labels a numeric-only Text child element, including zero", () => {
    const seven = fiber("Pressable", {
      accessibilityRole: "button",
      children: { props: { children: 7 } },
    });
    expect(walkFiber(seven).label).toBe("7");

    const zero = fiber("Pressable", {
      accessibilityRole: "button",
      children: { props: { children: 0 } },
    });
    expect(walkFiber(zero).label).toBe("0");
  });

  it("ignores a non-finite numeric child rather than labelling it NaN/Infinity", () => {
    const nan = fiber("Pressable", {
      accessibilityRole: "button",
      children: { props: { children: Number.NaN } },
    });
    expect(walkFiber(nan).label).toBe("");
  });

  /**
   * The child-text descent recovers a label from a Text DESCENDANT, while the walk sets `masked`
   * from the fiber chain it ASCENDS. Without the descent's own flag, a private leaf under a tapped
   * Pressable — `<Pressable><Text dataPrivate>4111…</Text></Pressable>` — would have its text
   * pulled up as the label with `masked` false, and `maskTarget` would ship the card number in the
   * clear. Descending INTO a `dataPrivate` element must mark the recovered text private.
   */
  it("masks a label recovered from a dataPrivate Text descendant", () => {
    const privateText = { props: { dataPrivate: true, children: "4111 1111 1111 1111" } };
    const pressable = fiber("Pressable", { accessibilityRole: "button", children: privateText });

    const r = walkFiber(pressable);
    expect(r.label).toBe("4111 1111 1111 1111"); // still recovered — the caller masks it
    expect(r.masked).toBe(true); // the whole point: flagged private
  });

  it("does not mask a label recovered from a non-private descendant", () => {
    const publicText = { props: { children: "Add to cart" } };
    const pressable = fiber("Pressable", { accessibilityRole: "button", children: publicText });

    const r = walkFiber(pressable);
    expect(r.label).toBe("Add to cart");
    expect(r.masked).toBe(false);
  });

  it("masks when a dataPrivate wrapper sits between the control and its text", () => {
    // The marker can be a level up from the string: <Pressable><View dataPrivate><Text>…
    const inner = { props: { children: "secret balance" } };
    const wrapper = { props: { dataPrivate: true, children: inner } };
    const pressable = fiber("Pressable", { accessibilityRole: "button", children: wrapper });

    const r = walkFiber(pressable);
    expect(r.label).toBe("secret balance");
    expect(r.masked).toBe(true);
  });

  it("degrades to EMPTY when a hostile getter throws (never loses the tap)", () => {
    const hostile = {
      get return() {
        throw new Error("boom");
      },
    };
    expect(walkFiber(hostile)).toEqual(EMPTY_WALK);
  });

  it("returns EMPTY for a non-fiber value", () => {
    expect(walkFiber(null)).toEqual(EMPTY_WALK);
    expect(walkFiber({ not: "a fiber" })).toEqual(EMPTY_WALK);
  });

  it("caps the walk depth without hanging on a cyclic chain", () => {
    const a: Fiber = fiber("A");
    a.return = a; // cycle
    expect(() => walkFiber(a)).not.toThrow();
  });
});

/**
 * The descent is bounded in DEPTH by MAX_LABEL_DESCENT, but a subtree is wide as well as deep.
 * The browser package's `accessibility.ts` treats a name over 100 chars as "content leaking in
 * where no real label exists" and answers it
 * with a character cap AND a container-dump rule that drops the text entirely rather than storing
 * a meaningless prefix. These are the same two rules for the RN descent.
 */
describe("walkFiber — the child-text descent is bounded in breadth and length, not just depth", () => {
  /**
   * The tap that gets here is the common one, not a contrived shape: GroundcoverProvider's root
   * View bubbles onTouchStart/onTouchEnd, so a tap on blank space — a ScrollView background, list
   * padding, a screen container's flex gap — resolves to the CONTAINER's host fiber. It carries no
   * accessibilityLabel, so the descent runs against its entire child array.
   *
   * Without a breadth bound this returns the whole visible subtree concatenated — thousands of
   * characters for the 100 rows below, shipped uncapped on every such tap (`componentPath` is
   * capped at MAX_PATH_CHARS; `label` would not be). Storing a 200-char PREFIX of that is no
   * better — it is still a text dump, not a name — so an overrun drops the label and lets the walk
   * continue to an ancestor's accessibilityLabel, which is the answer the author actually wrote.
   */
  it("drops a container's text dump instead of shipping it as a label", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      props: { children: `Row number ${i} with some visible content` },
    }));
    const container = fiber("ScrollView", { children: rows });

    expect(walkFiber(container).label).toBe("");
  });

  it("falls back to an ancestor's accessibilityLabel once the dump is dropped", () => {
    const screen = fiber("HomeScreen", { accessibilityLabel: "Home" });
    const rows = Array.from({ length: 100 }, (_, i) => ({
      props: { children: `Row number ${i} with some visible content` },
    }));
    const container = fiber("ScrollView", { children: rows }, screen);

    expect(walkFiber(container).label).toBe("Home");
  });

  /**
   * The cap has to stop the WORK, not just trim the result. This descent runs synchronously inside
   * the touch handler (handleEvent → buildEvent → walkFiber) before the interaction is enqueued, so
   * a wide subtree costs the user a stalled gesture whatever we do with the string afterwards.
   *
   * Counting `props` reads is what distinguishes the two: a version that walks all 500 children and
   * then truncates passes an assertion on `label`, and fails this one.
   */
  it("stops descending once the budget is spent, rather than trimming afterwards", () => {
    let reads = 0;
    const children = Array.from({ length: 500 }, (_, i) => ({
      get props() {
        reads++;
        return { children: `Row number ${i} with some visible content` };
      },
    }));
    const container = fiber("ScrollView", { children });

    walkFiber(container);
    expect(reads).toBeLessThanOrEqual(64);
  });

  /**
   * Breadth alone can exhaust the budget with text far under the character cap — 500 one-character
   * siblings. Stopping there means the scan is PARTIAL, and a partial scan cannot be trusted for
   * privacy: `dataPrivate` on sibling 400 would never be read, and the text already collected would
   * ship unmasked. So any truncation drops the label, on either budget.
   */
  it("drops the label when breadth alone exhausts the budget, so a partial scan never ships", () => {
    const children = Array.from({ length: 500 }, () => ({ props: { children: "a" } }));
    const container = fiber("ScrollView", { children });

    expect(walkFiber(container).label).toBe("");
  });

  /**
   * The line the bound must not cross. A real control's composed children stay well inside the
   * budget, and the e2e assertions on visible text over a different accessibilityLabel key on
   * strings this size.
   */
  it("leaves an ordinary composed label untouched", () => {
    const children = [{ props: { children: "★" } }, { props: { children: "Well-tagged button" } }];
    const pressable = fiber("Pressable", { accessibilityRole: "button", children });

    expect(walkFiber(pressable).label).toBe("Well-tagged button");
  });

  // Nest `inner` under `depth` wrapper elements, each `{ props: { children } }` — the shape React
  // hands us for a composed control.
  const nest = (depth: number, inner: unknown): unknown =>
    depth === 0 ? inner : nest(depth - 1, { props: { children: inner } });

  /**
   * DEPTH is the third way a descent can stop early, and the easiest one to mistake for a
   * complete scan. The rule above is not about WHICH budget ran out — it is about whether the whole
   * subtree was read. Bottoming out at MAX_LABEL_DESCENT leaves everything below uninspected, so a
   * `dataPrivate` down there is never seen while a shallow sibling's text is still accepted, and
   * the label ships unmasked.
   *
   * Neither budget fires here: two array children and thirteen characters, far inside both caps.
   * Depth alone stops the scan, which is the point.
   */
  it("drops the label when the depth bound stops the scan, so an unread dataPrivate cannot leak", () => {
    // Six wrappers put the private element AT the bound, so the descent returns before reading its
    // props — the marker is never seen, not merely ignored. (Six, not five: the enclosing array is
    // a transparent wrapper and does not spend a level. At five the leaf sits INSIDE the bound,
    // gets read, and comes back correctly masked — safe, but not what this test is pinning.)
    const privateLeaf = { props: { dataPrivate: true, children: "4111 1111 1111 1111" } };
    const container = fiber("Card", {
      children: [{ props: { children: "Order summary" } }, nest(6, privateLeaf)],
    });

    expect(walkFiber(container).label).toBe("");
  });

  /**
   * The other side of that boundary, so the bound is pinned rather than merely tightened: nesting
   * that stays inside MAX_LABEL_DESCENT still yields its label. A control wrapped in styled Views
   * is ordinary, and voiding those would undo the descent this file exists for.
   */
  it("still recovers a label from nesting that stays inside the depth bound", () => {
    const pressable = fiber("Pressable", {
      accessibilityRole: "button",
      children: nest(5, { props: { children: "Save" } }),
    });

    expect(walkFiber(pressable).label).toBe("Save");
  });

  /**
   * The bound is about what went UNREAD, so it must not fire on things with nothing under them.
   * `{cond && <X/>}` renders `false`, `{maybe}` renders `null`, a `.map()` over an empty list
   * renders `[]` — all ordinary, and all terminal. Marking those as a partial scan voids a label
   * that was fully and safely recovered from a sibling, so a control loses its name for rendering
   * a conditional deep in its tree.
   */
  it("treats a terminal child at the depth bound as an honest empty, not a partial scan", () => {
    for (const terminal of [null, undefined, false, []]) {
      const container = fiber("Card", {
        children: [{ props: { children: "Order summary" } }, nest(6, terminal)],
      });

      expect(walkFiber(container).label).toBe("Order summary");
    }
  });

  /**
   * MAX_LABEL_DESCENT counts nested child ELEMENTS, as its name and its comment both say. React
   * flattens arrays and fragments, so neither is a level the author wrote or the user can see, and
   * spending the element budget on them exhausts it early — erasing a label that sits only a few
   * real elements down.
   *
   * This matters because a bottomed-out descent voids the whole label, not just that branch.
   */
  it("does not spend the element-depth bound on array wrappers", () => {
    // Three element levels — well inside the bound — reached through four nested arrays, the shape
    // `{sections.map(s => s.items.map(...))}` produces.
    const label = { props: { children: { props: { children: { props: { children: "Save" } } } } } };
    const pressable = fiber("Pressable", { accessibilityRole: "button", children: [[[[label]]]] });

    expect(walkFiber(pressable).label).toBe("Save");
  });

  it("does not spend the element-depth bound on fragment wrappers", () => {
    const frag = (children: unknown) => ({ type: Symbol.for("react.fragment"), props: { children } });
    // Six nested fragments around one real element — no visible nesting at all.
    const pressable = fiber("Pressable", {
      accessibilityRole: "button",
      children: frag(frag(frag(frag(frag(frag({ props: { children: "Save" } })))))),
    });

    expect(walkFiber(pressable).label).toBe("Save");
  });

  /**
   * The node budget bounds WORK. A child that renders nothing costs none: no text, no subtree, no
   * recursion. Charging it anyway lets conditional holes exhaust the budget and void a label that
   * is sitting right there — and `{items.map(i => visible(i) && <Row/>)}` produces exactly that,
   * one `false` per hidden entry.
   */
  it("does not spend the node budget on children that render nothing", () => {
    for (const hole of [false, null, undefined, []]) {
      const holes = Array.from({ length: 40 }, () => hole);
      const pressable = fiber("Pressable", {
        accessibilityRole: "button",
        children: [...holes, { props: { children: "Save" } }],
      });

      expect(walkFiber(pressable).label).toBe("Save");
    }
  });

  /**
   * React renders any iterable in a child position, so a `Set` of elements is a valid child this
   * walk cannot interpret. It is deliberately NOT read. Reading it would mean iterating a
   * collection the app owns, and separating a reusable collection from a single-use iterator is a
   * judgement call this code should not be making inside a touch handler.
   *
   * Unread means the label is voided, which is also the stronger privacy outcome: the private text
   * is never recovered at all, rather than recovered into the result and flagged for a downstream
   * consumer to redact.
   */
  it("voids the label for an iterable child instead of reading the app's collection", () => {
    const privateChild = { props: { dataPrivate: true, children: "4111 1111 1111 1111" } };
    const container = fiber("Card", {
      children: [{ props: { children: "Order summary" } }, new Set([privateChild])],
    });

    const result = walkFiber(container);

    expect(result.label).toBe("");
    // Not "it was masked" — it never entered the result at all.
    expect(JSON.stringify(result)).not.toContain("4111");
  });

  /**
   * And where it genuinely cannot look — a fulfilled Promise child (React 19 unwraps thenables),
   * a portal, anything object-shaped it does not recognise — the honest answer is a partial scan.
   * NO_TEXT asserts "read it all, there was no text", which here would be a guess.
   */
  it("voids the label for an object child it cannot read, rather than claiming a complete scan", () => {
    const container = fiber("Card", {
      children: [{ props: { children: "Order summary" } }, Promise.resolve(null)],
    });

    expect(walkFiber(container).label).toBe("");
  });

  /**
   * Guards against reading iterables: a generator IS its own iterator, so draining one to read a
   * label would leave React nothing to render on the next pass, instrumentation breaking the app
   * it measures. The walk does not iterate child objects, so this holds by construction.
   */
  it("never drains a single-use iterator child", () => {
    function* gen() {
      yield { props: { children: "Save" } };
    }
    const iterator = gen();
    const container = fiber("Card", { children: [iterator] });

    walkFiber(container);

    expect([...iterator]).toHaveLength(1);
  });
});
