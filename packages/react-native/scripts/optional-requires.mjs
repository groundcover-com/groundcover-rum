// Keeps the optional peers in src/platform/optional-modules.ts loadable by the
// host app's bundler. tsup.config.ts wires it in; this file doesn't ship.
//
// Each optional peer is loaded with a literal `require("<id>")` inside a
// try/catch. Metro links that shape statically when `allowOptionalDependencies`
// is on, as it is in @react-native/metro-config (RN 0.74+) and
// @expo/metro-config (SDK 51+). A peer the app lacks becomes a stub that throws
// at runtime, and the catch turns that into null. Metro only treats the require
// as optional when its statement sits directly in the try block.
//
// tsup does not keep that shape on its own:
//   - A peer that isn't external gets bundled. With node-linker=hoisted, the
//     build finds rn-playground's copy of expo-constants (and, through it,
//     expo-modules-core) and the `promise` package, and inlines private copies.
//   - With `treeshake`, tsup has esbuild emit ESM for both formats, and esbuild
//     routes `require()` in ESM through its `__require` shim. Rollup then carries
//     the shim into the CJS build too. Metro can't link a call through the shim:
//     at runtime it hands metroRequire a package name, which Metro rejects, so
//     the peer never loads.
//
// So:
//   - OPTIONAL_REQUIRES (read from the source, so the two can't drift) are
//     external in tsup.config.ts.
//   - `noInlinedNodeModules` fails the bundle if anything else from
//     node_modules would be inlined.
//   - `optionalRequires`, a tsup plugin, turns each `__require("<id>")` back into
//     `require("<id>")` before Rollup and terser run, which lets Rollup drop the
//     unused shim. After the files are written, it parses them and fails the
//     build unless every id is required literally, in a spot Metro treats as
//     optional, and no shim is left (a require of anything else would still go
//     through it).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "src/platform/optional-modules.ts";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Reads the module ids src/platform/optional-modules.ts loads with `require("…")`. */
function readOptionalRequires() {
  const source = readFileSync(join(pkgRoot, SOURCE), "utf8")
    // Comments may mention require("…") without loading anything.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  const ids = [...source.matchAll(/\brequire\(\s*(["'`])([^"'`$]+)\1\s*\)/g)].map(
    (match) => match[2]
  );
  if (ids.length === 0) {
    throw new Error(`[optional-requires] found no require("…") in ${SOURCE}`);
  }
  return ids;
}

/** Read once, when tsup loads its config; the external list is built from it. */
export const OPTIONAL_REQUIRES = readOptionalRequires();

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

/** A call loading `id`, through esbuild's shim (`__require`, `__require2`, …) or literally. */
const callLoading = (id) =>
  new RegExp(`(?<![\\w$.])(?:__require\\d*|require)\\((["'\`])${escapeRegExp(id)}\\1\\)`, "g");

/** Every `require("…")` call in `code`, parsed, so strings and comments don't count. */
function literalRequires(code, file) {
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return calls;
}

const isStatement = (node) =>
  (node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement) ||
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node);

/**
 * Metro's rule (isOptionalDependency in metro/src/ModuleGraph/worker/collectDependencies.js):
 * walking up from the require, the first block must be a try statement's `try`
 * block, reached through at most two other statements. Object literals and
 * blocks that closed before the require don't count.
 */
function isOptionalForMetro(call) {
  let statements = 0;
  for (let node = call; node && statements < 3; node = node.parent) {
    if (ts.isBlock(node)) {
      return ts.isTryStatement(node.parent) && node.parent.tryBlock === node;
    }
    if (isStatement(node)) statements += 1;
  }
  return false;
}

/** Throws unless `code` (a written bundle) loads every optional peer the way Metro needs. */
export function checkOptionalRequires(code, file) {
  const fail = (message) => {
    throw new Error(`[optional-requires] ${file}: ${message}`);
  };
  const current = readOptionalRequires();
  if (current.join("\n") !== OPTIONAL_REQUIRES.join("\n")) {
    fail(
      `${SOURCE} now requires ${current.join(", ")} but tsup loaded ` +
        `${OPTIONAL_REQUIRES.join(", ")}; restart tsup so it re-reads them`
    );
  }
  const requires = literalRequires(code, file);
  for (const id of OPTIONAL_REQUIRES) {
    const calls = requires.filter((call) => call.arguments[0].text === id);
    if (calls.length !== 1) {
      fail(`expected one literal require("${id}"), found ${calls.length}`);
    }
    if (!isOptionalForMetro(calls[0])) {
      fail(
        `require("${id}") is not directly inside a try block, so Metro would make it a ` +
          "required dependency and apps without it would fail to bundle"
      );
    }
  }
  if (code.includes("Dynamic require of")) {
    fail(
      "esbuild's require shim is still in the bundle, so some require() goes through it " +
        `and Metro can't link it. Load optional peers only from ${SOURCE}, with a string literal.`
    );
  }
}

/**
 * tsup plugin. renderChunk runs before Rollup and terser, while esbuild's shim
 * still has its own name; buildEnd runs after the files are written.
 */
export const optionalRequires = {
  name: "optional-requires",
  renderChunk(code, chunk) {
    if (!/\.[cm]?js$/.test(chunk.path)) return;
    let next = code;
    for (const id of OPTIONAL_REQUIRES) {
      const calls = next.match(callLoading(id)) ?? [];
      if (calls.length !== 1) {
        throw new Error(
          `[optional-requires] ${chunk.path}: expected one call loading "${id}", found ` +
            `${calls.length}${calls.length ? ` (${calls.join(", ")})` : ""}`
        );
      }
      next = next.replace(callLoading(id), () => `require(${JSON.stringify(id)})`);
    }
    return { code: next };
  },
  buildEnd({ writtenFiles }) {
    for (const { name } of writtenFiles) {
      if (!/\.[cm]?js$/.test(name)) continue;
      checkOptionalRequires(readFileSync(name, "utf8"), name);
    }
    this.logger.info(
      "optional-requires",
      `literal require() of ${OPTIONAL_REQUIRES.join(", ")} (${this.format})`
    );
  },
};
