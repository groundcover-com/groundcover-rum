import { defineConfig } from "tsup";

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
  sourcemap: false,
  clean: true,
  minify: "terser",
  terserOptions: {
    mangle: true,
    compress: true,
  },
  external: ["web-vitals"],
  // Core is a private TS-source workspace package — inline it so the
  // published artifact stays self-contained (nothing to install from npm).
  noExternal: ["@groundcover/rum-core"],
  treeshake: true,
  tsconfig: "./tsconfig.json",
});
