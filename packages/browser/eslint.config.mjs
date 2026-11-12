import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import {  globalIgnores } from "eslint/config"


/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  // Node scripts (build/watch tooling) need Node globals, not browser.
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  globalIgnores(["**/dist/"]),
];