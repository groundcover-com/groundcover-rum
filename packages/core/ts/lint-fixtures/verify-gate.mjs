// Verifies the platform gate still BITES.
//
// A plain `eslint` run over conforming source proves nothing about a gate whose
// entire job is catching violations. gate-probe.ts is a file of deliberate
// violations; this script asserts every single one is still reported.
//
// Counting "at least one error" is not enough — that is how a newly added probe
// can sit there silently uncaught while the check stays green. So the contract
// here is per-line: EVERY line tagged `// GATE` must produce at least one lint
// error, and any tagged line that stops being reported fails the build.
import { ESLint } from "eslint";
import { readFileSync } from "node:fs";

const FIXTURE = "lint-fixtures/gate-probe.ts";
const MARKER = "// GATE";

const source = readFileSync(FIXTURE, "utf8").split("\n");
// Only CODE lines count: a line that is nothing but a comment can mention the
// marker in prose (the file header does) without being a probe.
const expectedLines = source
  .map((text, i) => ({ line: i + 1, text }))
  .filter(({ text }) => text.includes(MARKER) && !text.trim().startsWith("//"))
  .map(({ line }) => line);

if (expectedLines.length === 0) {
  console.error(`lint:gate FAILED — no code lines tagged "${MARKER}" in ${FIXTURE}.`);
  process.exit(1);
}

const eslint = new ESLint({ ignore: false });
const [result] = await eslint.lintFiles([FIXTURE]);
const reportedLines = new Set((result?.messages ?? []).map((m) => m.line));

const missed = expectedLines.filter((line) => !reportedLines.has(line));

if (missed.length > 0) {
  console.error(
    `lint:gate FAILED — the platform gate no longer reports these deliberate ` +
      `violations in ${FIXTURE}:`
  );
  for (const line of missed) {
    console.error(`  L${line}: ${source[line - 1].trim()}`);
  }
  process.exit(1);
}

console.log(
  `lint:gate ok — all ${expectedLines.length} deliberate violations in ${FIXTURE} still reported`
);
