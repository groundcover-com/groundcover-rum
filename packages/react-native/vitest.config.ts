import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Node env: no DOM, closer to Hermes than jsdom. The RN host surface
    // (Platform, AppState, Dimensions, AsyncStorage) is aliased to controllable
    // stubs below rather than a real device.
    environment: "node",
    watch: false,
    globals: false,
  },
  resolve: {
    alias: [
      {
        find: /^@groundcover\/rum-core\/(.*)$/,
        replacement: path.resolve(__dirname, "../core/ts/src/$1"),
      },
      {
        find: "@groundcover/rum-core",
        replacement: path.resolve(__dirname, "../core/ts/src/index.ts"),
      },
      // The RN host boundary — stubbed so unit + wire tests run without a device.
      {
        find: "@react-native-async-storage/async-storage",
        replacement: path.resolve(__dirname, "./src/test-utils/async-storage-stub.ts"),
      },
      {
        find: "react-native",
        replacement: path.resolve(__dirname, "./src/test-utils/react-native-stub.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
