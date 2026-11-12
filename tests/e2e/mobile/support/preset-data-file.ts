import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "@mobilewright/test";
import { app, BUNDLE_ID } from "./app";
import { androidRunAs } from "./android-device";
import type { PresetChannel, PresetContext, PresetName } from "./preset";

// The data-file preset channel (support/preset.ts): Flutter's and the native apps'. Neither has a
// hot bundle, and Mobilewright can't pass launch arguments, so the harness writes
// `e2e-preset.json` into the app's data, which the app reads before init
// (apps/flutter-playground/lib/config_presets.dart, apps/ios-playground/Sources/Presets.swift and
// the Android playground's preset reader).

const execFileAsync = promisify(execFile);

// `Documents/` in the iOS app container for both apps; in the Android app's data directory, the
// profile's androidDataDir (Flutter's getApplicationDocumentsDirectory() is `app_flutter/`, a native
// app's filesDir is `files/`).
const PRESET_FILE = "e2e-preset.json";
const ANDROID_DIR = app.androidDataDir ?? "app_flutter";

function platformOf(ctx: Pick<PresetContext, "platform">): "ios" | "android" {
  if (ctx.platform === undefined) {
    throw new Error(
      "the data-file preset channel writes to the device, so it needs the test's `platform` " +
        "fixture — set it in this project's `use` (mobilewright.config.ts)"
    );
  }
  return ctx.platform;
}

async function iosDocumentsDir(): Promise<string> {
  const { stdout } = await execFileAsync("xcrun", [
    "simctl",
    "get_app_container",
    "booted",
    BUNDLE_ID,
    "data",
  ]);
  return path.join(stdout.trim(), "Documents");
}

/** Write `{"preset": name}` where the app reads it; `null` removes the file. */
async function writePreset(platform: "ios" | "android", name: PresetName | null): Promise<void> {
  const content = JSON.stringify({ preset: name });
  if (platform === "ios") {
    const dir = await iosDocumentsDir();
    const file = path.join(dir, PRESET_FILE);
    if (name === null) return rm(file, { force: true });
    await mkdir(dir, { recursive: true });
    return writeFile(file, content, "utf8");
  }
  const file = `${ANDROID_DIR}/${PRESET_FILE}`;
  if (name === null) return androidRunAs(BUNDLE_ID, `rm -f ${file}`);
  return androidRunAs(BUNDLE_ID, `mkdir -p ${ANDROID_DIR} && cat > ${file}`, content);
}

/**
 * Boot the app on `name` and don't return until the Config screen reads it back. There is no
 * watcher to race, so a readback that hasn't shown is a slow first frame after the tab switch
 * rather than a stale config: each launch waits for it before going around again.
 */
async function activate(ctx: PresetContext, name: PresetName): Promise<void> {
  await writePreset(platformOf(ctx), name);
  const readback = ctx.screen.getByText(`preset: ${name}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    // A dead app is a valid starting state; see the metro channel's activatePreset.
    await ctx.device.terminateApp(BUNDLE_ID).catch(() => undefined);
    await ctx.device.launchApp(BUNDLE_ID);
    await ctx.screen.getByLabel("Config tab").tap();
    if (await readback.isVisible({ timeout: 10_000 })) return;
  }
  await expect(readback).toBeVisible();
}

/** No file means `default`, and removing it leaves nothing behind in the app's data. */
async function restore(ctx: Pick<PresetContext, "platform">): Promise<void> {
  await writePreset(platformOf(ctx), null);
}

export const dataFileChannel: PresetChannel = { activate, restore };
