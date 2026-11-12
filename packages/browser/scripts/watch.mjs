#!/usr/bin/env node
// Parallel worker + main bundle watcher. Without this, the main tsup --watch
// only sees the baked WORKER_SOURCE string and ignores src/worker/*.ts edits.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

const children = [];

function launch(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: pkgRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code, signal) => {
    if (signal) return;
    console.error(`[watch] ${label} exited with code ${code}, shutting down`);
    cleanup(code ?? 1);
  });
  children.push(child);
  return child;
}

function cleanup(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

// Worker watcher: rebuild on src/worker/*.ts change, then re-inline.
launch(
  "worker",
  "tsup",
  [
    "--config",
    "tsup.worker.config.ts",
    "--watch",
    "--onSuccess",
    "node scripts/inline-worker.mjs",
  ],
);

// Main bundle watcher.
launch(
  "main",
  "tsup",
  ["--watch"],
  { WATCH: "true" },
);
