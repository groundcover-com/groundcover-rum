import { describe, it, expect } from "vitest";
import { OPTIONAL_REQUIRES, checkOptionalRequires } from "./optional-requires.mjs";

// checkOptionalRequires runs on every written bundle (tsup.config.ts) and fails
// the build unless each optional peer is loaded the way Metro's
// `allowOptionalDependencies` treats as optional. These cases pin it to Metro's
// own rule (isOptionalDependency in metro/src/ModuleGraph/worker/collectDependencies.js):
// walking up from the require, the first block statement must be a try's
// `block`, reached through at most two other statements.

const ID = "expo-constants";
const others = OPTIONAL_REQUIRES.filter((id) => id !== ID);
const loader = (id) => `try { exports[${JSON.stringify(id)}] = require(${JSON.stringify(id)}); } catch {}`;

/** A bundle that loads the other peers the standard way and `ID` with `snippet`. */
const bundle = (snippet) => [...others.map(loader), snippet].join("\n");
const check = (snippet) => () => checkOptionalRequires(bundle(snippet), "bundle.js");

describe("checkOptionalRequires", () => {
  it("covers expo-constants, which these cases use", () => {
    expect(OPTIONAL_REQUIRES).toContain(ID);
  });

  describe("accepts what Metro treats as optional", () => {
    it.each([
      ["the shape esbuild emits", loader(ID)],
      // PR #11 review: braces in an earlier statement aren't a block.
      ["an object literal before the require", `try { log({}); require("${ID}"); } catch {}`],
      ["the require inside an object literal", `try { use({ m: require("${ID}") }); } catch {}`],
      ["a brace in a string before it", `try { log("}"); require("${ID}"); } catch {}`],
      ["a closed block before it", `try { if (a) { b(); } require("${ID}"); } catch {}`],
      ["the require behind an if, without braces", `function f() { try { if (a) return require("${ID}"); } catch {} }`],
      ["a commented-out require beside the real one", `// require("${ID}")\n${loader(ID)}`],
    ])("%s", (_name, snippet) => {
      expect(check(snippet)).not.toThrow();
    });
  });

  describe("rejects what Metro would make a required dependency", () => {
    it.each([
      ["no try at all", `exports.c = require("${ID}");`],
      ["inside a nested block", `try { if (a) { require("${ID}"); } } catch {}`],
      ["inside a function in the try", `try { (function () { require("${ID}"); })(); } catch {}`],
      ["inside an arrow function body in the try", `try { run(() => { require("${ID}"); }); } catch {}`],
      ["in the catch block", `try { a(); } catch { require("${ID}"); }`],
      ["in the finally block", `try { a(); } finally { require("${ID}"); }`],
      ["three statements below the try", `function f() { try { if (a) if (b) return require("${ID}"); } catch {} }`],
    ])("%s", (_name, snippet) => {
      expect(check(snippet)).toThrow(`require("${ID}") is not directly inside a try block`);
    });
  });

  it("rejects a peer required twice or not at all", () => {
    expect(check(`${loader(ID)}\n${loader(ID)}`)).toThrow(`expected one literal require("${ID}"), found 2`);
    expect(check("")).toThrow(`expected one literal require("${ID}"), found 0`);
  });

  it("rejects a bundle that still carries esbuild's require shim", () => {
    const shim = 'var __require = (x) => { throw Error("Dynamic require of " + x); };';
    expect(check(`${shim}\n${loader(ID)}`)).toThrow("esbuild's require shim is still in the bundle");
  });
});
