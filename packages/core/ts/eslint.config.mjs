import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The platform touchpoints core must never reach for directly, each with the
// injected seam to use instead. Single source of truth: the same list drives
// BOTH the bare-identifier rule and the member-access rule below, so the two
// can't drift.
//
// The tsconfig gate (types/host-globals.d.ts) stops undeclared globals from
// compiling in shipping source, but not member access via globalThis, and it
// does not cover tests, which typecheck against @types/node. This list is the
// half of the gate that reaches both: each entry is either absent on some host
// core targets (browser, Node, Hermes) or an optional capability that may only
// be probed behind a `typeof` guard.
const RESTRICTED = {
  window: "Core is platform-agnostic — inject the touchpoint from the platform package.",
  document: "Core is platform-agnostic — inject the touchpoint from the platform package.",
  navigator: "Core is platform-agnostic — inject the touchpoint from the platform package.",
  location: "Core is platform-agnostic — inject the touchpoint from the platform package.",
  history: "Core is platform-agnostic — inject the touchpoint from the platform package.",
  localStorage: "Core is platform-agnostic — inject a PlatformStorage instead.",
  sessionStorage: "Core is platform-agnostic — inject a PlatformStorage instead.",
  performance: "Core is platform-agnostic — inject the timing source from the platform package.",
  fetch: "Not universal across browser/Node/Hermes — inject a BatchSender from the platform package.",
  XMLHttpRequest: "Browser-only — inject the network primitive from the platform package.",
  FormData: "Optional host global — probe with `typeof` before `instanceof`.",
  Blob: "Optional host global — probe with `typeof` before `instanceof`.",
  File: "Optional host global — probe with `typeof` before `instanceof`.",
  ReadableStream: "Optional host global — probe with `typeof` before `instanceof`.",
  URLSearchParams: "Optional host global — probe with `typeof` before `instanceof`.",
  CompressionStream: "Optional host global — core compresses with fflate instead.",
  Worker: "Browser-only — inject an AsyncEncoder from the platform package.",
  TextEncoder: "Not universal — encode via `encodeUtf8` (src/common/utf8.ts) / decode via an injected seam.",
  TextDecoder: "Not universal — encode via `encodeUtf8` (src/common/utf8.ts) / decode via an injected seam.",
  process: "Core must not depend on Node.js — it also runs on browsers and Hermes.",
  Buffer: "Core must not depend on Node.js — use Uint8Array.",
};

// `no-restricted-globals` only matches BARE identifiers, so `globalThis.fetch`
// and an aliased `_globalThis.Blob` walk straight past it. Mirror every entry
// as a member-access restriction on each object that can reach them.
//
// `global` is included deliberately: @types/node declares it, so `global.fetch`
// typechecks here AND is not itself a restricted identifier — without this entry
// it would be a Node escape hatch through this gate.
// (`setTimeout`/`clearTimeout` stay allowed: they are universal.)
const GLOBAL_OBJECTS = ["globalThis", "_globalThis", "global", "window", "self"];
const restrictedProperties = GLOBAL_OBJECTS.flatMap((object) =>
  Object.entries(RESTRICTED).map(([property, message]) => ({
    object,
    property,
    message: `${message} (reached via ${object}.${property})`,
  }))
);

export default tseslint.config(
  // lint-fixtures/ is deliberately full of violations — excluded from the
  // normal run, linted explicitly by `lint:gate` with --no-ignore.
  { ignores: ["**/dist/", "lint-fixtures/"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // lint-fixtures/ holds the deliberate-violation file that proves this gate
    // still bites; it is never compiled or shipped.
    files: ["src/**/*.ts", "lint-fixtures/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      // The globals every host core runs on (browser, Node, Hermes) provides:
      // the always-present part of types/host-globals.d.ts. The optional body
      // types declared there are not listed — typescript-eslint turns `no-undef`
      // off for .ts files — and RESTRICTED flags them wherever they are used.
      globals: {
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        globalThis: "readonly",
      },
    },
    rules: {
      // Belt over the tsconfig gate. A deliberate optional-capability probe
      // (see common/body-formatter.ts) opts out locally with a scoped
      // eslint-disable and a `typeof` guard.
      "no-restricted-globals": [
        "error",
        ...Object.entries(RESTRICTED).map(([name, message]) => ({ name, message })),
      ],
      "no-restricted-properties": ["error", ...restrictedProperties],
    },
  },
  {
    // Tests run on Node and may use its globals, but the restricted-globals
    // rules stay ON: core's tests model hosts with fakes (see
    // src/test-utils/), never with a browser's globals. A test that
    // deliberately exercises an optional host type opts out locally, like the
    // source it covers.
    files: ["src/**/*.test.ts"],
    languageOptions: {
      globals: globals.node,
    },
  }
);
