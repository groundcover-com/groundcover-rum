// Automatic text-input capture. Taps bubble through the responder tree, but TextInput
// focus/change/blur do not — so instead of a boundary, the SDK decorates the props of
// every `<TextInput/>` React creates, by patching the ELEMENT FACTORIES and forwarding
// the type verbatim. Swapping the `TextInput` export for a wrapper is what must NOT be
// done: React identifies a mounted component by element TYPE, so a swap landing after
// mount remounts the field and takes the native EditText (and the keystrokes after it)
// with it.
//
// Version-fragile, like fiber-walk: every access is guarded, the patch is idempotent
// and fully restorable, and any failure degrades to "no typing capture". Semantics: ONE
// "input" per edit, on end-of-edit, only if the field changed. The VALUE is never read.

// Default imports on purpose: these are CommonJS without `__esModule`, so the default
// import is the live `module.exports` the app's compiled JSX reads off at call time. A
// namespace import hands back an interop COPY, so patching it instruments nothing.
// (Both runtimes are in tsup's `external` for the same reason.)
import React from "react";
import JsxRuntime from "react/jsx-runtime";
import JsxDevRuntime from "react/jsx-dev-runtime";
// The component itself, used ONLY as an identity to compare element types
// against. Never mutated, never replaced.
import { TextInput } from "react-native";
import { handleError } from "@groundcover/rum-core";

import { resolveFiber } from "./fiber-walk";
import type { RawInput } from "../internal/touch-bridge";
import { safeWarn } from "../internal/safe-warn";

type Handler = ((event: unknown) => void) | undefined;

/**
 * `React.createElement` and the three JSX-runtime entry points share a shape:
 * the type first, the props second, everything after untouched (`key`, and in
 * development the source/self debug arguments). We only ever rewrite the second.
 */
type ElementFactory = (type: unknown, config: unknown, ...rest: unknown[]) => unknown;

// Marker holding the original factory on the patched one, so a double install is
// a no-op and uninstall can restore exactly what was there.
const MARKER = Symbol.for("groundcover.textInput.originalFactory");

// Fields edited since focus, keyed by fiber so state survives the controlled-input
// re-render. The VALUE is the install generation, not `true`: this module state
// outlives an install, so with a plain flag a field left mid-edit across destroy()/init()
// would emit an `input` for the old edit stamped with the new session. A WeakSet cannot be
// cleared, so the generation is what makes stale marks unreachable.
const dirty = new WeakMap<object, number>();
let generation = 0;
// Fallback when a change event's fiber can't be resolved: a field was edited,
// we just can't key it. One boolean is enough since fields are edited serially.
let dirtyNoFiber = false;

let onInput: ((input: RawInput) => void) | null = null;
let warnedNoFactory = false;

/**
 * Element factories that could not be assigned over — a frozen module object, a
 * non-writable property. Held weakly and keyed on the factory itself, so a
 * genuinely new one (a remounted runtime after fast refresh) is a different
 * function and gets a fresh attempt; only the identity that already failed is
 * skipped.
 */
const unpatchable = new WeakSet<object>();

type PatchedFactory = {
  holder: Record<string, unknown>;
  key: string;
  original: ElementFactory;
  replacement: ElementFactory;
};

let patched: PatchedFactory[] = [];

function markDirty(event: unknown): void {
  const fiber = resolveFiber(event);
  if (fiber && typeof fiber === "object") dirty.set(fiber, generation);
  else dirtyNoFiber = true;
}

// Clear the dirty flag first, so the several end-of-edit events a field can fire
// collapse into one interaction. Keying on fiber identity survives the per-keystroke
// re-render: React caches the instance handle at mount and does not re-cache on
// update, so every shape resolveFiber probes returns the same object for the edit.
function emitIfDirty(event: unknown): void {
  const fiber = resolveFiber(event);
  if (fiber && typeof fiber === "object" && dirty.get(fiber) === generation) {
    dirty.delete(fiber);
    onInput?.({ fiber });
    return;
  }
  if (dirtyNoFiber) {
    dirtyNoFiber = false;
    onInput?.({ fiber });
  }
}

/**
 * Wrap a host handler so ours runs first (guarded) and the app's still runs, returning
 * the SAME wrapper for a given host handler. The identity cache is load-bearing: props
 * are rewritten on every element creation, so fresh closures would hand each field
 * four new function props per render and defeat any `React.memo` bailout. Keyed weakly,
 * so an unmounted field's closures stay collectable.
 */
function chainer(ours: (event: unknown) => void): (existing: Handler) => (event: unknown) => void {
  const cache = new WeakMap<object, (event: unknown) => void>();
  let standalone: ((event: unknown) => void) | undefined;

  const guarded = (event: unknown) => {
    try {
      ours(event);
    } catch (error) {
      // The report is guarded too. `handleError` is the SDK's own reporter, but
      // it ends in a sink the host controls, and a throwing sink here would
      // escape `guarded` — so the wrapper below would never reach `existing`,
      // and the app's own onChange/onEndEditing would stop running. Our failure
      // to report a failure must not cost the host its input handling.
      try {
        handleError(error);
      } catch {
        // Nothing left to report to.
      }
    }
  };

  return (existing: Handler) => {
    // No handler of the app's to chain — one shared wrapper serves every field.
    if (typeof existing !== "function") return (standalone ??= guarded);
    const hit = cache.get(existing);
    if (hit) return hit;
    const wrapper = (event: unknown) => {
      guarded(event);
      existing(event);
    };
    cache.set(existing, wrapper);
    return wrapper;
  };
}

const chainChange = chainer(markDirty);
const chainEndEditing = chainer(emitIfDirty);
const chainBlur = chainer(emitIfDirty);
const chainSubmit = chainer(emitIfDirty);

