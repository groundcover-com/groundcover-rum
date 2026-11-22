// Keeps the optional peers in src/platform/optional-modules.ts loadable by the
// host app's bundler. tsup.config.ts wires in both halves; neither file ships.
//
// Each optional peer is loaded with a literal `require("<id>")` inside a
// try/catch. That is the shape Metro links statically when
// `allowOptionalDependencies` is on, as it is in @react-native/metro-config
// (RN 0.74+) and @expo/metro-config (SDK 51+). A peer the app lacks becomes a
// stub that throws at runtime, and the catch turns that into null.
//
// tsup does not keep that shape on its own:
//   - A peer that isn't external gets bundled. With node-linker=hoisted, the
//     build finds rn-playground's copy of expo-constants (and, through it,
//     expo-modules-core) and the `promise` package, and inlines private copies.
//   - esbuild routes `require()` in ESM output through its `__require` shim, and
//     tsup's Rollup tree-shaking pass carries the ESM shim into the CJS build.
//     Metro can't link a call through the shim: at runtime it hands
//     metroRequire a package name, which Metro rejects, so the peer never loads.
//
// So the ids are external (OPTIONAL_REQUIRES, read from the source so the two
// lists can't drift), `noInlinedNodeModules` fails the bundle if anything else
// from node_modules would be inlined, and `restoreOptionalRequires` runs after
// each build to put the literal requires back and check every one is there.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "src/platform/optional-modules.ts";
const OUTPUTS = ["dist/index.js", "dist/index.mjs"];

/** The module ids src/platform/optional-modules.ts loads with `require("…")`. */
export const OPTIONAL_REQUIRES = [
  ...readFileSync(join(pkgRoot, SOURCE), "utf8")
    // Comments may mention require("…") without loading anything.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .matchAll(/\brequire\("([^"]+)"\)/g),
].map((match) => match[1]);

if (OPTIONAL_REQUIRES.length === 0) {
  throw new Error(`[optional-requires] found no require("…") in ${SOURCE}`);
}

/**
 * esbuild plugin: fail the build if any file under node_modules would be
 * bundled. Everything the SDK uses at runtime is either external (react,
 * react-native, the optional peers) or a dependency tsup externalizes; only
 * @groundcover/rum-core is inlined, and it resolves to packages/core/ts.
 */
export const noInlinedNodeModules = {
  name: "no-inlined-node-modules",
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]/ }, (args) => ({
      errors: [
        {
          text:
            `${args.path} would be bundled into @groundcover/react-native. ` +
            "Make its package external in tsup.config.ts so the app provides it.",
        },
      ],
    }));
  },
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Post-build: turn each shimmed optional require back into a literal `require("…")`. */
export function restoreOptionalRequires() {
  for (const output of OUTPUTS) {
    const file = join(pkgRoot, output);
    let code = readFileSync(file, "utf8");
    for (const id of OPTIONAL_REQUIRES) {
      // The call esbuild left: `require("id")` or a (minified) shim such as `E("id")`.
      const call = new RegExp(
        `(?<![\\w$.])[A-Za-z_$][\\w$]*\\((["'])${escapeRegExp(id)}\\1\\)`,
        "g"
      );
      const found = code.match(call) ?? [];
      if (found.length !== 1) {
        throw new Error(
          `[optional-requires] ${output}: expected exactly one call loading "${id}", found ` +
            `${found.length}${found.length ? ` (${found.join(", ")})` : ""}`
        );
      }
      code = code.replace(call, `require(${JSON.stringify(id)})`);
    }
    writeFileSync(file, code);
  }
  console.log(
    `[optional-requires] literal require() of ${OPTIONAL_REQUIRES.join(", ")} in ${OUTPUTS.join(", ")}`
  );
}
