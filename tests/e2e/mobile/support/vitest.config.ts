import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Plain unit tests over the harness's own helpers. The specs need a device; the JUDGEMENTS in these
 * helpers do not, and they are the parts that can be WRONG without a device. Same split as
 * `packages/core/swift/Package.swift` makes for the Swift engine.
 *
 * Run via the react-native package's own vitest rather than a root dependency, because
 * `pnpm-lock.yaml` is hashed into the prebuilt app cache keys.
 */
export default defineConfig({
  // Pinned to THIS directory, not the invoking cwd. Because the runner is
  // borrowed from packages/react-native, vitest's root would otherwise be that
  // package and `include` would sweep up its unit tests too.
  root: __dirname,
  test: {
    environment: "node",
    watch: false,
    globals: false,
    // Scoped to this directory: the sibling `*.spec.ts` files are device specs
    // and belong to mobilewright, which is the other half of this split.
    include: ["**/*.test.ts"],
  },
});
