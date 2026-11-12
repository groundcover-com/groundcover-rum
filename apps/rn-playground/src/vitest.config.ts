import { defineConfig } from "vitest/config";

/**
 * Unit tests over the playground's own config JUDGEMENT — which preset a build boots on and
 * where it posts. The app needs a device; those two decisions do not, and they are the ones
 * that fail invisibly when wrong.
 *
 * Same split, and the same borrowed runner, as `tests/e2e/mobile/support/vitest.config.ts`:
 * run through the react-native package's vitest rather than adding a dependency here, because
 * `pnpm-lock.yaml` is hashed into the prebuilt app cache keys.
 */
export default defineConfig({
  // Pinned to THIS directory, not the invoking cwd — the runner is borrowed from
  // packages/react-native, whose root would otherwise sweep up its own unit tests.
  root: __dirname,
  test: {
    environment: "node",
    watch: false,
    globals: false,
    include: ["**/*.test.ts"],
  },
});
