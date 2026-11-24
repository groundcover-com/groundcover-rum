import { handleError } from "@groundcover/rum-core/common/error-handler";
import { PatchSet, type PatchSpec } from "@groundcover/rum-core/common/patch";
import { parseErrorStack, type StackFrame } from "@groundcover/rum-core/events/errors/shape-error";
import { _globalThis } from "../../common/global";

// While the exceptions listener is live, the callbacks the app passes to
// setTimeout, setInterval, requestAnimationFrame and addEventListener run
// inside a try/catch of ours.
//
// Why: WebKit (Safari, and every iOS browser) hides an error thrown inside such
// a callback when the callback's script came from another origin, even a
// script loaded with `crossorigin` and served with CORS headers. Window "error"
// then carries "Script error.", no filename and a null `error`, so there is
// nothing to report. A try/catch around the callback still sees the real
// thrown value.
//
// The wrapper reports nothing itself. It notes the value and rethrows it
// unchanged, so the host reports the error exactly as it would have and the
// page's own error handlers see what they saw before. The window "error" event
// that follows is still what the errors listener reports: a browser that gives
// the full error puts the same value on the event, and for a hidden
// "Script error." the listener takes the value the wrapper noted (see
// takeLastRethrown). So nothing changes on browsers that report these errors
// in full, and no error is reported twice.

type HostFunction = (this: unknown, ...args: unknown[]) => unknown;
type Listener = EventListenerOrEventListenerObject;

// Whoever turned wrapping on (the live errors listener), or null when it is off.
// A wrapper still reachable after the SDK shut down (the host holds it as a
// pending timer or a registered listener) only passes calls through.
let owner: object | null = null;

/** Turn wrapping on, for `by`. Never throws. */
export function enableCallbackWrapping(by: object): void {
  try {
    owner = by;
    installEventTargetPatch();
    if (timerPatches.isEmpty) {
      // One group per slot, so a host that froze one of them keeps the rest.
      for (const name of TIMER_SLOTS) {
        if (typeof hostFunctions()[name] === "function") {
          timerPatches.install([timerPatch(name)]);
        }
      }
      if (typeof hostFunctions().reportError === "function") {
        timerPatches.install([reportErrorPatch()]);
      }
    }
  } catch (error) {
    handleError(error);
  }
}

/** Turn wrapping off, if `by` is who turned it on. Never throws. */
export function disableCallbackWrapping(by: object): void {
  if (owner !== by) return;
  owner = null;
  rethrown.length = 0;
  timerPatches.restore();
  // The EventTarget patch stays installed, inert: see installEventTargetPatch.
}

// ── Rethrown values ─────────────────────────────────────────────────────────
//
// The host reports an error from a callback synchronously, before it runs the
// next one, so each noted value is taken by the window "error" event it causes.
// A value no event took (another handler stopped the event, or a framework's
// own wrapper above ours handled the error) is dropped when the task ends, so
// it can't be matched to a later, unrelated event. Microtasks may run between
// the throw and the event, so the clearing waits for a new task.
const rethrown: unknown[] = [];
const MAX_RETHROWN = 20;
let clearScheduled = false;

function noteRethrown(value: unknown): void {
  try {
    rethrown.push(value);
    if (rethrown.length > MAX_RETHROWN) rethrown.shift();
    if (!clearScheduled) {
      clearScheduled = true;
      _globalThis.setTimeout(() => {
        clearScheduled = false;
        rethrown.length = 0;
      }, 0);
    }
  } catch (error) {
    handleError(error);
  }
}

/**
 * For a hidden "Script error." event: the value a wrapper rethrew just before
 * it, as `{ value }` (the value itself may be `undefined`), or `undefined`
 * when no wrapper did. Taken, so one rethrow explains one event.
 */
export function takeLastRethrown(): { value: unknown } | undefined {
  if (rethrown.length === 0) return undefined;
  return { value: rethrown.pop() };
}

/**
 * For an event that carries its error: drop that value from the noted ones, so
 * a hidden event later in the task isn't matched to it. Whether it was one:
 * the error reached the event through a wrapper.
 */
export function forgetRethrown(value: unknown): boolean {
  for (let i = rethrown.length - 1; i >= 0; i--) {
    if (Object.is(rethrown[i], value)) {
      rethrown.splice(i, 1);
      return true;
    }
  }
  return false;
}

// ── Third-party scripts ─────────────────────────────────────────────────────
//
// Every browser hides the errors of a classic script from another origin
// loaded without `crossorigin` (a third-party widget, ad or tag manager). A
// wrapper around such a script's callback catches its errors anyway, and in
// Chrome the rethrow from the SDK's own script even shows them in full. Those
// errors stay unreported, as before the wrappers existed: an error is dropped
// when no frame of its stack, the wrappers' own left out, is in a script the
// page can see errors from.

