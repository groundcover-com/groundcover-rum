import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DomEventsListener } from "./dom-events-listener";
import { ConfigManager } from "@groundcover/rum-core/config/config-manager";
// Browser-typed config surfaces: maskSelectors lives on the BROWSER
// PrivacyOptions (core's privacy type is lean), so fixtures that feed
// maskSelectors through the core-typed ConfigManager are typed here.
import { PrivacyOptions, SDKConfigInput } from "../../config/types";
import { EventsPool } from "@groundcover/rum-core/events/events-pool";
import { EventEnricher } from "@groundcover/rum-core/events/event-enricher";

// Every test builds its own ConfigManager (nothing shared to reset) and wires
// the listener with a REAL enricher so buildEvent's attribute flattening
// behaves as in production.
const createConfigManager = () =>
  new ConfigManager();

const createListener = (configManager: ConfigManager = createConfigManager()) =>
  new DomEventsListener({
    config: configManager,
    eventsPool: { addEvent: vi.fn() } as unknown as EventsPool,
    enricher: new EventEnricher(),
  });

describe("dom-events-listener", () => {
  let container: HTMLElement;
  let listener: DomEventsListener;
  
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  // Clean up after each test
  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  describe("generateSelector", () => {
    beforeEach(() => {
      // Create listener for generateSelector tests
      listener = createListener();
    });

    it("should return an empty string for null elements", () => {
      expect(listener.generateSelector(null)).toBe("");
    });

    it("should return an empty string for non-element nodes", () => {
      const textNode = document.createTextNode("Test");
      // @ts-expect-error - Intentionally testing with wrong type
      expect(listener.generateSelector(textNode)).toBe("");
    });

    it('should return "html" for the HTML element', () => {
      const html = document.documentElement;
      expect(listener.generateSelector(html)).toBe("html");
    });

    it("should generate a selector with ID when available", () => {
      const div = document.createElement("div");
      div.id = "test-id";
      container.appendChild(div);

      expect(listener.generateSelector(div)).toBe("#test-id");
    });

    it("should ignore invalid IDs", () => {
      const div = document.createElement("div");
      div.id = "123-invalid-id"; // IDs should not start with a number
      container.appendChild(div);

      // Should not use the invalid ID in the selector
      expect(listener.generateSelector(div)).not.toBe("#123-invalid-id");
    });

    it("should use classes when ID is not available", () => {
      const div = document.createElement("div");
      div.className = "test-class another-class";
      container.appendChild(div);

      expect(listener.generateSelector(div)).toBe("div.test-class.another-class");
    });

    it("should use priority attributes when ID and classes are not available", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "username");
      input.setAttribute("type", "text");
      container.appendChild(input);

      const selector = listener.generateSelector(input);
      expect(selector).toContain("input");
      expect(selector).toContain('[name="username"]');
      expect(selector).toContain('[type="text"]');
    });

    it("should handle nested elements correctly", () => {
      // Create a nested structure
      const parent = document.createElement("div");
      parent.className = "parent";

      const child = document.createElement("span");
      child.className = "child";

      const grandchild = document.createElement("a");
      grandchild.setAttribute("href", "#");
      grandchild.textContent = "Link";

      parent.appendChild(child);
      child.appendChild(grandchild);
      container.appendChild(parent);

      const selector = listener.generateSelector(grandchild);

      // The selector may be the tag name alone or a short path rather than the
      // full hierarchy; either way it names the anchor and resolves to it.
      expect(selector).toContain("a");

      // Verify that the selector correctly identifies the element
      const found = document.querySelector(selector);
      expect(found).toBe(grandchild);
    });

    it("should respect the root option", () => {
      const parent = document.createElement("div");
      parent.className = "parent";

      const child = document.createElement("span");
      child.className = "child";

      parent.appendChild(child);
      container.appendChild(parent);

      // When using parent as root, the selector should not include parent
      const selector = listener.generateSelector(child, { root: parent });

      expect(selector).toBe("span.child");
      expect(selector).not.toContain("div.parent");
    });

    it("should respect the maxAttempts option", () => {
      // Create a deeply nested structure
      let currentElement = container;

      for (let i = 0; i < 15; i++) {
        const div = document.createElement("div");
        div.className = `level-${i}`;
        currentElement.appendChild(div);
        currentElement = div;
      }

      // With default maxAttempts (10), the selector should be limited
      const defaultSelector = listener.generateSelector(currentElement);
      const defaultParts = defaultSelector.split(" > ");
      expect(defaultParts.length).toBeLessThanOrEqual(10);

      // With custom maxAttempts (5), the selector should be even more limited
      const customSelector = listener.generateSelector(currentElement, {
        maxAttempts: 5,
      });
      const customParts = customSelector.split(" > ");
      expect(customParts.length).toBeLessThanOrEqual(5);
    });

    it("should respect the priorityAttributes option", () => {
      const div = document.createElement("div");
      div.setAttribute("data-testid", "custom-test-id");
      div.setAttribute("title", "Test Title");
      container.appendChild(div);

      // With custom priorityAttributes, data-testid should be included
      const selector = listener.generateSelector(div, {
        priorityAttributes: ["data-testid", "title"],
      });

      expect(selector).toContain('[data-testid="custom-test-id"]');
    });

    it("should handle special characters in attribute values", () => {
      const div = document.createElement("div");
      div.setAttribute("title", 'Test "with" quotes');
      container.appendChild(div);

      const selector = listener.generateSelector(div);

      // The quotes should be escaped in the selector
      expect(selector).toContain('[title="Test \\"with\\" quotes"]');
    });

    // An attribute value or a class with characters CSS reads as syntax must be
    // escaped, or the clicked element's part of the selector is invalid (and
    // dropped) or matches nothing, and the selector names another element or
    // none: utility classes like `md:flex` used to give just "*". These check the
    // element's own part (the last one) as text: happy-dom's selector engine
    // doesn't implement every CSS escape, so it can't confirm the match itself.
    describe("escapes what CSS would otherwise read as syntax", () => {
      const ownPart = (target: Element) =>
        listener.generateSelector(target).split(" > ").pop();

      it("backslashes in attribute values", () => {
        const other = document.createElement("button");
        other.setAttribute("title", "other");
        const button = document.createElement("button");
        button.setAttribute("title", "C:\\temp\\file");
        container.append(other, button);

        expect(ownPart(button)).toBe('button[title="C:\\\\temp\\\\file"]');
      });

      it("line breaks in attribute values", () => {
        const other = document.createElement("button");
        other.setAttribute("aria-label", "other");
        const button = document.createElement("button");
        button.setAttribute("aria-label", "Close\ndialog");
        container.append(other, button);

        expect(ownPart(button)).toBe('button[aria-label="Close\\a dialog"]');
      });

      it("classes that aren't plain identifiers, as utility-class frameworks write them", () => {
        const other = document.createElement("button");
        other.className = "plain";
        const button = document.createElement("button");
        button.className = "md:flex w-1/2 2xl:hidden";
        container.append(other, button);

        expect(ownPart(button)).toBe("button.md\\:flex.w-1\\/2.\\32 xl\\:hidden");
      });

      it("leaves ordinary values and classes as they were", () => {
        const button = document.createElement("button");
        button.className = "btn btn-primary_lg";
        button.setAttribute("aria-label", "Save changes");
        container.append(button);

        const selector = listener.generateSelector(button);
        expect(selector).toBe('button.btn.btn-primary_lg[aria-label="Save changes"]');
        expect(document.querySelector(selector)).toBe(button);
      });
    });

    it("should generate a selector that identifies the target element", () => {
      // Create multiple similar elements
      for (let i = 0; i < 3; i++) {
        const div = document.createElement("div");
        div.className = "duplicate";
        container.appendChild(div);
      }

      // Add a unique attribute to the middle one
      const elements = container.querySelectorAll(".duplicate");
      const targetElement = elements[1] as HTMLElement;
      targetElement.setAttribute("data-test", "unique");

      const selector = listener.generateSelector(targetElement);

      // The selector should at least match the target element
      const matches = document.querySelectorAll(selector);
      expect(matches.length).toBeGreaterThan(0);

      // One of the matches should be our target element
      let foundTarget = false;
      matches.forEach((match) => {
        if (match === targetElement) foundTarget = true;
      });
      expect(foundTarget).toBe(true);
    });

    it("should handle errors gracefully", () => {
      const div = document.createElement("div");

      // Create a situation that might cause errors
      Object.defineProperty(div, "classList", {
        get: () => {
          throw new Error("classList error");
        },
      });

      container.appendChild(div);

      // Should not throw an error, but fall back to a simple selector
      const selector = listener.generateSelector(div);
      // A tag-based fallback (e.g. "div > div") is enough here.
      expect(selector).toContain("div");

      // Verify the selector works
      expect(() => document.querySelector(selector)).not.toThrow();
    });
  });

  describe("getShouldMaskText", () => {
    let configManager: ConfigManager;
    let mockConfig: SDKConfigInput;

    beforeEach(() => {
      // Base mock config
      mockConfig = {
        dsn: 'https://test.com',
        appId: 'test-app',
        cluster: 'test-cluster',
        environment: 'test',
        apiKey: 'test-key',
        options: {
          privacy: { level: 'mask-all', maskSelectors: [] }
        }
      };
    });

    describe("when privacy level is mask-all", () => {
      beforeEach(() => {
        configManager = createConfigManager();
        configManager.initialize({
          ...mockConfig,
          options: { ...mockConfig.options, privacy: { level: 'mask-all' } }
        });
        // Create listener AFTER config is set up
        listener = createListener(configManager);
      });

      it("should mask password input fields", () => {
        const passwordInput = document.createElement("input");
        passwordInput.type = "password";
        container.appendChild(passwordInput);



        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: passwordInput });
        expect(result).toBe(true);
      });

      it("should mask fields with 'password' in the id (case insensitive)", () => {
        const testCases = [
          "password",
          "Password",
          "PASSWORD", 
          "user-password",
          "passwordField",
          "confirm-password"
        ];

        testCases.forEach(id => {
          const input = document.createElement("input");
          input.id = id;
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });

      it("should mask fields with 'credit-card' in the id (case insensitive)", () => {
        const testCases = [
          "credit-card",
          "Credit-Card",
          "CREDIT-CARD",
          "user-credit-card",
          "credit-card-number"
        ];

        testCases.forEach(id => {
          const input = document.createElement("input");
          input.id = id;
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });

      it("should mask fields with 'cc' in the id (case insensitive)", () => {
        const testCases = [
          "cc",
          "CC",
          "cc-number",
          "user-cc",
          "ccv-field"
        ];

        testCases.forEach(id => {
          const input = document.createElement("input");
          input.id = id;
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });

      it("should mask fields with 'cc' in the className (case insensitive)", () => {
        const testCases = [
          "cc",
          "CC",
          "cc-input",
          "form-cc-field",
          "payment-cc"
        ];

        testCases.forEach(className => {
          const input = document.createElement("input");
          input.className = className;
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });

      it("should mask fields with 'credit-card' in the className (case insensitive)", () => {
        const testCases = [
          "credit-card",
          "Credit-Card", 
          "CREDIT-CARD",
          "payment-credit-card-field",
          "credit-card-input"
        ];

        testCases.forEach(className => {
          const input = document.createElement("input");
          input.className = className;
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });

      it("should mask fields with data-private attribute", () => {
        const input = document.createElement("input");
        input.setAttribute("data-private", "true");
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("should mask fields with data-private attribute regardless of value", () => {
        const testValues = ["true", "false", "", "any-value"];

        testValues.forEach(value => {
          const input = document.createElement("input");
          input.setAttribute("data-private", value);
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });

      it("should mask fields matching custom maskSelectors", () => {
        configManager.updateConfig({
          options: {
            privacy: { maskSelectors: ["[id*='ssn']", "[id*='social']", "[id*='tax-id']"] } as PrivacyOptions
          }
        });

        const testCases = [
          "user-ssn",
          "social-security", 
          "tax-id-field",
          "ssn-input",
          "social-field"
        ];

        testCases.forEach(id => {
          const input = document.createElement("input");
          input.id = id;
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });

      it("masks regular fields too under mask-all", () => {
        const input = document.createElement("input");
        input.id = "username";
        input.className = "form-input";
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("masks non-input elements under mask-all", () => {
        const div = document.createElement("div");
        div.id = "static-label";
        container.appendChild(div);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: div });
        expect(result).toBe(true);
      });

      it("should handle multiple matching conditions", () => {
        const input = document.createElement("input");
        input.type = "password";
        input.id = "user-password";
        input.className = "password-field";
        input.setAttribute("data-private", "true");
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("should handle fields with multiple classes", () => {
        const input = document.createElement("input");
        input.className = "form-input cc-field validation-enabled";
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });
    });

    describe("when privacy level is allow", () => {
      beforeEach(() => {
        configManager = createConfigManager();
        configManager.initialize({
          ...mockConfig,
          options: { ...mockConfig.options, privacy: { level: 'allow' } }
        });
        // Create listener AFTER config is set up
        listener = createListener(configManager);
      });

      it("should not mask password fields when level is allow", () => {
        const passwordInput = document.createElement("input");
        passwordInput.type = "password";
        container.appendChild(passwordInput);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: passwordInput });
        expect(result).toBe(false);
      });

      it("should not mask fields with sensitive ids when level is allow", () => {
        const input = document.createElement("input");
        input.id = "credit-card-number";
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(false);
      });

      it("should not mask fields with data-private attribute when level is allow", () => {
        const input = document.createElement("input");
        input.setAttribute("data-private", "true");
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(false);
      });

      it("should not mask custom maskSelectors when level is allow", () => {
        configManager.updateConfig({
          options: {
            privacy: { maskSelectors: ["[id*='ssn']", "[id*='social']"] } as PrivacyOptions
          }
        });

        const input = document.createElement("input");
        input.id = "user-ssn";
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(false);
      });
    });

    describe("when no privacy/masking config is set (default mask-sensitive)", () => {
      beforeEach(() => {
        configManager = createConfigManager();
        configManager.initialize({
          ...mockConfig,
          options: {} // no privacy set → defaults to mask-sensitive
        });
        // Create listener AFTER config is set up
        listener = createListener(configManager);
      });

      it("masks input fields by default (masking is ON by default)", () => {
        const passwordInput = document.createElement("input");
        passwordInput.type = "password";
        container.appendChild(passwordInput);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: passwordInput });
        expect(result).toBe(true);
      });

      it("does NOT mask a non-sensitive input under mask-sensitive", () => {
        const input = document.createElement("input");
        input.id = "search";
        input.type = "text";
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(false);
      });

      it("masks a sensitive-by-name input under mask-sensitive", () => {
        const input = document.createElement("input");
        input.setAttribute("name", "api_key");
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("masks a data-private input under mask-sensitive", () => {
        const input = document.createElement("input");
        input.type = "text";
        input.setAttribute("data-private", "true");
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("does NOT mask non-input, non-sensitive elements under mask-sensitive", () => {
        const div = document.createElement("div");
        div.id = "static-label";
        container.appendChild(div);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: div });
        expect(result).toBe(false);
      });

      it("masks a sensitive non-input element (e.g. div with data-private)", () => {
        const div = document.createElement("div");
        div.setAttribute("data-private", "true");
        container.appendChild(div);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: div });
        expect(result).toBe(true);
      });
    });

    describe("edge cases and error handling", () => {
      beforeEach(() => {
        configManager = createConfigManager();
        configManager.initialize({
          ...mockConfig,
          options: { ...mockConfig.options, privacy: { level: 'mask-all' } }
        });
        // Create listener AFTER config is set up
        listener = createListener(configManager);
      });

      it("should handle null target gracefully", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: null });
        expect(result).toBe(false);
      });

      it("should handle undefined target gracefully", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: undefined });
        expect(result).toBe(false);
      });

      it("should handle target without id (masked under mask-all)", () => {
        const input = document.createElement("input");
        // No id set
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("should handle target without className (masked under mask-all)", () => {
        const input = document.createElement("input");
        input.id = "normal-field";
        // No className set
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("should handle empty maskSelectors array (masked under mask-all)", () => {
        configManager.updateConfig({
          options: {
            privacy: { maskSelectors: [] } as PrivacyOptions
          }
        });

        const input = document.createElement("input");
        input.id = "some-field";
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("should handle undefined maskSelectors (masked under mask-all)", () => {
        // Initialize without maskSelectors
        configManager = createConfigManager();
        configManager.initialize({
          dsn: 'https://test.com',
          appId: 'test-app',
          cluster: 'test-cluster',
          environment: 'test',
          apiKey: 'test-key',
          options: {
            privacy: { level: 'mask-all' }
            // maskSelectors not provided
          }
        });
        // The listener reads the injected config, so rebuild it with the
        // freshly-initialized manager.
        listener = createListener(configManager);

        const input = document.createElement("input");
        input.id = "some-field";
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("masks by default when config is missing (fail-safe)", () => {
        // Create a new listener whose ConfigManager was never initialized.
        const testListener = createListener(createConfigManager());

        const input = document.createElement("input");
        input.type = "password";
        container.appendChild(input);

        // Should not throw and should mask by default (no config → mask-sensitive).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (testListener as any).getShouldMaskText({ target: input })).not.toThrow();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (testListener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true);
      });

      it("should handle case sensitivity correctly", () => {
        const input = document.createElement("input");
        input.id = "PASSWORD-FIELD"; // uppercase
        container.appendChild(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (listener as any).getShouldMaskText({ target: input });
        expect(result).toBe(true); // Should still match due to toLowerCase()
      });

      it("should handle special characters in field names", () => {
        configManager.updateConfig({
          options: {
            privacy: {
              maskSelectors: [
                "[id*='field-with-dashes']",
                "[id*='field_with_underscores']",
                "[id*='field.with.dots']"
              ]
            } as PrivacyOptions
          }
        });

        const testCases = [
          "user-field-with-dashes",
          "form-field_with_underscores", 
          "input-field.with.dots"
        ];

        testCases.forEach(id => {
          const input = document.createElement("input");
          input.id = id;
          container.appendChild(input);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (listener as any).getShouldMaskText({ target: input });
          expect(result).toBe(true);
        });
      });
    });
  });

  // HTMLFormElement has [LegacyOverrideBuiltIns], so a child input named
  // "id"/"tagName"/"className" shadows the inherited getter and makes target.id
  // return an HTMLInputElement instead of a string. Walking that element through
  // its React fiber fields during serialization can hang the page on submit.
  describe("buildEvent target accessors", () => {
    beforeEach(() => {
      listener = createListener();
    });

    function buildTargetAttributes(target: Element) {
      const enriched = listener.buildEvent({
        type: "submit",
        target,
      } as unknown as Event);
      return enriched.attributes as Record<string, unknown>;
    }

    it("reads id/tagName/className as strings on a bare form", () => {
      const form = document.createElement("form");
      form.id = "plain-form";
      form.className = "plain-class";
      container.appendChild(form);

      const attrs = buildTargetAttributes(form);

      expect(attrs["dom_event_target.id"]).toBe("plain-form");
      expect(attrs["dom_event_target.tagName"]).toBe("FORM");
      expect(attrs["dom_event_target.className"]).toBe("plain-class");
    });

    it("reads id as a string even when a child input named 'id' shadows form.id", () => {
      const form = document.createElement("form");
      form.id = "real-form-id";
      const shadower = document.createElement("input");
      shadower.name = "id";
      shadower.value = "42";
      form.appendChild(shadower);
      container.appendChild(form);

      const attrs = buildTargetAttributes(form);

      // The resolved id must be the form's attribute string, never the child
      // element. Use a type check to guard against future regressions that
      // might leak an element through a different path.
      expect(typeof attrs["dom_event_target.id"]).toBe("string");
      expect(attrs["dom_event_target.id"]).toBe("real-form-id");
    });

    // happy-dom's HTMLFormElement may not fully implement
    // [LegacyOverrideBuiltIns], so the child-input test above might not
    // reproduce the shadow in every happy-dom version. This second test
    // force-shadows the property to guarantee the safe-accessor path is
    // exercised regardless of happy-dom's behavior.
    it("falls back to getAttribute when target.id is not a string", () => {
      const form = document.createElement("form");
      form.setAttribute("id", "attr-form-id");
      form.setAttribute("class", "attr-class");
      const shadower = document.createElement("input");
      form.appendChild(shadower);

      // Forcibly shadow the prototype getters to simulate real browsers.
      Object.defineProperty(form, "id", {
        configurable: true,
        get: () => shadower,
      });
      Object.defineProperty(form, "className", {
        configurable: true,
        get: () => shadower,
      });

      container.appendChild(form);

      const attrs = buildTargetAttributes(form);

      expect(typeof attrs["dom_event_target.id"]).toBe("string");
      expect(attrs["dom_event_target.id"]).toBe("attr-form-id");
      expect(typeof attrs["dom_event_target.className"]).toBe("string");
      expect(attrs["dom_event_target.className"]).toBe("attr-class");
      // tagName uses the Element.prototype getter directly, so it bypasses the
      // shadow without needing getAttribute.
      expect(attrs["dom_event_target.tagName"]).toBe("FORM");
    });

    // With <input name="tagName"> shadowing the property on a form, a direct
    // currentElement.tagName read in generateSelector's traversal loop would
    // return the child input element, and the .toLowerCase() after it would
    // throw TypeError. The exception would bubble up through
    // getSelector/buildEvent into handleEvent's catch, silently dropping the
    // event. buildEvent must not throw in this case.
    it("generateSelector handles forms whose tagName is shadowed by a named input", () => {
      const form = document.createElement("form");
      form.setAttribute("id", "form-with-shadowed-tagname");
      const shadower = document.createElement("input");
      form.appendChild(shadower);

      // Force-shadow form.tagName to return the input element, mimicking
      // HTMLFormElement's [LegacyOverrideBuiltIns] named-property lookup.
      Object.defineProperty(form, "tagName", {
        configurable: true,
        get: () => shadower,
      });

      container.appendChild(form);

      // Must not throw and must produce a usable selector string.
      let attrs: Record<string, unknown> | undefined;
      expect(() => {
        attrs = buildTargetAttributes(form);
      }).not.toThrow();

      expect(typeof attrs!["dom_event_selector"]).toBe("string");
      expect((attrs!["dom_event_selector"] as string).length).toBeGreaterThan(0);
    });
  });

  describe("buildEvent — mask decision computed once per event", () => {
    beforeEach(() => {
      listener = createListener();
    });

    it("computes the mask decision once per DOM event (not once per attribute)", () => {
      const input = document.createElement("input");
      input.type = "text";
      container.appendChild(input);

      // A real KeyboardEvent so getKeyCode's masking branch runs (it gates on
      // `instanceof KeyboardEvent`); target is set since it isn't dispatched.
      const keyEvent = new KeyboardEvent("keydown", { key: "a", code: "KeyA" });
      Object.defineProperty(keyEvent, "target", {
        value: input,
        configurable: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spy = vi.spyOn(listener as any, "getShouldMaskText").mockReturnValue(false);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (listener as any).buildEvent(keyEvent);

      // getKeyCode and getText must share one decision, not each recompute it.
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("buildEvent — accessibility + actionable ancestor + masking", () => {
    function initConfig(level: "mask-sensitive" | "mask-all" | "allow", maskSelectors: string[] = []) {
      const cfg = createConfigManager();
      cfg.initialize({
        dsn: "https://test.com",
        appId: "test-app",
        cluster: "test-cluster",
        environment: "test",
        apiKey: "test-key",
        options: { privacy: { level, maskSelectors } },
      } as SDKConfigInput);
      listener = createListener(cfg);
    }

    function build(target: Element) {
      const enriched = listener.buildEvent({
        type: "click",
        target,
      } as unknown as Event);
      return enriched.attributes as Record<string, unknown>;
    }

    it("resolves an inner span up to its button and captures accessibility", () => {
      initConfig("mask-sensitive");
      const button = document.createElement("button");
      button.setAttribute("aria-label", "Close");
      const span = document.createElement("span");
      span.textContent = "x";
      button.appendChild(span);
      container.appendChild(button);

      const attrs = build(span);

      expect(attrs["dom_event_target.tagName"]).toBe("BUTTON");
      expect(attrs["dom_event_target.role"]).toBe("button");
      expect(attrs["dom_event_target.accessibleName"]).toBe("Close");
      expect(attrs["dom_event_target.ariaLabel"]).toBe("Close");
    });

    it("captures link role and href", () => {
      initConfig("allow");
      const a = document.createElement("a");
      a.setAttribute("href", "/dashboards");
      a.textContent = "Dashboards";
      container.appendChild(a);

      const attrs = build(a);

      expect(attrs["dom_event_target.role"]).toBe("link");
      expect(attrs["dom_event_target.href"]).toBe("/dashboards");
      expect(attrs["dom_event_target.text"]).toBe("Dashboards");
    });

    it("drops the whole-page blob on a container click", () => {
      initConfig("allow");
      const root = document.createElement("div");
      root.id = "root";
      root.textContent = "nav ".repeat(1000);
      container.appendChild(root);

      const attrs = build(root);

      // No interactive ancestor → describes #root, but text is dropped.
      expect(attrs["dom_event_target.text"]).toBe("");
      expect(attrs["dom_event_target.tagName"]).toBe("DIV");
      expect(attrs["dom_event_selector"]).toBe("#root");
    });

    it("emits no content for a BODY target (unfocused keydown)", () => {
      initConfig("allow");

      // A keydown with nothing focused bubbles to <body>; its accessible name /
      // text would otherwise be the whole page. The event still emits (tagName).
      const attrs = build(document.body);

      expect(attrs["dom_event_target.tagName"]).toBe("BODY");
      expect(attrs["dom_event_target.accessibleName"]).toBe("");
      expect(attrs["dom_event_target.text"]).toBe("");
    });

    it("drops the concatenated label of an item container (listbox)", () => {
      initConfig("allow");
      const listbox = document.createElement("div");
      listbox.setAttribute("role", "listbox");
      for (const label of ["Filter by level", "Filter by status", "Search"]) {
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.textContent = label;
        listbox.appendChild(opt);
      }
      container.appendChild(listbox);

      const attrs = build(listbox);

      // Container of options → text/accessibleName dropped; role still emitted.
      expect(attrs["dom_event_target.role"]).toBe("listbox");
      expect(attrs["dom_event_target.text"]).toBe("");
      expect(attrs["dom_event_target.accessibleName"]).toBe("");
    });

    it("masks when a data-private descendant of the raw target is clicked", () => {
      initConfig("mask-sensitive");
      const a = document.createElement("a");
      a.setAttribute("href", "/pay");
      const secret = document.createElement("span");
      secret.setAttribute("data-private", "");
      secret.textContent = "TOP-SECRET-VALUE";
      a.appendChild(secret);
      container.appendChild(a);

      // Click lands on the data-private span; effective element resolves up to <a>.
      const attrs = build(secret);

      expect(attrs["dom_event_target.text"]).toBe("*");
      expect(attrs["dom_event_target.accessibleName"]).toBe("*");
      expect(attrs["dom_event_target.href"]).toBe("*");
    });

    it("masks via a configured maskSelector below the interactive ancestor", () => {
      initConfig("mask-sensitive", ["[data-secret]"]);
      const button = document.createElement("button");
      const inner = document.createElement("span");
      inner.setAttribute("data-secret", "");
      inner.textContent = "hidden";
      button.appendChild(inner);
      container.appendChild(button);

      const attrs = build(inner);

      expect(attrs["dom_event_target.text"]).toBe("*");
    });

    it("masks a masked sibling aggregated into the ancestor text", () => {
      initConfig("mask-sensitive");
      const button = document.createElement("button");
      const secret = document.createElement("span");
      secret.setAttribute("data-private", "");
      secret.textContent = "secret";
      const label = document.createElement("span");
      label.textContent = "Buy";
      button.append(secret, label);
      container.appendChild(button);

      // Click the non-sensitive "Buy" span; the button's textContent still
      // aggregates the masked sibling, so the label must be masked.
      const attrs = build(label);

      expect(attrs["dom_event_target.text"]).toBe("*");
    });

    it("keeps an icon button's label (drop is text-length, not element-count)", () => {
      initConfig("mask-sensitive");
      const button = document.createElement("button");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (let i = 0; i < 30; i++) {
        svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path"));
      }
      button.appendChild(svg);
      button.appendChild(document.createTextNode("Save"));
      container.appendChild(button);

      const attrs = build(button);

      expect(attrs["dom_event_target.accessibleName"]).toBe("Save");
      expect(attrs["dom_event_target.text"]).toBe("Save");
    });

    it("under mask-all, text-like fields are masked but structural fields remain", () => {
      initConfig("mask-all");
      const a = document.createElement("a");
      a.setAttribute("href", "/x");
      a.setAttribute("name", "nav-link");
      a.textContent = "Go";
      container.appendChild(a);

      const attrs = build(a);

      // Text-like → "*"
      expect(attrs["dom_event_target.text"]).toBe("*");
      expect(attrs["dom_event_target.href"]).toBe("*");
      // Structural → intact
      expect(attrs["dom_event_target.tagName"]).toBe("A");
      expect(attrs["dom_event_target.role"]).toBe("link");
      expect(attrs["dom_event_target.name"]).toBe("nav-link");
      // Absent field stays "" (not "*")
      expect(attrs["dom_event_target.title"]).toBe("");
    });

    it("does not leak masked attribute values through dom_event_selector", () => {
      initConfig("mask-all");
      const button = document.createElement("button");
      button.setAttribute("class", "danger");
      button.setAttribute("aria-label", "Delete secret account");
      button.setAttribute("title", "tooltip secret value");
      container.appendChild(button);

      const attrs = build(button);
      const selector = attrs["dom_event_selector"] as string;

      // The a11y fields are masked; the selector must not carry the same values.
      expect(attrs["dom_event_target.accessibleName"]).toBe("*");
      expect(selector).not.toContain("Delete secret account");
      expect(selector).not.toContain("tooltip secret value");
      // Structural part still present.
      expect(selector).toContain("button");
    });

    it("redacts sensitive query params from href (even when the element is not masked)", () => {
      initConfig("mask-sensitive");
      const a = document.createElement("a");
      a.setAttribute("href", "/reset?token=abc123&page=2");
      a.textContent = "Reset";
      container.appendChild(a);

      const attrs = build(a);

      const href = attrs["dom_event_target.href"] as string;
      expect(href).not.toContain("abc123");
      expect(href).toContain("page=2"); // benign param preserved
    });

    it("masks when aria-labelledby points to a data-private element elsewhere", () => {
      initConfig("mask-sensitive");
      // Benign, non-sensitive button — but its accessible name is pulled from a
      // private element outside its subtree via aria-labelledby.
      const secretLabel = document.createElement("div");
      secretLabel.id = "secret-label";
      secretLabel.setAttribute("data-private", "");
      secretLabel.textContent = "PRIVATE-NAME";
      const button = document.createElement("button");
      button.setAttribute("aria-labelledby", "secret-label");
      container.append(secretLabel, button);

      const attrs = build(button);

      expect(attrs["dom_event_target.accessibleName"]).toBe("*");
      expect(JSON.stringify(attrs)).not.toContain("PRIVATE-NAME");
    });

    it("masks text as '*' for a sensitive input even though it has no textContent", () => {
      // An <input> has empty textContent, so getOwnTextLabel is "".
      // The privacy contract requires a masked field's text to be "*" regardless
      // (its value is never in textContent, so "" would silently drop the signal).
      initConfig("mask-sensitive");
      const input = document.createElement("input");
      input.id = "credit-card";
      input.type = "text";
      container.appendChild(input);

      const attrs = build(input);

      expect(attrs["dom_event_target.text"]).toBe("*");
    });

    it("does not resolve or throw for a form target with shadowing named inputs", () => {
      initConfig("mask-sensitive");
      const form = document.createElement("form");
      form.setAttribute("id", "shadow-form");
      ["role", "title", "href", "name"].forEach((n) => {
        const input = document.createElement("input");
        input.name = n;
        form.appendChild(input);
      });
      container.appendChild(form);

      let attrs: Record<string, unknown> | undefined;
      expect(() => {
        attrs = build(form);
      }).not.toThrow();
      // All a11y fields must be strings sourced from the form's own attributes.
      expect(typeof attrs!["dom_event_target.role"]).toBe("string");
      expect(typeof attrs!["dom_event_target.name"]).toBe("string");
      expect(typeof attrs!["dom_event_target.href"]).toBe("string");
    });
  });
});
