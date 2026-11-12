import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WebEffectivePrivacy } from "@/privacy/web-privacy";
import {
  getAccessibilityInfo,
  getAccessibleName,
  getActionableElement,
  getOwnTextLabel,
  getRole,
  labelledByHasMaskedContent,
  subtreeHasMaskedContent,
} from "./accessibility";

function privacy(overrides: Partial<WebEffectivePrivacy> = {}): WebEffectivePrivacy {
  return {
    level: "mask-sensitive",
    maskSelectors: [],
    maskNetworkBodies: true,
    maskNetworkQueryParams: true,
    maskLogs: true,
    maskErrors: true,
    shouldMaskNetworkBodies: true,
    shouldMaskNetworkQueryParams: true,
    shouldMaskLogs: true,
    shouldMaskErrors: true,
    sensitiveKeys: [],
    ...overrides,
  };
}

describe("accessibility", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe("getActionableElement", () => {
    it("resolves an inner span up to its enclosing button", () => {
      const button = document.createElement("button");
      const span = document.createElement("span");
      button.appendChild(span);
      container.appendChild(button);

      expect(getActionableElement(span)).toBe(button);
    });

    it("returns the element itself when it is interactive", () => {
      const button = document.createElement("button");
      container.appendChild(button);

      expect(getActionableElement(button)).toBe(button);
    });

    it("resolves via an ARIA role", () => {
      const menuitem = document.createElement("div");
      menuitem.setAttribute("role", "menuitem");
      const label = document.createElement("span");
      menuitem.appendChild(label);
      container.appendChild(menuitem);

      expect(getActionableElement(label)).toBe(menuitem);
    });

    it("resolves via a multi-token role list (role='combobox textbox')", () => {
      const widget = document.createElement("div");
      widget.setAttribute("role", "combobox textbox");
      const inner = document.createElement("span");
      widget.appendChild(inner);
      container.appendChild(widget);

      expect(getActionableElement(inner)).toBe(widget);
    });

    it("resolves an inner node up to a custom widget role (combobox/slider/textbox)", () => {
      for (const role of ["combobox", "slider", "textbox", "spinbutton", "searchbox"]) {
        const widget = document.createElement("div");
        widget.setAttribute("role", role);
        const inner = document.createElement("span");
        inner.textContent = "x";
        widget.appendChild(inner);
        container.appendChild(widget);

        expect(getActionableElement(inner)).toBe(widget);
      }
    });

    it("returns null when there is no interactive ancestor", () => {
      const div = document.createElement("div");
      div.id = "root";
      const inner = document.createElement("div");
      div.appendChild(inner);
      container.appendChild(div);

      expect(getActionableElement(inner)).toBeNull();
    });

    it("returns null for null / non-element input", () => {
      expect(getActionableElement(null)).toBeNull();
    });
  });

  describe("getAccessibleName", () => {
    it("prefers aria-label over content", () => {
      const button = document.createElement("button");
      button.setAttribute("aria-label", "Close dialog");
      button.textContent = "X";
      container.appendChild(button);

      expect(getAccessibleName(button)).toBe("Close dialog");
    });

    it("prefers aria-labelledby over aria-label when both are present", () => {
      const label = document.createElement("span");
      label.id = "lbl-both";
      label.textContent = "From labelledby";
      const button = document.createElement("button");
      button.setAttribute("aria-labelledby", "lbl-both");
      button.setAttribute("aria-label", "From aria-label");
      container.append(label, button);

      expect(getAccessibleName(button)).toBe("From labelledby");
    });

    it("resolves aria-labelledby to referenced element text", () => {
      const label = document.createElement("span");
      label.id = "lbl-1";
      label.textContent = "First name";
      const input = document.createElement("input");
      input.setAttribute("aria-labelledby", "lbl-1");
      container.append(label, input);

      expect(getAccessibleName(input)).toBe("First name");
    });

    it("ignores missing aria-labelledby ids and falls through", () => {
      const button = document.createElement("button");
      button.setAttribute("aria-labelledby", "does-not-exist");
      button.textContent = "Save";
      container.appendChild(button);

      expect(getAccessibleName(button)).toBe("Save");
    });

    it("does not leak a container dump through aria-labelledby", () => {
      // aria-labelledby pointing at a container (listbox) must not concatenate
      // its child option labels into the accessible name.
      const listbox = document.createElement("div");
      listbox.id = "lb-dump";
      listbox.setAttribute("role", "listbox");
      for (const t of ["Option A", "Option B", "Option C"]) {
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = t;
        listbox.appendChild(o);
      }
      const input = document.createElement("input");
      input.setAttribute("aria-labelledby", "lb-dump");
      container.append(listbox, input);

      expect(getAccessibleName(input)).toBe("");
    });

    it("uses alt on images", () => {
      const img = document.createElement("img");
      img.setAttribute("alt", "Company logo");
      container.appendChild(img);

      expect(getAccessibleName(img)).toBe("Company logo");
    });

    it("uses the value attribute on button-like inputs", () => {
      const submit = document.createElement("input");
      submit.setAttribute("type", "submit");
      submit.setAttribute("value", "Send");
      container.appendChild(submit);

      expect(getAccessibleName(submit)).toBe("Send");
    });

    it("falls back to title then placeholder", () => {
      const withTitle = document.createElement("div");
      withTitle.setAttribute("role", "button");
      withTitle.setAttribute("title", "Help");
      container.appendChild(withTitle);
      expect(getAccessibleName(withTitle)).toBe("Help");

      const input = document.createElement("input");
      input.setAttribute("placeholder", "Search…");
      container.appendChild(input);
      expect(getAccessibleName(input)).toBe("Search…");
    });

    it("uses the visible text of a leaf button", () => {
      const button = document.createElement("button");
      button.textContent = "Save";
      container.appendChild(button);

      expect(getAccessibleName(button)).toBe("Save");
    });

    it("prefers the element's own text over a title tooltip (ARIA name-from-content)", () => {
      const button = document.createElement("button");
      button.setAttribute("title", "Save your unsaved changes to the server");
      button.textContent = "Save";
      container.appendChild(button);

      // The visible label wins; title is only a fallback for content-less controls.
      expect(getAccessibleName(button)).toBe("Save");
    });

    it("NEVER reads the value of a text input (no PII leak)", () => {
      const input = document.createElement("input");
      input.setAttribute("type", "text");
      input.setAttribute("value", "secret");
      container.appendChild(input);

      expect(getAccessibleName(input)).toBe("");
    });

    it("hard-caps the name at 100 chars TOTAL, ellipsis included", () => {
      const button = document.createElement("button");
      button.setAttribute("aria-label", "x".repeat(500));
      container.appendChild(button);

      const name = getAccessibleName(button);
      expect(name.length).toBe(100); // 99 content chars + the ellipsis
      expect(name.endsWith("…")).toBe(true);
      expect(name.startsWith("x".repeat(99))).toBe(true);
    });

    it("returns empty for a BODY target (whole-page text is not a label)", () => {
      // A keydown with nothing focused bubbles to <body>.
      expect(getAccessibleName(document.body)).toBe("");
    });

    it("returns empty for an HTML target", () => {
      expect(getAccessibleName(document.documentElement)).toBe("");
    });
  });

  describe("getRole", () => {
    it("prefers the explicit role attribute", () => {
      const div = document.createElement("div");
      div.setAttribute("role", "tab");
      expect(getRole(div)).toBe("tab");
    });

    it("maps <a href> to link but bare <a> to empty", () => {
      const link = document.createElement("a");
      link.setAttribute("href", "/x");
      expect(getRole(link)).toBe("link");

      const bare = document.createElement("a");
      expect(getRole(bare)).toBe("");
    });

    it("maps checkbox inputs and headings", () => {
      const checkbox = document.createElement("input");
      checkbox.setAttribute("type", "checkbox");
      expect(getRole(checkbox)).toBe("checkbox");

      const heading = document.createElement("h2");
      expect(getRole(heading)).toBe("heading");
    });

    it("maps a plain button", () => {
      expect(getRole(document.createElement("button"))).toBe("button");
    });

    it("returns the first token of a multi-token role list", () => {
      const el = document.createElement("div");
      el.setAttribute("role", "combobox textbox");
      expect(getRole(el)).toBe("combobox");
    });
  });

  describe("getOwnTextLabel", () => {
    it("drops the text when it exceeds the container threshold", () => {
      const root = document.createElement("div");
      root.textContent = "a ".repeat(1000); // ~2000 chars normalized
      container.appendChild(root);

      expect(getOwnTextLabel(root)).toBe("");
    });

    it("keeps exact clean text for a leaf", () => {
      const cell = document.createElement("div");
      cell.textContent = "[api] Checkout Service";
      container.appendChild(cell);

      expect(getOwnTextLabel(cell)).toBe("[api] Checkout Service");
    });

    it("keeps the label of an icon button (SVG has no text)", () => {
      const button = document.createElement("button");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (let i = 0; i < 30; i++) {
        svg.appendChild(
          document.createElementNS("http://www.w3.org/2000/svg", "path")
        );
      }
      button.appendChild(svg);
      button.appendChild(document.createTextNode("Save"));
      container.appendChild(button);

      expect(getOwnTextLabel(button)).toBe("Save");
    });

    it("collapses whitespace and newlines to single spaces", () => {
      const el = document.createElement("div");
      el.textContent = "  Line one\n\n\tLine two   ";
      container.appendChild(el);

      expect(getOwnTextLabel(el)).toBe("Line one Line two");
    });

    it("truncates long-but-under-threshold text to 255 chars", () => {
      const el = document.createElement("div");
      el.textContent = "x".repeat(500);
      container.appendChild(el);

      expect(getOwnTextLabel(el).length).toBe(255);
    });

    it("returns empty for null", () => {
      expect(getOwnTextLabel(null)).toBe("");
    });

    it("returns empty for BODY (whole-page text dump)", () => {
      expect(getOwnTextLabel(document.body)).toBe("");
    });

    it("drops a listbox whose options concatenate into a dump", () => {
      const listbox = document.createElement("div");
      listbox.setAttribute("role", "listbox");
      for (const label of ["Filter by level", "Filter by status", "Search"]) {
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.textContent = label;
        listbox.appendChild(opt);
      }
      container.appendChild(listbox);

      expect(getOwnTextLabel(listbox)).toBe("");
    });

    it("drops a nav container whose links concatenate", () => {
      const nav = document.createElement("div");
      for (const label of ["Workloads", "Infrastructure", "Logs"]) {
        const a = document.createElement("a");
        a.setAttribute("href", "/" + label.toLowerCase());
        a.textContent = label;
        nav.appendChild(a);
      }
      container.appendChild(nav);

      expect(getOwnTextLabel(nav)).toBe("");
    });

    it("drops a form container whose field labels concatenate", () => {
      const form = document.createElement("form");
      form.appendChild(document.createElement("input"));
      form.appendChild(document.createElement("input"));
      container.appendChild(form);

      expect(getOwnTextLabel(form)).toBe("");
    });

    it("keeps text when only a single child control is nested (card with one button)", () => {
      // One interactive descendant is below the container threshold, so a card
      // link that wraps a lone close button keeps its own label.
      const card = document.createElement("div");
      card.appendChild(document.createTextNode("Open dashboard"));
      card.appendChild(document.createElement("button"));
      container.appendChild(card);

      expect(getOwnTextLabel(card)).toBe("Open dashboard");
    });
  });

  describe("subtreeHasMaskedContent", () => {
    it("is true when a [data-private] descendant exists", () => {
      const wrap = document.createElement("div");
      const secret = document.createElement("span");
      secret.setAttribute("data-private", "");
      wrap.appendChild(secret);
      container.appendChild(wrap);

      expect(subtreeHasMaskedContent(wrap, privacy())).toBe(true);
    });

    it("is true when a configured mask selector matches a descendant", () => {
      const wrap = document.createElement("div");
      const child = document.createElement("span");
      child.id = "user-ssn";
      wrap.appendChild(child);
      container.appendChild(wrap);

      expect(
        subtreeHasMaskedContent(wrap, privacy({ maskSelectors: ["[id*='ssn']"] }))
      ).toBe(true);
    });

    it("is false when nothing is masked", () => {
      const wrap = document.createElement("div");
      wrap.appendChild(document.createElement("span"));
      container.appendChild(wrap);

      expect(subtreeHasMaskedContent(wrap, privacy())).toBe(false);
    });

    it("is false under the allow level", () => {
      const wrap = document.createElement("div");
      const secret = document.createElement("span");
      secret.setAttribute("data-private", "");
      wrap.appendChild(secret);
      container.appendChild(wrap);

      expect(subtreeHasMaskedContent(wrap, privacy({ level: "allow" }))).toBe(false);
    });
  });

  describe("labelledByHasMaskedContent", () => {
    it("is true when the aria-labelledby target itself is masked", () => {
      const label = document.createElement("div");
      label.id = "lbl-masked";
      label.setAttribute("data-private", "");
      label.textContent = "Sensitive label"; // contributes name text
      const btn = document.createElement("button");
      btn.setAttribute("aria-labelledby", "lbl-masked");
      container.append(label, btn);

      expect(labelledByHasMaskedContent(btn, privacy())).toBe(true);
    });

    it("is true when a masked DESCENDANT of the labelledby target would leak into the name", () => {
      // The name reads the label's whole textContent, so a data-private child of
      // the referenced element must mask too — shouldMaskElement only walks up.
      const label = document.createElement("div");
      label.id = "lbl-desc";
      label.appendChild(document.createTextNode("Card "));
      const secret = document.createElement("span");
      secret.setAttribute("data-private", "");
      secret.textContent = "4111-1111-1111-1111";
      label.appendChild(secret);
      const btn = document.createElement("button");
      btn.setAttribute("aria-labelledby", "lbl-desc");
      container.append(label, btn);

      expect(labelledByHasMaskedContent(btn, privacy())).toBe(true);
    });

    it("is false when neither the labelledby target nor its subtree is masked", () => {
      const label = document.createElement("div");
      label.id = "lbl-clean";
      label.textContent = "First name";
      const input = document.createElement("input");
      input.setAttribute("aria-labelledby", "lbl-clean");
      container.append(label, input);

      expect(labelledByHasMaskedContent(input, privacy())).toBe(false);
    });

    it("does not mask when the masked descendant is in a dropped container ref (no name contribution)", () => {
      // The ref is a listbox (container) whose text getLabelledByText drops, so
      // its masked descendant never reaches the name — masking the event for it
      // would be spurious over-redaction.
      const listbox = document.createElement("div");
      listbox.id = "lbl-container";
      listbox.setAttribute("role", "listbox");
      for (const t of ["A", "B", "C"]) {
        const o = document.createElement("div");
        o.setAttribute("role", "option");
        o.textContent = t;
        listbox.appendChild(o);
      }
      const secret = document.createElement("span");
      secret.setAttribute("data-private", "");
      secret.textContent = "secret";
      listbox.appendChild(secret);
      const btn = document.createElement("button");
      btn.setAttribute("aria-labelledby", "lbl-container");
      btn.textContent = "Open";
      container.append(listbox, btn);

      expect(labelledByHasMaskedContent(btn, privacy())).toBe(false);
    });
  });

  describe("getAccessibilityInfo", () => {
    it("returns all-empty defaults for null", () => {
      expect(getAccessibilityInfo(null)).toEqual({
        role: "",
        accessibleName: "",
        ariaLabel: "",
        title: "",
        alt: "",
        placeholder: "",
        name: "",
        inputType: "",
        href: "",
      });
    });

    it("collects the full bundle from an anchor", () => {
      const a = document.createElement("a");
      a.setAttribute("href", "/pay");
      a.setAttribute("title", "Pay now");
      a.textContent = "Pay";
      container.appendChild(a);

      const info = getAccessibilityInfo(a);
      expect(info.role).toBe("link");
      expect(info.href).toBe("/pay");
      expect(info.title).toBe("Pay now"); // raw title field still captured
      expect(info.accessibleName).toBe("Pay"); // content wins over the title (ARIA)
    });

    it("caps page-controlled attribute values at 255 chars", () => {
      const a = document.createElement("a");
      a.setAttribute("title", "t".repeat(5000));
      a.setAttribute("href", "https://x.test/" + "q".repeat(5000));
      container.appendChild(a);

      const info = getAccessibilityInfo(a);
      expect(info.title.length).toBe(255);
      expect(info.href.length).toBe(255);
    });

    it("does not throw when getAttribute throws", () => {
      // Detached on purpose: happy-dom calls getAttribute internally during
      // append/remove, so overriding it on a connected node breaks the harness,
      // not the code under test.
      const el = document.createElement("div");
      Object.defineProperty(el, "getAttribute", {
        value: () => {
          throw new Error("boom");
        },
      });

      expect(() => getAccessibilityInfo(el)).not.toThrow();
      expect(getAccessibilityInfo(el).role).toBe("");
    });
  });
});