/**
 * Whether every frame of the error's stack, the wrappers' own left out, is in
 * a script whose errors the browser hides from the page. An error with a
 * frame anywhere else (the app's code, a script loaded with `crossorigin`, a
 * module), or with no stack, is reported. Never throws.
 */
export function fromHiddenScriptsOnly(error: Error): boolean {
  try {
    const wrappers = wrapperSites();
    const frames = parseErrorStack(error).filter(
      (frame) => isAddress(frame.filename) && !wrappers.has(siteOf(frame))
    );
    return frames.length > 0 && frames.every((frame) => isHiddenScript(frame.filename));
  } catch (failure) {
    handleError(failure);
    return false;
  }
}

// Frames without a web address (native code, eval, a file the test runner
// loaded) say nothing about where an error came from, so they are left out.
function isAddress(filename: string): boolean {
  return /^https?:\/\//i.test(filename);
}

// Whether the browser hides errors from the script at this address: a
// classic script from another origin that no <script> element loaded with
// `crossorigin`. An address no <script> element has (a module's import, a
// script removed after it ran) counts as visible, so an error from the app's
// own code is never dropped for want of an element.
function isHiddenScript(filename: string): boolean {
  const page = _globalThis.location;
  const scripts = _globalThis.document?.scripts;
  if (!page || !scripts) return false;
  let address: URL;
  try {
    address = new URL(filename);
  } catch {
    return false;
  }
  if (address.origin === page.origin) return false;
  const target = withoutHash(address.href);
  let found = false;
  for (const script of Array.from(scripts)) {
    if (!script.src || withoutHash(script.src) !== target) continue;
    if (script.type === "module" || script.hasAttribute("crossorigin")) return false;
    found = true;
  }
  return found;
}

function withoutHash(href: string): string {
  const hash = href.indexOf("#");
  return hash < 0 ? href : href.slice(0, hash);
}

function siteOf(frame: StackFrame): string {
  return `${frame.filename}:${frame.lineno}:${frame.colno}`;
}

// The frames the wrappers add to a stack, right below the app's callback, as
// file:line:column. Found once, on the first error that needs them, by
// running each wrapper over a function that throws: the frame after the
// thrower's is the wrapper's. Minification can't hide them this way.
let wrapperSiteSet: Set<string> | undefined;
let calibrating = false;

function wrapperSites(): Set<string> {
  if (wrapperSiteSet) return wrapperSiteSet;
  const sites = new Set<string>();
  const thrower = function () {
    throw new Error("calibration");
  };
  const runs: Array<() => unknown> = [
    () => wrapFunction(thrower).call(undefined),
    () => wrapListener(thrower).call(undefined, undefined as unknown as Event),
    () => wrapListener({ handleEvent: thrower }).call(undefined, undefined as unknown as Event),
  ];
  calibrating = true;
  try {
    for (const run of runs) {
      try {
        run();
      } catch (error) {
        const frame = parseErrorStack(error as Error).filter((f) => isAddress(f.filename))[1];
        if (frame) sites.add(siteOf(frame));
      }
    }
  } finally {
    calibrating = false;
  }
  wrapperSiteSet = sites;
  return sites;
}

// ── Wrappers ────────────────────────────────────────────────────────────────

// The function the host calls in place of the app's: the same `this`,
// arguments and return value. A throw is noted and rethrown as is.
function wrapFunction(fn: HostFunction): HostFunction {
  return function (this: unknown, ...args: unknown[]) {
    try {
      return fn.apply(this, args);
    } catch (thrown) {
      if (owner && !calibrating) noteRethrown(thrown);
      throw thrown;
    }
  };
}

// As wrapFunction, for a listener: a function is called with the event target
// as `this`, an object has its `handleEvent` looked up and called on each
// event, as the host does.
function wrapListener(listener: Listener): EventListener {
  return function (this: unknown, event: Event) {
    try {
      return typeof listener === "function"
        ? listener.call(this, event)
        : listener.handleEvent(event);
    } catch (thrown) {
      if (owner && !calibrating) noteRethrown(thrown);
      throw thrown;
    }
  };
}

// ── Timers and animation frames ─────────────────────────────────────────────

const TIMER_SLOTS = ["setTimeout", "setInterval", "requestAnimationFrame"] as const;
type TimerSlot = (typeof TIMER_SLOTS)[number];

