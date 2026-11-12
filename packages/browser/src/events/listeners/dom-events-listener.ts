import { BaseEvent } from "@groundcover/rum-core/events/types";
import { DomEventAttributes } from "../types";

import { handleError } from "@groundcover/rum-core/common/error-handler";
import { _globalThis } from "../../common/global";

import { BaseListener } from "@groundcover/rum-core/events/listeners/base-listener";
import { resolveWebPrivacy } from "@/privacy/web-privacy";
import {
  getElementTagName,
  safeGetAttribute,
  shouldMaskElement,
} from "@/privacy/element";
import {
  getAccessibilityInfo,
  getActionableElement,
  getOwnTextLabel,
  labelledByHasMaskedContent,
  subtreeHasMaskedContent,
} from "@/common/accessibility";
import { redactUrl } from "@groundcover/rum-core/privacy/redaction";

export class DomEventsListener extends BaseListener {
  private eventHandlers: { type: string; handler: EventListener }[] = [];
  private capturedEvents: string[] = [
    "click",
    "change",
    "keydown",
    "select",
    "submit",
  ];

  initialize() {
    try {
      this.logger.log("[dom-events-listener.initialize] called");

      this.capturedEvents?.forEach((type) => {
        const handler = ((event: Event) => {
          try {
            this.handleEvent(event);
          } catch (error) {
            handleError(error);
          }
        }) as EventListener;

        // Store reference to handler for cleanup
        this.eventHandlers.push({ type, handler });

        _globalThis?.addEventListener(type, handler);
      });
    } catch (error) {
      handleError(error);
    }
  }

  destroy() {
    this.eventHandlers.forEach(({ type, handler }) => {
      global?.removeEventListener?.(type, handler);
    });
    this.eventHandlers = [];
  }

