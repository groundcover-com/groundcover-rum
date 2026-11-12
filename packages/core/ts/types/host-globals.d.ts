// THE HOST SURFACE core compiles against — the whole of it. `lib` is plain
// ES2022 and no @types package is loaded (see tsconfig.json), so any global
// not declared here fails to typecheck. Every entry must exist on every host
// core runs on (browsers, Node, Hermes), or be an OPTIONAL capability that is
// only ever reached through a `typeof` guard.
//
// Not shipped: platform packages compile core's source against their own libs.

interface Console {
  assert(condition?: boolean, ...data: unknown[]): void;
  debug(...data: unknown[]): void;
  error(...data: unknown[]): void;
  info(...data: unknown[]): void;
  log(...data: unknown[]): void;
  trace(...data: unknown[]): void;
  warn(...data: unknown[]): void;
}
declare var console: Console;

type TimerHandle = number | { readonly __timerHandle?: never };
declare function setTimeout(handler: () => void, timeout?: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle | undefined): void;

// Optional host body types, probed `typeof X !== "undefined" && v instanceof X`
// (see common/body-formatter.ts). Declared possibly-absent so an unguarded use
// is a type error, not just a lint finding.
declare var FormData: (abstract new () => object) | undefined;
declare var Blob: (abstract new () => object) | undefined;
declare var ReadableStream: (abstract new () => object) | undefined;
declare var URLSearchParams: (abstract new () => { toString(): string }) | undefined;