// The timers and reportError, restored when the SDK shuts down.
const timerPatches = new PatchSet();

function hostFunctions(): Record<TimerSlot | "reportError", HostFunction | undefined> {
  return _globalThis as unknown as Record<TimerSlot | "reportError", HostFunction | undefined>;
}

// reportError(value) reports a value as uncaught without throwing it, and
// WebKit hides it like a thrown error when the caller's script is from another
// origin. React 19 sends here the errors it catches in event handlers and
// rendering. The error event is dispatched inside the call, so the value is
// noted first. React keeps the reportError it finds when react-dom loads, so
// this reaches React only when the SDK starts before react-dom is imported.
function reportErrorPatch(): PatchSpec<HostFunction> {
  return {
    get: () => hostFunctions().reportError as HostFunction,
    set: (fn) => {
      hostFunctions().reportError = fn;
    },
    wrap: (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (owner) noteRethrown(args[0]);
        return original.apply(this, args);
      },
  };
}

// The callback is the first argument of all three. A string handler (eval'd
// by setTimeout) and anything else that isn't a function is passed as is.
function timerPatch(name: TimerSlot): PatchSpec<HostFunction> {
  return {
    get: () => hostFunctions()[name] as HostFunction,
    set: (fn) => {
      hostFunctions()[name] = fn;
    },
    wrap: (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (owner && typeof args[0] === "function") {
          args[0] = wrapFunction(args[0] as HostFunction);
        }
        return original.apply(this, args);
      },
  };
}

// ── Event listeners ─────────────────────────────────────────────────────────
//
// Each listener gets one wrapper, kept for as long as the listener lives, so
// the host's own bookkeeping still works: adding the same listener twice adds
// the same wrapper, which the host ignores as it would have ignored the
// listener, and removeEventListener with the listener removes its wrapper.
//
// That bookkeeping must outlive the SDK: a listener added while the SDK ran is
// registered as its wrapper, so removing it after the SDK shut down still has
// to go through us. So the patch is installed once and never restored; with
// the SDK shut down it adds new listeners as they are and keeps mapping the
// ones it already wrapped.

const listenerWrappers = new WeakMap<object, EventListener>();
let eventTargetPatched = false;

type AddListener = EventTarget["addEventListener"];
type RemoveListener = EventTarget["removeEventListener"];

function installEventTargetPatch(): void {
  if (eventTargetPatched || typeof EventTarget !== "function") return;
  const proto = EventTarget.prototype;
  if (typeof proto.addEventListener !== "function" || typeof proto.removeEventListener !== "function") {
    return;
  }
  // The native remove, for the add wrapper below. Read before installing, so
  // it is never our own remove wrapper.
  const remove = proto.removeEventListener;
  const add: PatchSpec<AddListener> = {
    get: () => proto.addEventListener,
    set: (fn) => {
      proto.addEventListener = fn;
    },
    wrap: (original) =>
      function (this: EventTarget, type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) {
        if (listener === null || (typeof listener !== "function" && typeof listener !== "object")) {
          return original.call(this, type, listener, options);
        }
        let wrapped = listenerWrappers.get(listener);
        if (!wrapped) {
          if (!owner) return original.call(this, type, listener, options);
          wrapped = wrapListener(listener);
          listenerWrappers.set(listener, wrapped);
        }
        // The app may have added this listener before it was wrapped (before
        // the SDK started, or while it was shut down). That registration
        // would run alongside the wrapper, so the listener would run twice for
        // one event: replace it, so the listener stays registered once, under
        // this call's options and last in order. When it isn't registered
        // this removes nothing. An add with an already-aborted signal adds
        // nothing, so it must not remove the registration either.
        if (!hasAbortedSignal(options)) remove.call(this, type, listener, options);
        return original.call(this, type, wrapped, options);
      },
  };
  const removeSpec: PatchSpec<RemoveListener> = {
    get: () => proto.removeEventListener,
    set: (fn) => {
      proto.removeEventListener = fn;
    },
    wrap: (original) =>
      function (this: EventTarget, type: string, listener: Listener | null, options?: boolean | EventListenerOptions) {
        // WeakMap.get is undefined for a value that isn't an object.
        const wrapped = listenerWrappers.get(listener as object);
        if (wrapped) original.call(this, type, wrapped, options);
        return original.call(this, type, listener, options);
      },
  };
  // Both or neither: an add without its remove would strand listeners.
  eventTargetPatched = new PatchSet().install([add, removeSpec]);
}

function hasAbortedSignal(options: boolean | AddEventListenerOptions | undefined): boolean {
  return typeof options === "object" && options !== null && options.signal?.aborted === true;
}
