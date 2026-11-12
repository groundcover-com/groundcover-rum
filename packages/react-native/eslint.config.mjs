import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The RN package's platform gate. Unlike core (which bans the entire Fetch API
// family), React Native genuinely HAS fetch / XMLHttpRequest / FileReader /
// console / setTimeout, and the SDK uses them directly — those are allowed.
// What stays banned is the DOM (no window / document / navigator / history /
// localStorage on a device) plus the RN polyfills that are notoriously partial
// and must not be relied on:
//   - URL / URLSearchParams: RN's polyfill is incomplete (no pathname parsing);
//     the SDK does manual string/regex parsing instead (mirrors core redaction).
//   - Worker / CompressionStream: no Web Workers in RN; compress inline with fflate.
const RESTRICTED = {
  window: "No DOM in React Native — use react-native APIs (Platform, Dimensions, AppState).",
  document: "No DOM in React Native.",
  navigator: "No DOM in React Native — use Platform / getRNDeviceAttributes for device metadata.",
  location: "No DOM in React Native — the current screen comes from the navigation tracker.",
  history: "No DOM in React Native — screen changes come from React Navigation.",
  localStorage: "No DOM in React Native — use the injected PlatformStorage (AsyncStorage-backed).",
  sessionStorage: "No DOM in React Native — use the injected PlatformStorage.",
  URL: "RN's URL polyfill is incomplete — parse URLs with the SDK's string/regex helpers.",
  URLSearchParams: "RN's URLSearchParams polyfill is incomplete — avoid it.",
  Worker: "No Web Workers in React Native — compress inline with fflate.",
  CompressionStream: "Not available in Hermes — compress inline with fflate.",
};

const GLOBAL_OBJECTS = ["globalThis", "global", "window", "self"];
const restrictedProperties = GLOBAL_OBJECTS.flatMap((object) =>
  Object.entries(RESTRICTED).map(([property, message]) => ({
    object,
    property,
    message: `${message} (reached via ${object}.${property})`,
  }))
);

export default tseslint.config(
  { ignores: ["**/dist/", "src/test-utils/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        // RN runtime globals the SDK legitimately uses.
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        XMLHttpRequest: "readonly",
        FileReader: "readonly",
        require: "readonly",
      },
    },
    rules: {
      "no-restricted-globals": [
        "error",
        ...Object.entries(RESTRICTED).map(([name, message]) => ({ name, message })),
      ],
      "no-restricted-properties": ["error", ...restrictedProperties],
      // Underscore-prefixed args/vars are intentionally unused (stub params,
      // deliberately-ignored callback args).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  }
);