  handleEvent(event: Event) {
    try {
      const fullEvent = this.buildEvent(event);
      this.queueEvent(fullEvent);
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent(event: Event) {
    const coordinates = this.getCoordinates(event);
    const rawTarget = event.target as Element;
    // Resolve the interactive element the user perceives pressing (the click
    // often lands on a deep inner node). Describe THIS element for the whole
    // target; fall back to the raw target when there's no interactive ancestor.
    const target = getActionableElement(rawTarget) ?? rawTarget;
    const privacy = resolveWebPrivacy(this.config);
    // Compute the mask decision once and share it — getKeyCode, the selector, and
    // the text fields all need it. Upward signal comes from the RAW target
    // (closest catches a data-private on/above the clicked node, incl. `target`);
    // downward signal covers a masked sibling whose text is aggregated into the
    // effective element's textContent; and aria-labelledby can pull a private
    // label from elsewhere in the document into the accessible name.
    const shouldMask =
      this.getShouldMaskText({ target: rawTarget || null }) ||
      (target
        ? subtreeHasMaskedContent(target, privacy) ||
          labelledByHasMaskedContent(target, privacy)
        : false);
    // The selector embeds attribute VALUES (aria-label/title/alt via
    // priorityAttributes). When masking, restrict it to structural attributes so
    // those sensitive values don't leak through the selector while the matching
    // a11y fields are masked to "*".
    const selector = target
      ? this.generateSelector(
          target,
          shouldMask
            ? { priorityAttributes: ["id", "class", "name", "type"] }
            : {}
        )
      : "";
    const keyCode = this.getKeyCode(event as KeyboardEvent, shouldMask);
    // The element's own text label — computed once and reused for both the `text`
    // field and the accessible name's content fallback (via getAccessibilityInfo),
    // avoiding a second subtree scan per event.
    const ownText = getOwnTextLabel(target);
    const a11y = getAccessibilityInfo(target, ownText);
    // An href can carry sensitive query params (e.g. /reset?token=...). Redact
    // them for the same reason network URLs are redacted, honoring the same
    // toggle — even when the element itself isn't masked.
    const href = privacy.shouldMaskNetworkQueryParams
      ? redactUrl(a11y.href, {
          sensitiveKeys: privacy.sensitiveKeys,
          redact: privacy.redact,
          kind: "query",
        })
      : a11y.href;
    // For the a11y fields, mask only non-empty values — don't turn an absent
    // attribute into "*". `text` is different (see below): it's always "*" when
    // masked, matching the long-standing contract that a masked element's text
    // is redacted even when it has no own text (e.g. an <input>, whose value is
    // never in textContent).
    const maskText = (value: string) => (shouldMask && value ? "*" : value);

    this.logger.log("[dom-events-listener.buildEvent] called");

    const attributes: DomEventAttributes = {
      dom_event_selector: selector,
      dom_event_key_code: keyCode,
      dom_event_type: event.type,
      dom_event_coordinates: coordinates || { clientX: 0, clientY: 0 },
      dom_event_target: {
        id: safeGetAttribute(target, 'id'),
        tagName: getElementTagName(target),
        className: safeGetAttribute(target, 'class'),
        text: shouldMask ? "*" : ownText,
        role: a11y.role,
        accessibleName: maskText(a11y.accessibleName),
        ariaLabel: maskText(a11y.ariaLabel),
        title: maskText(a11y.title),
        alt: maskText(a11y.alt),
        placeholder: maskText(a11y.placeholder),
        name: a11y.name,
        inputType: a11y.inputType,
        href: maskText(href),
      },
    };

    return this.enricher.enrich({
      type: "dom.event",
      attributes,
    });
  }

  queueEvent(event: BaseEvent) {
    try {
      this.logger.log("[dom-events-listener.queueEvent] called");

      if (event) {
        this.eventsPool.addEvent(event);
      }
    } catch (error) {
      handleError(error);
    }
  }

  // Upward mask signal: data-private / mask-selector on `target` or any ancestor
  // (shouldMaskElement is ancestor-aware via closest). The downward subtree
  // signal is OR'd in by buildEvent so the decision stays a single call here.
  private getShouldMaskText = (event: { target: Element | null }): boolean =>
    shouldMaskElement(event.target, resolveWebPrivacy(this.config));

  private getKeyCode = (event: KeyboardEvent, shouldMask: boolean): string => {
    if (event instanceof KeyboardEvent && event.code && event.key !== "Dead") {
      return shouldMask ? "*" : event.key;
    }

    return "";
  };

  private getCoordinates = (event: Event) => {
    const eventsWithCoordinates: Record<string, boolean> = {
      mouseup: true,
      mousedown: true,
      mousemove: true,
      mouseover: true,
    };

    if (eventsWithCoordinates[event.type]) {
      const { clientX, clientY } = (event as MouseEvent) || {};
      return { clientX, clientY };
    }

    return null;
  };

  generateSelector(
    element: Element | null,
    options: {
      root?: Element;
      maxAttempts?: number;
      priorityAttributes?: string[];
    } = {}
  ): string {
    if (
      !element ||
      !element.nodeType ||
      element.nodeType !== Node.ELEMENT_NODE
    ) {
      return "";
    }

    const root = options.root || document.body || document.documentElement;
    const maxAttempts = options.maxAttempts || 10;
    const priorityAttributes = options.priorityAttributes || [
      "id",
      "class",
      "name",
      "aria-label",
      "type",
      "title",
      "alt",
    ];

    if (getElementTagName(element).toLowerCase() === "html") {
      return "html";
    }

    let selector = "";
    let attempts = 0;
    let currentElement: Element | null = element;
    const selectorParts: string[] = [];

    while (
      currentElement &&
      currentElement !== root &&
      currentElement !== document.documentElement &&
      attempts < maxAttempts
    ) {
      let elementSelector = getElementTagName(currentElement).toLowerCase();

      try {
        const id = currentElement.getAttribute("id");
        if (id && /^[a-zA-Z][\w-]*$/.test(id)) {
          return `#${id}`;
        }

        if (currentElement.classList?.length) {
          const safeClasses = Array.from(currentElement.classList)
            .filter((c) => c && typeof c === "string")
            .map((c) => `.${c}`);

          if (safeClasses.length) {
            elementSelector += safeClasses.join("");
          }
        }

        for (const attr of priorityAttributes) {
          if (attr === "id" || attr === "class") continue;

          try {
            const value = currentElement.getAttribute(attr);
            if (value) {
              elementSelector += `[${attr}="${value.replace(/"/g, '\\"')}"]`;
            }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (error) {
            // skip this attribute if there's an error
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        elementSelector = getElementTagName(currentElement).toLowerCase() || "*";
      }

      selectorParts.unshift(elementSelector || "*");
      selector = selectorParts.join(" > ");

      try {
        const matches = root.querySelectorAll(selector);
        if (matches.length === 1) {
          return selector;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        selectorParts.shift();
        selector = selectorParts.join(" > ");
      }

      try {
        currentElement = currentElement.parentElement;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        break;
      }

      attempts++;
    }

    // Return what we hav  or fallback to a safe value
    return selector || "*";
  }
}
