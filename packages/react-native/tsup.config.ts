import { defineConfig } from "tsup";
import {
  OPTIONAL_REQUIRES,
  noInlinedNodeModules,
  restoreOptionalRequires,
} from "./scripts/optional-requires.mjs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: {
    entry: "src/index.ts",
    compilerOptions: {
      composite: false,
    },
  },
  splitting: false,
  // No sourcemaps and minified, the same as the browser package. esbuild embeds
  // the original TypeScript in a map's `sourcesContent`, and an unminified bundle
  // keeps its comments, so either one would ship the TypeScript sources in
  // the npm tarball. The native engine is the one thing that
  // still ships as source (CocoaPods and Gradle compile it from the package).
  sourcemap: false,
  clean: true,
  minify: "terser",
  terserOptions: {
    mangle: true,
    compress: true,
  },
  // react / react-native and the optional peers stay external — the host app
  // provides them. Core is a private TS-source workspace package, so inline it
  // (like the browser package) to keep the published artifact self-contained.
  //
  // The JSX runtimes are listed EXPLICITLY: esbuild matches `external` entries as
  // exact module ids, so "react" alone does not cover its subpaths, and a bundled
  // copy of `react/jsx-runtime` would be a private second module — the text-input
  // instrumentation patches those exports and would silently instrument nothing
  // but itself.
  //
  // OPTIONAL_REQUIRES are the ids src/platform/optional-modules.ts loads with a
  // guarded require (AsyncStorage, expo-constants, RN's promise rejection
  // tracking). They must stay literal `require("…")` calls for Metro to link
  // them, which tsup doesn't do on its own: see scripts/optional-requires.mjs.
  external: [
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-native",
    "@react-navigation/native",
    ...OPTIONAL_REQUIRES,
  ],
  noExternal: ["@groundcover/rum-core"],
  // Fails the build if anything from node_modules would be inlined.
  esbuildPlugins: [noInlinedNodeModules],
  // Runs after every build, watch rebuilds included.
  onSuccess: async () => restoreOptionalRequires(),
  treeshake: true,
  tsconfig: "./tsconfig.json",
});
