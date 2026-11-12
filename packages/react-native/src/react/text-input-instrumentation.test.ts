import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Read through the module OBJECTS, never through named imports: that is how
// compiled JSX reaches these functions (`(0, _jsxRuntime.jsx)(...)` — a property
// read at call time), and it is the only form that sees the SDK's patch. A named
// import would capture the pre-patch function and test nothing.
import React from "react";
import JsxRuntime from "react/jsx-runtime";
import JsxDevRuntime from "react/jsx-dev-runtime";

import {
  installTextInputInstrumentation,
  uninstallTextInputInstrumentation,
} from "./text-input-instrumentation";
import type { RawInput } from "../internal/touch-bridge";
// The react-native stub, imported by PATH rather than through the "react-native"
// specifier vitest aliases to it (see vitest.config.ts): both resolve to the same
// module instance at run time, but `tsc` resolves the specifier to the real RN
// types, under which these test-only exports do not exist. The stub models BOTH
// TextInput shapes; `TextInput` is a live binding, so switching the shape is
// visible to the SDK exactly as reading the real component fresh would be.
import { TextInput, __setTextInputShape } from "../test-utils/react-native-stub";

type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
type Factory = (type: unknown, props: Props, ...rest: unknown[]) => unknown;

// A synthetic RN event whose fiber resolves via `_targetInst` (the Paper shape
// resolveFiber probes first). Different `id` → different fiber identity.
function eventFor(fiber: object): { _targetInst: object } {
  return { _targetInst: fiber };
}

// The four entry points a `<TextInput/>` can be created through, read fresh so
// each call goes to whatever is currently installed.
const factories: Array<[name: string, get: () => Factory]> = [
  ["React.createElement", () => React.createElement as unknown as Factory],
  ["jsx", () => (JsxRuntime as unknown as { jsx: Factory }).jsx],
  ["jsxs", () => (JsxRuntime as unknown as { jsxs: Factory }).jsxs],
  ["jsxDEV", () => (JsxDevRuntime as unknown as { jsxDEV: Factory }).jsxDEV],
];

const prodJsx = (): Factory => (JsxRuntime as unknown as { jsx: Factory }).jsx;

/** Create an element through `factory` and return it typed. */
const create = (factory: Factory, type: unknown, props: Props = {}): Element =>
  factory(type, props) as unknown as Element;

/** The props the SDK injected for a field created through the production `jsx`. */
const fieldProps = (props: Props = {}): Props => create(prodJsx(), TextInput, props).props;

