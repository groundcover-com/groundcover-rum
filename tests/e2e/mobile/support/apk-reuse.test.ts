import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The apk-reuse rule from `ci-android-e2e.sh`, run as the shell actually runs it.
 *
 * Reusing an apk is the difference between testing the binary this branch produces and testing
 * whatever a previous run happened to leave behind — and the failure is silent either way, since
 * the suite runs and reports as normal against the wrong native code. That makes it worth a test
 * even though the surrounding script is untestable device plumbing.
 *
 * Nothing here touches a device or the repo's own artifacts directory: the function takes the apk
 * path as an argument and the test points it at a temp file.
 */

const RULE = path.resolve(__dirname, "../apk-reuse.sh");

/** Runs `should_reuse_apk` under the given environment. True = install what is there. */
function reuses(apkPath: string, env: Record<string, string | undefined>): boolean {
  const status = execFileSync(
    "bash",
    ["-c", `. "${RULE}"; should_reuse_apk "${apkPath}" && echo reuse || echo build`],
    {
      // A bare env, so the developer's own shell cannot decide the outcome — an exported
      // CI or APK_CACHE_HIT would otherwise make this pass or fail by accident.
      env: { PATH: process.env.PATH ?? "", ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
    }
  ).trim();
  return status === "reuse";
}

describe("should_reuse_apk", () => {
  let dir: string;
  let apk: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "apk-reuse-"));
    apk = path.join(dir, "app-debug.apk");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A leftover apk is what makes this dangerous: `artifacts/` is gitignored, so it survives. */
  function leaveStaleApk() {
    mkdirSync(path.dirname(apk), { recursive: true });
    writeFileSync(apk, "not really an apk");
  }

  /**
   * The stale-apk case. A developer runs the script, it builds and stashes the apk in the
   * gitignored `apps/rn-playground/artifacts/android/`. They then change something NATIVE —
   * switch branches, or bump react-native-screens, whose `android/src/main/cpp/NativeProxy.cpp`
   * is compiled in — and re-run. Gated on the file alone, the script would reinstall the previous
   * binary and run the whole suite against native code that predates the change, with nothing to
   * invalidate it.
   *
   * On CI the apk is keyed on the native sources by the workflow's restore step; locally there is
   * no key at all, so the file's existence says nothing about whether it is current.
   */
  it("rebuilds when a stale apk is all that is there", () => {
    leaveStaleApk();
    expect(reuses(apk, {})).toBe(false);
  });

  /**
   * CI parity, which the stale-apk check must not cost. `Restore prebuilt Android app` places an
   * apk keyed on the native sources (on a cache miss, the download of this run's build does) and
   * `Verify the prebuilt apk is present` hard-fails without one, so on a runner the file IS the
   * right one — and the reuse also has to survive a re-run,
   * which has the same env as the first attempt. GITHUB_ACTIONS rather than CI: this script sets
   * `CI=false` for the Metro subshell on purpose, and a developer may well export CI locally.
   */
  it("reuses the restored apk on a GitHub runner", () => {
    leaveStaleApk();
    expect(reuses(apk, { GITHUB_ACTIONS: "true" })).toBe(true);
  });

  /** The local opt-in the e2e README (tests/e2e/mobile/README.md) documents. */
  it("reuses when the developer opts in explicitly", () => {
    leaveStaleApk();
    expect(reuses(apk, { APK_CACHE_HIT: "true" })).toBe(true);
  });

  it("builds when there is no apk at all, whatever the environment says", () => {
    expect(reuses(apk, { GITHUB_ACTIONS: "true", APK_CACHE_HIT: "true" })).toBe(false);
  });
});
