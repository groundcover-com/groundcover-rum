import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "happy-dom",
    watch: false,
  },
  resolve: {
    alias: [
      // Explicit aliases into core's TS source (deterministic — don't rely on
      // vite resolving the linked package's exports map).
      {
        find: /^@groundcover\/rum-core\/(.*)$/,
        replacement: path.resolve(__dirname, "../core/ts/src/$1"),
      },
      {
        find: "@groundcover/rum-core",
        replacement: path.resolve(__dirname, "../core/ts/src/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
