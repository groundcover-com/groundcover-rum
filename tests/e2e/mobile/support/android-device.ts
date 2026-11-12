import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Device queries the harness does not expose. Mobilewright/mobilecli speak a fixed
// RPC vocabulary (tap, swipe, text, screenshot, view tree …) with no passthrough
// for `adb`, and a spec occasionally needs to know something about the DEVICE
// rather than about the app — see `androidRendererIsSoftware`.

/** adb from the SDK the environment points at, else from PATH. */
export function adbBinary(): string {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    (root): root is string => !!root
  );
  for (const root of roots) {
    const candidate = join(root, "platform-tools", "adb");
    if (existsSync(candidate)) return candidate;
  }
  // CI runners and most dev shells have it on PATH; if not, callers below treat a
  // failure as "unknown" rather than failing the test.
  return "adb";
}

/**
 * `adb shell` against the only attached device (ANDROID_SERIAL is honoured by adb
 * itself). The e2e always runs against exactly one, asserted by preflight.ts.
 */
export async function adbShell(args: string[]): Promise<string> {
  const { stdout } = await run(adbBinary(), ["shell", ...args], { timeout: 20_000 });
  return stdout;
}

/**
 * Run `script` through `sh` as the app's own user, in its data directory, with `stdin` fed to it:
 * how the harness writes into a sandbox `adb push` can't reach. `run-as` works on debuggable builds
 * only. The script travels single-quoted, so it must not contain a `'`.
 */
export async function androidRunAs(packageName: string, script: string, stdin = ""): Promise<void> {
  const pending = run(adbBinary(), ["shell", `run-as ${packageName} sh -c '${script}'`], {
    timeout: 20_000,
  });
  pending.child.stdin?.end(stdin);
  await pending;
}

/**
 * A build property straight from the device, or `""` if it cannot be read.
 *
 * The point is to have a source of truth the SDK did not produce. Asserting that
 * `device.model` is merely non-empty passes on a hardcoded string, a stale constant, or the
 * fallback sentinel — `"unknown"` is a non-empty string, so a permanently unknown model would
 * pass. Comparing against `getprop` instead checks the value, not just its presence.
 */
export async function androidProp(name: string): Promise<string> {
  try {
    return (await adbShell(["getprop", name])).trim();
  } catch {
    return "";
  }
}

