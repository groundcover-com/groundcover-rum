import { execFile } from "node:child_process";

// Fail-fast guard so the suite errors in seconds with actionable guidance
// instead of hanging when its preconditions aren't met. `mobilewright test`
// connects to an ALREADY-booted device and launches the app by bundleId — it
// does not boot a simulator, build, install or start Metro. If no device is up,
// it would otherwise wait indefinitely (the #1 "it hangs" cause).
//
// Skippable with MW_SKIP_PREFLIGHT=1 in case device discovery ever false-negatives.

export class PreflightError extends Error {}

function runMobilewrightDevices(timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      "node_modules/.bin/mobilewright",
      ["devices"],
      { timeout: timeoutMs, cwd: process.cwd() },
      (_err, stdout, stderr) => resolve(`${stdout ?? ""}\n${stderr ?? ""}`)
    );
    child.on("error", () => resolve(""));
  });
}

const GUIDANCE = [
  "No booted simulator/emulator found — `mobilewright test` needs a device already running.",
  "",
  "Run the e2e in order (RN shown; every app: tests/e2e/mobile/README.md#run-locally):",
  "  1. pnpm --filter @groundcover/react-native build",
  "  2. pnpm --filter rn-playground run e2e:app:ios      # or e2e:app:android — boots+builds+installs+launches, starts Metro",
  "  3. pnpm run e2e:rn:ios                               # or e2e:rn:android   (this step)",
  "",
  "Check tooling with: node_modules/.bin/mobilewright doctor",
  "(Set MW_SKIP_PREFLIGHT=1 to bypass this check.)",
].join("\n");

export async function assertDeviceAvailable(): Promise<void> {
  if (process.env.MW_SKIP_PREFLIGHT === "1") return;
  const output = await runMobilewrightDevices();
  // The CLI prints "No devices found …" when nothing is booted. Treat an empty
  // or that-message result as "no device".
  const hasNoDevice = output.trim() === "" || /no devices found/i.test(output);
  if (hasNoDevice) {
    throw new PreflightError(GUIDANCE);
  }
}
