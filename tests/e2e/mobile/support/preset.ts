import type { Screen } from "@mobilewright/core";
import { app } from "./app";
import { dataFileChannel } from "./preset-data-file";
import { metroChannel } from "./preset-metro";

// Spec-side control of the app's init-time config — the mobile answer to the browser suite's
// `?gcp=` override. One channel per app, picked once below from support/app.ts:
//
// - metro-source (RN, support/preset-metro.ts) rewrites the compiled-in preset, lets Metro
//   re-bundle, and relaunches.
// - data-file (Flutter and the native apps, support/preset-data-file.ts) writes a file the app
//   reads before init, and relaunches.
//
// Either way, activation is gated on the app reading its own preset back.

// Deliberately NOT the app's full `PresetName` union: the app also has `device`, for a real
// phone against a real cluster, and this harness must never select it. It points the SDK at
// whatever `.env` names, so activating it would send a test run's events to a real ingest and
// leave every mock-ingest assertion looking at an empty recorder. Resist "syncing" the two
// lists — the difference is the safeguard.
export type PresetName =
  | "default"
  | "unsampled"
  | "mask-all"
  | "allow"
  | "hang-sampling"
  | "no-body-mask"
  | "custom-redact"
  | "callbacks"
  | "callbacks-throw"
  | "crashes-only"
  | "tti-manual"
  | "slow-flush"
  | "vitals-fast";

/** Only the launcher API the channels need — avoids importing mobilewright's Device. */
export type Launcher = {
  terminateApp: (bundleId: string) => Promise<void>;
  launchApp: (bundleId: string) => Promise<void>;
};

/** The test's own fixtures, passed through. Only the data-file channel reads `platform`. */
export type PresetContext = {
  screen: Screen;
  device: Launcher;
  platform: "ios" | "android" | undefined;
};

export type PresetChannel = {
  activate(ctx: PresetContext, name: PresetName): Promise<void>;
  restore(ctx: Pick<PresetContext, "platform">): Promise<void>;
};

const channel: PresetChannel = {
  "metro-source": metroChannel,
  "data-file": dataFileChannel,
}[app.presetChannel];

/** Boot the app on `name` and don't return until the app confirms it. */
export function activatePreset(ctx: PresetContext, name: PresetName): Promise<void> {
  return channel.activate(ctx, name);
}

/**
 * Put the preset back to "default".
 *
 * Called from an afterEach so a failed spec cannot leave the next one running on someone else's
 * config. It does not relaunch — the next launch is what picks the default up, and every preset
 * spec gates on its OWN preset, so the two cannot be confused. Spec files that use presets live in
 * `zz-perturbing/` so they sort last and nothing from the ordinary suites can run behind them
 * mid-run.
 */
export function restoreDefaultPreset(ctx: Pick<PresetContext, "platform">): Promise<void> {
  return channel.restore(ctx);
}