/** The instrumented copy of a field's props. */
function instrumentProps(props: Record<string, unknown>): Record<string, unknown> {
  try {
    return {
      ...props,
      // onChange carries the event (target) — onChangeText does not — so we
      // track dirtiness from onChange without ever reading the text.
      onChange: chainChange(props.onChange as Handler),
      onEndEditing: chainEndEditing(props.onEndEditing as Handler),
      onBlur: chainBlur(props.onBlur as Handler),
      onSubmitEditing: chainSubmit(props.onSubmitEditing as Handler),
    };
  } catch (error) {
    handleError(error);
    return props; // never let instrumentation break the field's render
  }
}

/**
 * Patch every element factory a `TextInput` might be created through — all four, since the entry
 * point comes from each MODULE's Babel config and the runtimes coexist in one bundle.
 *
 * ALLOCATION MATTERS: this runs for every element the app creates, and a `...rest` signature
 * allocates per call, which can trigger Hermes' GWP-ASan crash (facebook/hermes#1873). Only
 * variadic `createElement` keeps a rest parameter.
 */
function patchElementFactories(): boolean {
  // `jsx`/`jsxs` take (type, config, maybeKey); `jsxDEV` adds
  // (isStaticChildren, source, self). Forwarding them explicitly keeps `key` and
  // React's dev-only source annotations intact without touching `arguments`.
  const wrapJsx =
    (factory: ElementFactory) =>
    (
      type: unknown,
      config: unknown,
      maybeKey?: unknown,
      isStaticChildren?: unknown,
      source?: unknown,
      self?: unknown
    ) =>
      factory(
        type,
        type === TextInput && config && typeof config === "object"
          ? instrumentProps(config as Record<string, unknown>)
          : config,
        maybeKey,
        isStaticChildren,
        source,
        self
      );

  const wrapVariadic =
    (factory: ElementFactory) =>
    (type: unknown, config: unknown, ...children: unknown[]) =>
      factory(
        type,
        type === TextInput && config && typeof config === "object"
          ? instrumentProps(config as Record<string, unknown>)
          : config,
        ...children
      );

  const targets: Array<[unknown, string, (factory: ElementFactory) => ElementFactory]> = [
    [React, "createElement", wrapVariadic as (f: ElementFactory) => ElementFactory],
    [JsxRuntime, "jsx", wrapJsx as (f: ElementFactory) => ElementFactory],
    [JsxRuntime, "jsxs", wrapJsx as (f: ElementFactory) => ElementFactory],
    [JsxDevRuntime, "jsxDEV", wrapJsx as (f: ElementFactory) => ElementFactory],
  ];

  let instrumented = false;
  for (const [holder, key, wrap] of targets) {
    if (!holder || typeof holder !== "object") continue;
    const target = holder as Record<string, unknown>;
    const original = target[key];
    if (typeof original !== "function") continue;

    // Idempotent across a double install and across fast refresh.
    if ((original as unknown as Record<symbol, unknown>)[MARKER]) {
      instrumented = true;
      continue;
    }

    // Already proved unassignable — see the catch below.
    if (unpatchable.has(original as object)) continue;

    const factory = original as ElementFactory;
    const replacement = wrap(factory);
    (replacement as unknown as Record<symbol, unknown>)[MARKER] = factory;

    try {
      target[key] = replacement;
    } catch (error) {
      // Remember the factory we could not take, so a reinstall does not rebuild
      // a replacement and re-report the same failure. A frozen module object
      // stays frozen, and `instrument()` can run on every fast refresh — so
      // without this the failure work is unbounded and grows with the session.
      // Keyed on the factory identity, not the holder: a genuinely new factory
      // (a remounted runtime) is a different function and gets a fresh attempt.
      unpatchable.add(original as object);
      handleError(error);
      continue;
    }
    // A non-writable property assigns SILENTLY outside strict mode, so confirm
    // rather than assume; recording a patch we did not make would make uninstall
    // restore over someone else's function.
    if (target[key] !== replacement) continue;

    patched.push({ holder: target, key, original: factory, replacement });
    instrumented = true;
  }

  return instrumented;
}

/**
 * Patch element creation so finished edits emit an `input` interaction via
 * `handler`. Idempotent; a no-op (with a single warning) if nothing could be
 * patched — typing capture is best-effort and never blocks the rest of the SDK.
 */
export function installTextInputInstrumentation(handler: (input: RawInput) => void): void {
  onInput = handler;
  try {
    if (patchElementFactories()) return;
    if (!warnedNoFactory) {
      warnedNoFactory = true;
      // groundcoverIgnore: keep the SDK's own warning out of console capture. safeWarn so a
      // patched/throwing console can't take the host down from inside our instrumentation.
      safeWarn(
        "[groundcover] no patchable React element factory (createElement / jsx / jsxs / jsxDEV); typing capture disabled (groundcoverIgnore)"
      );
    }
  } catch (error) {
    handleError(error);
  }
}

/** Restore every patched factory and stop capturing edits. */
export function uninstallTextInputInstrumentation(): void {
  onInput = null;
  dirtyNoFiber = false;
  // Every field marked dirty under the old generation is now unreachable, so an
  // edit in progress at teardown cannot be paired with a blur that arrives after
  // the next install. See the note on `dirty`.
  generation += 1;

  const records = patched;
  patched = [];
  for (const record of records) {
    try {
      // Guarded restore: only stand down where we are still the installed
      // factory, so we never clobber a patch someone else layered over ours.
      if (record.holder[record.key] === record.replacement) {
        record.holder[record.key] = record.original;
      }
    } catch (error) {
      handleError(error);
    }
  }
}

export const __internals = { MARKER };
