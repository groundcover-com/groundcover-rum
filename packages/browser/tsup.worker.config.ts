import { defineConfig } from "tsup";

// Worker IIFE bundle consumed by scripts/inline-worker.mjs and inlined into
// src/worker/worker-source.ts as a string literal.
export default defineConfig({
  entry: { worker: "src/worker/worker.ts" },
  format: ["iife"],
  outDir: "dist/.worker-build",
  outExtension: () => ({ js: ".js" }),
  dts: false,
  sourcemap: false,
  clean: true,
  minify: "terser",
  terserOptions: {
    mangle: true,
    compress: true,
  },
  treeshake: true,
  platform: "browser",
  target: "es2020",
  // platform + `module` define neutralize fflate's Node worker_threads probe
  // — without them it ReferenceErrors in a Web Worker scope.
  define: {
    "module": "undefined",
  },
  tsconfig: "./tsconfig.json",
});
