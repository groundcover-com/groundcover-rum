// Controllable stand-in for `react-native` in unit + wire tests (vitest aliases
// "react-native" here). Only the surface the SDK touches is implemented, plus
// test hooks (`__setAppState`, `__emitAppState`, `__reset`) so a test can drive
// AppState transitions without a device.
import * as React from "react";

type AppStateStatus = "active" | "background" | "inactive" | "unknown";
type AppStateListener = (state: AppStateStatus) => void;

const appStateListeners = new Set<AppStateListener>();

export const AppState = {
  currentState: "active" as AppStateStatus,
  addEventListener(type: "change", handler: AppStateListener) {
    if (type === "change") appStateListeners.add(handler);
    return {
      remove() {
        appStateListeners.delete(handler);
      },
    };
  },
};

/**
 * RN's iOS `Platform.constants`, as the platform actually sends them.
 *
 * Deliberately WITHOUT a `model` or a `brand`. A stub that invented them would hide
 * `device.model: "unknown"` on every iOS event from the unit suite: every test would assert
 * against a payload iOS cannot produce. The model comes from the native module instead.
 * Keep this honest — a stub more generous than the platform tests nothing.
 */
function iosConstants(): Record<string, unknown> {
  return {
    systemName: "iOS",
    osVersion: "17.4",
    interfaceIdiom: "phone",
    forceTouchAvailable: false,
    isTesting: true,
    reactNativeVersion: { major: 0, minor: 74, patch: 0 },
  };
}

export const Platform = {
  // The real RN union — not just the two mobile platforms — so a test can drive
  // the "other" path the SDK must map non-mobile hosts to.
  OS: "ios" as "ios" | "android" | "windows" | "macos" | "web",
  Version: "17.4",
  constants: iosConstants() as Record<string, unknown>,
  select<T>(specifics: { ios?: T; android?: T; default?: T }): T | undefined {
    const key = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : undefined;
    return (key && specifics[key]) ?? specifics.default;
  },
};

export const Dimensions = {
  get(_dim: "window" | "screen") {
    return { width: 390, height: 844, scale: 3, fontScale: 1 };
  },
};

export const PixelRatio = {
  get() {
    return 3;
  },
  getFontScale() {
    return 1;
  },
};

// Minimal <View> that forwards touch handlers and renders children — enough for
// react-test-renderer to exercise GroundcoverProvider.
export const View = (props: {
  children?: React.ReactNode;
  onTouchStart?: (e: unknown) => void;
  onTouchEnd?: (e: unknown) => void;
  style?: unknown;
}) => React.createElement(React.Fragment, null, props.children);

// TextInput comes in TWO shapes across the RN versions this SDK supports, and
// the stub models both — modelling only one would let instrumentation that
// handles just that shape stay green here while capturing nothing on the other.
//
// `__lastProps` records the props the (possibly patched) component last
// received, so a test can read the handlers the SDK injected and fire them
// through the real instrument → listener → pool pipeline.

/** Older RN: `React.forwardRef(render)`, modelled as a bare object with `render`. */
export const forwardRefTextInput = {
  __lastProps: {} as Record<string, unknown>,
  render(props: Record<string, unknown> & { children?: React.ReactNode }, _ref: unknown) {
    forwardRefTextInput.__lastProps = props;
    return React.createElement(React.Fragment, null, props.children);
  },
};

/**
 * Newer RN: a plain function component (React 19 takes `ref` as an ordinary prop,
 * so RN dropped the forwardRef wrapper). The SDK patches neither shape: it
 * decorates the props of elements whose type IS the component, so both must be
 * instrumented alike.
 */
export function functionTextInput(
  props: Record<string, unknown> & { children?: React.ReactNode }
): React.ReactElement {
  functionTextInput.__lastProps = props;
  return React.createElement(React.Fragment, null, props.children);
}
functionTextInput.__lastProps = {} as Record<string, unknown>;

// Defaults to the CURRENT shape, so a new test written without thinking about
// versions exercises what actually ships. Legacy coverage opts in explicitly.
let textInputImpl: unknown = functionTextInput;

// `let`, not `const`: an ES live binding, so `__setTextInputShape` is visible to
// modules that already imported it — including the SDK, which compares element
// types against this binding at creation time.
export let TextInput: unknown = textInputImpl;

/**
 * Stands in for react-native's `module.exports`: a plain object literal whose
 * `TextInput` getter returns the shape currently under test, so a test can read
 * the component off the module object the way an app's compiled code does.
 */
const moduleExports: Record<string, unknown> = {};
defineTextInputGetter();

function defineTextInputGetter(): void {
  Object.defineProperty(moduleExports, "TextInput", {
    configurable: true,
    enumerable: true,
    get: () => textInputImpl,
  });
}

/** Select the shape under test, and undo any patch a previous test installed. */
export function __setTextInputShape(shape: "forwardRef" | "function"): void {
  textInputImpl = shape === "forwardRef" ? forwardRefTextInput : functionTextInput;
  TextInput = textInputImpl;
  defineTextInputGetter();
}

export default moduleExports;

// Native module registry. EMPTY by default — that is the Expo Go / JS-only
// path, so every test that does not opt in proves the SDK still works with no
// native binary. `__setNativeModule` installs one; `__emitNativeSignal` pushes a
// signal through the emitter the same way the real bridge would.
export const NativeModules: Record<string, unknown> = {};

type NativeListener = (event: unknown) => void;
const nativeListeners = new Map<string, Set<NativeListener>>();

// Test-only: arm the NEXT emitter subscription.remove() to throw, standing in for
// a native removeListeners() failure so the teardown/detach path can be exercised.
let failNextNativeRemove = false;

export class NativeEventEmitter {
  constructor(_nativeModule?: unknown) {}

  addListener(eventType: string, listener: NativeListener) {
    const set = nativeListeners.get(eventType) ?? new Set<NativeListener>();
    set.add(listener);
    nativeListeners.set(eventType, set);
    return {
      remove() {
        if (failNextNativeRemove) {
          failNextNativeRemove = false;
          // The listener stays registered — a real removeListeners() throw does not detach.
          throw new Error("removeListeners failed");
        }
        set.delete(listener);
      },
    };
  }
}

// ── Test-only control surface ──
export function __setNativeModule(name: string, mod: unknown | null): void {
  if (mod === null) {
    delete NativeModules[name];
    return;
  }
  NativeModules[name] = mod;
}

export function __emitNativeSignal(eventType: string, event: unknown): void {
  nativeListeners.get(eventType)?.forEach((l) => l(event));
}

export function __nativeListenerCount(eventType: string): number {
  return nativeListeners.get(eventType)?.size ?? 0;
}

export function __failNextNativeRemove(): void {
  failNextNativeRemove = true;
}

export function __emitAppState(state: AppStateStatus): void {
  AppState.currentState = state;
  appStateListeners.forEach((l) => l(state));
}

export function __setAppState(state: AppStateStatus): void {
  AppState.currentState = state;
}

export function __reset(): void {
  appStateListeners.clear();
  AppState.currentState = "active";
  Platform.OS = "ios";
  Platform.Version = "17.4";
  Platform.constants = iosConstants();
  nativeListeners.clear();
  failNextNativeRemove = false;
  Object.keys(NativeModules).forEach((key) => delete NativeModules[key]);
}

export type { AppStateStatus };
