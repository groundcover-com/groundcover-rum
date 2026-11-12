#!/usr/bin/env node
// Copies the native engine from packages/core/{swift,kotlin} into each SDK that
// ships it (React Native, Flutter and the native iOS SDK), or with --check,
// reports a copy that is out of date. The native Android library needs no copy:
// it is a Gradle module, published from Gradle, so it compiles the engine
// straight from packages/core/kotlin.
//
//   node scripts/vendor-engine.mjs          # write the copies
//   node scripts/vendor-engine.mjs --check  # exit 1 when a copy is stale
//
// packages/core is the only place the engine is edited. The copies are
// git-ignored and never committed: the root `prepare` script writes them on
// every `pnpm install`, the rn-playground scripts that build native code
// write them first, CI writes its own before every native build, and the
// release paths write them before any pack or publish (@groundcover/react-
// native's `prepack`; groundcover_rum's publish workflow, since `dart pub
// publish` has no hook). A copy is build output: an edit made in it is
// overwritten by the next run. The SDKs need a copy rather than a reference,
// for three reasons:
//
// - npm and pub pack only files under the package directory, and each SDK's
//   podspec, Swift package and Android source set resolve inside it. A
//   published package cannot point at a sibling package, and SwiftPM refuses
//   a target path outside the package root.
// - The RN bridge calls a member the engine marks `internal`
//   (flushFrameSegmentJson), and the Android manifests name `internal`
//   classes. They stay visible only because the copy compiles into the SDK's
//   own Gradle module.
// - CocoaPods trunk goes read-only on 2026-12-02, so a separately published
//   engine pod is not an option.
//
// The copies are byte-identical to the source: no generated-file banner. That
// keeps @groundcover/react-native's tarball byte-reproducible from the engine
// sources, which a shasum match can prove.

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SWIFT_ENGINE = "packages/core/swift/Engine";
const KOTLIN_ENGINE = "packages/core/kotlin/src/main/java/com/groundcover/rum/engine";

// The Objective-C launch anchors (GCRumProcessBoot). CocoaPods compiles them in
// the same module as the Swift that calls them; a Swift package cannot mix the
// two languages in one target, so the Flutter plugin builds them as a target
// of their own, with the header under include/ where SwiftPM looks for it.
const PROCESS_BOOT = ["AppStart/GCRumProcessBoot.h", "AppStart/GCRumProcessBoot.m"];
const PROCESS_BOOT_FILES = {
  "AppStart/GCRumProcessBoot.h": "include/GCRumProcessBoot.h",
  "AppStart/GCRumProcessBoot.m": "GCRumProcessBoot.m",
};
const FLUTTER_IOS = "packages/flutter/ios/groundcover_rum/Sources";
// The native iOS SDK splits the boot unit out the same way.
const NATIVE_IOS = "packages/ios/Sources";

// source -> copy, both relative to the repo root. A target copies every file
// under `source` except those in `exclude`, or, with `files`, only the listed
// files, each to the path given (relative to `copy`).
const TARGETS = [
  {
    source: SWIFT_ENGINE,
    copy: "packages/react-native/ios/Engine",
  },
  {
    source: KOTLIN_ENGINE,
    copy: "packages/react-native/android/src/main/java/com/groundcover/rum/engine",
  },
  {
    source: SWIFT_ENGINE,
    copy: `${FLUTTER_IOS}/groundcover_rum/Engine`,
    exclude: PROCESS_BOOT,
  },
  {
    source: SWIFT_ENGINE,
    copy: `${FLUTTER_IOS}/GroundcoverRumBoot`,
    files: PROCESS_BOOT_FILES,
  },
  {
    source: KOTLIN_ENGINE,
    copy: "packages/flutter/android/src/main/kotlin/com/groundcover/rum/engine",
  },
  {
    source: SWIFT_ENGINE,
    copy: `${NATIVE_IOS}/GroundcoverRum/Engine`,
    exclude: PROCESS_BOOT,
  },
  {
    source: SWIFT_ENGINE,
    copy: `${NATIVE_IOS}/GroundcoverRumBoot`,
    files: PROCESS_BOOT_FILES,
  },
];

// Finder and editor droppings are never engine sources, on either side.
const IGNORED = new Set([".DS_Store"]);

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return files.sort();
}

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// git tracks only the executable bit, and npm packs the mode, so that is the
// part of the mode a copy has to match.
const isExecutable = (path) => (statSync(path).mode & 0o111) !== 0;

// [source path, copy path] pairs, relative to the target's two roots.
function pairsOf(target, sourceFiles) {
  if (target.files) {
    return Object.entries(target.files).map(([from, to]) => {
      if (!sourceFiles.includes(from)) {
        throw new Error(`no engine source ${target.source}/${from}`);
      }
      return [from, to];
    });
  }
  const excluded = new Set(target.exclude ?? []);
  return sourceFiles.filter((file) => !excluded.has(file)).map((file) => [file, file]);
}

function diff(target) {
  const sourceRoot = join(ROOT, target.source);
  const copyRoot = join(ROOT, target.copy);
  const sourceFiles = listFiles(sourceRoot);
  if (sourceFiles.length === 0) {
    throw new Error(`no sources under ${target.source}`);
  }
  const pairs = pairsOf(target, sourceFiles);
  const copyFiles = new Set(listFiles(copyRoot));
  const problems = [];
  for (const [file, copied] of pairs) {
    const from = join(sourceRoot, file);
    const to = join(copyRoot, copied);
    if (!copyFiles.has(copied)) problems.push({ kind: "missing", file, copied });
    else if (digest(from) !== digest(to)) problems.push({ kind: "changed", file, copied });
    else if (isExecutable(from) !== isExecutable(to)) problems.push({ kind: "mode", file, copied });
    copyFiles.delete(copied);
  }
  for (const copied of copyFiles) problems.push({ kind: "extra", copied });
  return { sourceRoot, copyRoot, pairs, problems };
}

const check = process.argv.includes("--check");
let drifted = 0;

for (const target of TARGETS) {
  const { sourceRoot, copyRoot, pairs, problems } = diff(target);

  if (check) {
    for (const p of problems) {
      console.error(`${p.kind.padEnd(7)} ${target.copy}/${p.copied}`);
    }
    drifted += problems.length;
    continue;
  }

  // Removals first. On a case-insensitive filesystem (macOS by default) a case-only rename lists
  // the old name as extra and the new one as missing, and both name the same file: removing it
  // after the copy would delete the file just written.
  for (const p of problems) {
    if (p.kind === "extra") rmSync(join(copyRoot, p.copied));
  }
  for (const p of problems) {
    if (p.kind === "extra") continue;
    const to = join(copyRoot, p.copied);
    const from = join(sourceRoot, p.file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  }
  console.log(`${target.copy}: ${pairs.length} files, ${problems.length} updated`);
}

if (check) {
  if (drifted > 0) {
    console.error(
      `\n${drifted} vendored engine file(s) differ from packages/core.\n` +
        "Edit the engine under packages/core, then run: node scripts/vendor-engine.mjs"
    );
    process.exit(1);
  }
  console.log("vendored engine copies match packages/core");
}