/** PID of a package's main process, or 0 when it is not running. */
export async function androidPidOf(packageName: string): Promise<number> {
  try {
    const out = await adbShell(["ps", "-A"]);
    const line = out.split("\n").find((l) => l.trim().endsWith(packageName));
    return line ? Number(line.trim().split(/\s+/)[1]) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Linux process state letter — "S" sleeping, "T" stopped, "" unknown/gone. */
export async function androidProcessState(pid: number): Promise<string> {
  try {
    const out = await adbShell(["cat", `/proc/${pid}/status`]);
    const line = out.split("\n").find((l) => l.startsWith("State:")) ?? "";
    return line.split(/\s+/)[1] ?? "";
  } catch {
    return "";
  }
}

/**
 * Suspend / resume every thread in a process — what Android's cached-app freezer does
 * to a backgrounded app. Needed because the freezer skips DEBUGGABLE processes, so a
 * backgrounded dev build is never actually suspended (even with `use_freezer=true`).
 * SIGSTOP is the same mechanism and is reachable from the driver. Requires `adb root`,
 * which google_apis allows.
 */
export async function androidFreezeProcess(pid: number): Promise<void> {
  await adbShell(["kill", "-STOP", String(pid)]);
}

export async function androidUnfreezeProcess(pid: number): Promise<void> {
  await adbShell(["kill", "-CONT", String(pid)]);
}

/**
 * Names are TRUNCATED TO 15 CHARACTERS before matching, because that is what the kernel
 * stores (`comm` is `TASK_COMM_LEN` 16, including the NUL): `ps -T` reports
 * `gc-rum-snapshot-flush` as `gc-rum-snapshot`. Matching the full name returns 0 for
 * every name long enough to matter, which reads as "never started".
 */
const LINUX_COMM_MAX = 15;

/** The counting itself, over `ps -T` output — pure, so the truncation rule above
 *  is pinned by a unit test rather than by a device run. */
export function countNamedThreads(psOutput: string, threadName: string): number {
  const asKernelSeesIt = threadName.slice(0, LINUX_COMM_MAX);
  return psOutput.split("\n").filter((line) => line.trim().endsWith(asKernelSeesIt)).length;
}

/**
 * Raises when adb cannot answer, rather than reporting a sentinel. A sentinel such as
 * `-1` would SATISFY `engine-teardown.spec.ts`'s `toBeLessThanOrEqual(1)` bound on the
 * lazily-created flush thread — so a query that never ran would pass the assertion
 * meant to catch the leak. `shell` is injectable for the unit test and nothing else.
 */
export async function androidThreadCount(
  pid: number,
  threadName: string,
  shell: (args: string[]) => Promise<string> = adbShell
): Promise<number> {
  try {
    return countNamedThreads(await shell(["ps", "-T", "-p", String(pid)]), threadName);
  } catch (error) {
    throw new Error(
      `could not count "${threadName}" threads in pid ${pid}: ${(error as Error).message}. ` +
        `An unmeasured process is not a clean one — failing rather than reporting a count.`
    );
  }
}

/**
 * Reload the JS bundle, recreating the React instance IN PLACE — the process survives,
 * which is what makes per-instance leaks observable. `RELOAD_APP_ACTION` is what
 * DevSupportManager listens for, so this is dev-build only. Fast Refresh is NOT a
 * substitute: HMR never tears the instance down, so `invalidate()` never runs.
 */
export async function androidReloadJs(packageName: string): Promise<void> {
  await adbShell(["am", "broadcast", "-a", `${packageName}.RELOAD_APP_ACTION`]);
}

/** Whether adbd is root, hence whether SIGSTOP against an app process will work. */
export async function androidCanFreeze(): Promise<boolean> {
  try {
    return /uid=0\(root\)/.test(await adbShell(["id"]));
  } catch {
    return false;
  }
}

let cached: boolean | undefined;

/**
 * A drag through `adb input swipe`, which takes the duration as its fifth argument.
 * mobilecli drives input through an on-device agent (since 1.0.11); the fling spec's
 * thresholds assume `adb input swipe`'s pacing, so it drives that directly (see that
 * spec). Coordinates are device PIXELS, as elsewhere in this module.
 */
export async function androidSwipe(
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number
): Promise<void> {
  await adbShell([
    "input",
    "swipe",
    String(Math.round(from.x)),
    String(Math.round(from.y)),
    String(Math.round(to.x)),
    String(Math.round(to.y)),
    String(Math.round(durationMs)),
  ]);
}

/**
 * Whether this device rasterizes in SOFTWARE, which decides whether the OS can recognize a fling
 * at all: a GPU-less emulator paints at 150-300ms per frame and motion samples arrive at frame
 * cadence, further apart than VelocityTracker's ~100ms horizon, so the same AVD reports every
 * drag a `scroll` under swiftshader and a `swipe` under `-gpu host`.
 *
 * Keyed on the renderer, not `process.env.CI`, so a developer reproducing CI locally gets CI's
 * answer. Unknown reads as `false`, so a spec that cannot prove the platform incapable still runs.
 */
export async function androidRendererIsSoftware(): Promise<boolean> {
  if (cached !== undefined) return cached;
  try {
    const out = await adbShell(["dumpsys", "SurfaceFlinger"]);
    const gles = out.split("\n").find((line) => line.startsWith("GLES:")) ?? "";
    cached = /swiftshader/i.test(gles);
  } catch {
    cached = false;
  }
  return cached;
}