describe("text-input-instrumentation", () => {
  beforeEach(() => {
    __setTextInputShape("function");
  });

  afterEach(() => {
    uninstallTextInputInstrumentation();
    vi.restoreAllMocks();
  });

  // The core invariant: the element type is forwarded unchanged.
  //
  // Instrumenting by swapping react-native's `TextInput` export for a wrapper
  // component changes the element TYPE. React identifies a mounted component by
  // its type, so a field that mounted before the SDK finished installing would be
  // UNMOUNTED and remounted on its next render — losing the native EditText's
  // focus mid-edit and swallowing every keystroke after the first.
  // Decorating props while forwarding the type verbatim is what makes a late
  // install an ordinary prop update instead.
  describe("the element type is forwarded verbatim", () => {
    it.each(factories)("%s hands React the same type it was given", (_name, get) => {
      installTextInputInstrumentation(() => {});
      expect(create(get(), TextInput).type).toBe(TextInput);
    });
  });

  describe("what gets instrumented", () => {
    it.each(factories)("%s instruments a text input's handlers", (_name, get) => {
      const inputs: RawInput[] = [];
      const fiber = { id: "field" };
      installTextInputInstrumentation((input) => inputs.push(input));

      const props = create(get(), TextInput).props;
      (props.onChange as (e: unknown) => void)(eventFor(fiber));
      (props.onEndEditing as (e: unknown) => void)(eventFor(fiber));

      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.fiber).toBe(fiber);
    });

    it("leaves every other component's props alone", () => {
      const Other = () => null;
      const onChange = () => {};
      installTextInputInstrumentation(() => {});

      // Identity, not deep equality: React copies the config into `props`, so the
      // object differs by construction — what matters is that the app's handler
      // reaches the component unwrapped.
      const props = create(prodJsx(), Other, { onChange }).props;
      expect(props.onChange).toBe(onChange);
      expect(props.onEndEditing).toBeUndefined();
    });

    // The mechanism is an identity comparison against the component, so it cannot
    // care which shape that component has — a branch on that shape (forwardRef
    // object on older RN, plain function on RN 0.86) would break whenever RN
    // changes it. Asserted through the PRODUCTION `jsx`, which does not validate element
    // types: the stub's legacy shape is a bare object, not a real forwardRef.
    it.each(["forwardRef", "function"] as const)("instruments the %s shape alike", (shape) => {
      __setTextInputShape(shape);
      const inputs: RawInput[] = [];
      // ONE fiber for both events: dirtiness is keyed on the field's identity, so
      // change and blur have to arrive from the same field to pair up.
      const fiber = { id: `field-${shape}` };
      installTextInputInstrumentation((input) => inputs.push(input));

      const props = fieldProps();
      (props.onChange as (e: unknown) => void)(eventFor(fiber));
      (props.onBlur as (e: unknown) => void)(eventFor(fiber));

      expect(inputs).toHaveLength(1);
    });
  });

  describe("one interaction per edit", () => {
    it("does not emit when a field is focused and blurred without any change", () => {
      const inputs: RawInput[] = [];
      installTextInputInstrumentation((input) => inputs.push(input));

      (fieldProps().onBlur as (e: unknown) => void)(eventFor({ id: "untouched" }));

      expect(inputs).toHaveLength(0);
    });

    it("emits at most once across endEditing / blur / submit", () => {
      const inputs: RawInput[] = [];
      const fiber = { id: "field" };
      installTextInputInstrumentation((input) => inputs.push(input));

      const props = fieldProps();
      (props.onChange as (e: unknown) => void)(eventFor(fiber));
      (props.onEndEditing as (e: unknown) => void)(eventFor(fiber));
      (props.onBlur as (e: unknown) => void)(eventFor(fiber));
      (props.onSubmitEditing as (e: unknown) => void)(eventFor(fiber));

      expect(inputs).toHaveLength(1);
    });

    it("still captures the edit when the change event's fiber can't be resolved", () => {
      const inputs: RawInput[] = [];
      installTextInputInstrumentation((input) => inputs.push(input));

      const props = fieldProps();
      (props.onChange as (e: unknown) => void)({});
      (props.onBlur as (e: unknown) => void)({});

      expect(inputs).toHaveLength(1);
    });

    /**
     * An edit spanning a reinstall must not emit against the new session. The fiber-keyed dirty set
     * is module state and outlives `uninstall` — so if only the no-fiber fallback were cleared, a
     * field left mid-edit at `destroy()` would keep its mark, and the blur after the next `init()`
     * would emit an `input` for something the user did before, attributed to the new session.
     */
    it("does not emit an edit that began before the previous uninstall", () => {
      const fiber = { id: "mid-edit" };

      installTextInputInstrumentation(() => {});
      (fieldProps().onChange as (e: unknown) => void)(eventFor(fiber));

      // JS destroy() then init() again, with the field still focused.
      uninstallTextInputInstrumentation();
      const inputs: RawInput[] = [];
      installTextInputInstrumentation((input) => inputs.push(input));

      (fieldProps().onBlur as (e: unknown) => void)(eventFor(fiber));

      expect(inputs).toHaveLength(0);
    });

    /** …and the same field is captured normally once it is edited again. */
    it("captures a fresh edit of that same field after the reinstall", () => {
      const fiber = { id: "mid-edit" };

      installTextInputInstrumentation(() => {});
      (fieldProps().onChange as (e: unknown) => void)(eventFor(fiber));
      uninstallTextInputInstrumentation();

      const inputs: RawInput[] = [];
      installTextInputInstrumentation((input) => inputs.push(input));

      const props = fieldProps();
      (props.onChange as (e: unknown) => void)(eventFor(fiber));
      (props.onBlur as (e: unknown) => void)(eventFor(fiber));

      expect(inputs).toHaveLength(1);
    });
  });

  describe("the host app keeps its own behaviour", () => {
    it("chains the app's handlers rather than replacing them", () => {
      const calls: string[] = [];
      const app: Props = {
        onChange: () => calls.push("change"),
        onBlur: () => calls.push("blur"),
        onEndEditing: () => calls.push("endEditing"),
        onSubmitEditing: () => calls.push("submit"),
      };
      installTextInputInstrumentation(() => {});

      const props = fieldProps(app);
      (props.onChange as (e: unknown) => void)({});
      (props.onBlur as (e: unknown) => void)({});
      (props.onEndEditing as (e: unknown) => void)({});
      (props.onSubmitEditing as (e: unknown) => void)({});

      expect(calls).toEqual(["change", "blur", "endEditing", "submit"]);
    });

    // Props are rewritten on EVERY element creation, so a fresh closure per
    // render would hand the field four new function props every time and defeat
    // any memo / shouldComponentUpdate bailout it relies on.
    it("returns the same wrapper for the same handler across renders", () => {
      const onChange = () => {};
      installTextInputInstrumentation(() => {});

      expect(fieldProps({ onChange }).onChange).toBe(fieldProps({ onChange }).onChange);
      // And fields with no handler of their own share one wrapper too.
      expect(fieldProps().onBlur).toBe(fieldProps().onBlur);
    });

    it("does not let a throw from our side reach the app's handler", () => {
      const app = vi.fn();
      installTextInputInstrumentation(() => {
        throw new Error("reporting blew up");
      });

      const props = fieldProps({ onChange: () => {}, onBlur: app });
      (props.onChange as (e: unknown) => void)({});
      expect(() => (props.onBlur as (e: unknown) => void)({})).not.toThrow();
      expect(app).toHaveBeenCalledTimes(1);
    });
  });

  describe("install / uninstall", () => {
    it("is idempotent — a second install does not double-wrap or warn", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const inputs: RawInput[] = [];
      const fiber = { id: "field" };

      installTextInputInstrumentation((input) => inputs.push(input));
      const afterFirst = prodJsx();
      installTextInputInstrumentation((input) => inputs.push(input));

      expect(prodJsx()).toBe(afterFirst);

      const props = fieldProps();
      (props.onChange as (e: unknown) => void)(eventFor(fiber));
      (props.onEndEditing as (e: unknown) => void)(eventFor(fiber));

      // Once, not twice: a double wrap would report the same edit through two
      // chained layers.
      expect(inputs).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("restores every factory it patched", () => {
      const before = factories.map(([, get]) => get());

      installTextInputInstrumentation(() => {});
      expect(factories.map(([, get]) => get())).not.toEqual(before);

      uninstallTextInputInstrumentation();
      expect(factories.map(([, get]) => get())).toEqual(before);
    });

    it("stops reporting after uninstall", () => {
      const inputs: RawInput[] = [];
      installTextInputInstrumentation((input) => inputs.push(input));
      const props = fieldProps();
      uninstallTextInputInstrumentation();

      // The handlers the field already holds outlive the patch — they must go
      // quiet rather than report into a torn-down pipeline.
      (props.onChange as (e: unknown) => void)({});
      (props.onBlur as (e: unknown) => void)({});

      expect(inputs).toHaveLength(0);
    });
  });
});
