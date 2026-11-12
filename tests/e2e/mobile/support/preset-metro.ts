import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@mobilewright/test";
import type { Screen } from "@mobilewright/core";
import { BUNDLE_ID } from "./app";
import type { Launcher, PresetChannel, PresetName } from "./preset";

// The metro-source preset channel (support/preset.ts): RN's.
//
// Spec-side control of the app's init-time config — the RN answer to the browser suite's `?gcp=`
// override. The app compiles its preset in from `e2e-preset.ts` (see that file for why it cannot
// be an async lookup), so switching config means rewriting it, letting Metro re-bundle, and
// relaunching. A relaunch that beats Metro's watcher gets the PREVIOUS bundle and would run the
// spec against the wrong config, failing far from the cause — so activation is gated on the app
// reading its own preset back.

// mobilewright runs from the repo root (see the e2e npm scripts), so cwd is a
// stable anchor and needs no __dirname (which differs between the CJS and ESM
// transpilation of a spec).
const PRESET_FILE = path.resolve(process.cwd(), "apps/rn-playground/src/e2e-preset.ts");

// The dev bundle, for the failure diagnosis at the foot of activatePreset.
//
// Path-prefixed with the app dir because metro.config.js sets watchFolders to the
// workspace root, which makes the Metro server root the workspace root rather
// than apps/rn-playground — a bare /index.bundle 404s with "Unable to resolve
// module ./index".
const METRO_BUNDLE_URL = "http://localhost:8081/apps/rn-playground/index.bundle";

async function writePresetFile(name: PresetName): Promise<void> {
  const source = await readFile(PRESET_FILE, "utf8");
  const next = source.replace(
    /export const E2E_PRESET = "[^"]*";/,
    `export const E2E_PRESET = "${name}";`
  );
  if (next === source && !source.includes(`"${name}"`)) {
    throw new Error(
      `could not rewrite the preset in ${PRESET_FILE} — the export line no longer matches`
    );
  }
  await writeFile(PRESET_FILE, next, "utf8");
}

/**
 * Boot the app on `name` and don't return until the app confirms it.
 *
 * The confirmation is the Config screen rendering `preset: <name>`, which is read
 * from the same compiled-in constant the SDK was initialised with — so it cannot
 * agree while the SDK disagrees.
 */
async function activatePreset(
  ctx: { screen: Screen; device: Launcher },
  name: PresetName
): Promise<void> {
  await writePresetFile(name);

  // Three attempts: the first relaunch can outrun Metro's file watcher, and the
  // fix for that is simply to go around again once the re-bundle has landed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    // A DEAD app is a valid starting state, and this helper's contract is "boot the app on
    // this preset" rather than "restart a running one". `xcrun simctl terminate` exits 3 when
    // there is no process to terminate, which the driver surfaces as an RpcError — so a spec
    // that crashes the app and then switches preset (`zz-perturbing/unsampled-drain.spec.ts`)
    // would fail here rather than at anything it was testing. Android's `am force-stop`
    // tolerates it, so the failure is iOS-only.
    //
    // Swallowed rather than probed for liveness: the goal is "not running", and both a
    // successful terminate and a refused one reach it. A terminate that failed for a REAL
    // reason — no device — fails clearly on the launch immediately below.
    await ctx.device.terminateApp(BUNDLE_ID).catch(() => undefined);
    await ctx.device.launchApp(BUNDLE_ID);
    await ctx.screen.getByLabel("Config tab").tap();
    if (await ctx.screen.getByText(`preset: ${name}`).exists()) return;
  }

  // Failed. Ask Metro what it is actually serving before reporting — that one question
  // splits the two causes apart, which a bare failure cannot.
  // Stale means its watcher never saw the rewrite, which is what CI=true does to
  // `expo start`; fresh means the app is not picking the bundle up. Both platforms are
  // reported, because a graph built fresh on THIS request reads the current file and would
  // look healthy during the other platform's failure.
  const served = await Promise.all(
    (["ios", "android"] as const).map(async (platform) => {
      try {
        const res = await fetch(`${METRO_BUNDLE_URL}?platform=${platform}&dev=true`, {
          signal: AbortSignal.timeout(30_000),
        });
        const preset = /var E2E_PRESET = "([^"]*)"/.exec(await res.text())?.[1];
        return `${platform}=${preset ?? "not found in bundle"}`;
      } catch (error) {
        return `${platform}=unreachable (${(error as Error).message})`;
      }
    })
  );

  // Keep the locator assertion as the failure itself — it reports the preset the
  // app actually booted on — and attach Metro's answer to it.
  try {
    await expect(ctx.screen.getByText(`preset: ${name}`)).toBeVisible();
  } catch (error) {
    throw new Error(
      `the app never booted on preset "${name}" after 3 relaunches.\n` +
        `  Metro is serving: ${served.join(", ")}\n` +
        `  (Metro serving the OLD preset means its watcher is off — check for CI=true.)\n` +
        `${(error as Error).message}`
    );
  }
}

/**
 * Put the file back to "default".
 *
 * Called from an afterEach so a failed spec cannot leave the next one running on
 * someone else's config. Only rewrites the file — the next relaunch is what picks
 * it up, and every preset spec gates on its OWN preset, so the two cannot be
 * confused. Spec files that use presets live in `zz-perturbing/` so they sort
 * last and nothing from the ordinary suites can run behind them mid-run.
 */
async function restoreDefaultPreset(): Promise<void> {
  await writePresetFile("default");
}

export const metroChannel: PresetChannel = {
  activate: activatePreset,
  restore: restoreDefaultPreset,
};
