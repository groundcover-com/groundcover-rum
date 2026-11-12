import { describe, expect, test } from "vitest";
import { androidThreadCount, countNamedThreads } from "./android-device";

/** What `ps -T -p <pid>` looks like, trimmed to the columns that matter. */
const PS_OUTPUT = [
  "USER    PID   TID CMD",
  "u0_a123 4242  4242 com.groundcover.rumplayground",
  "u0_a123 4242  4301 gc-rum-engine",
  "u0_a123 4242  4302 gc-rum-snapshot",
  "u0_a123 4242  4303 gc-rum-anr-watc",
  "u0_a123 4242  4304 RenderThread",
].join("\n");

describe("countNamedThreads", () => {
  test("counts a thread whose name fits within the kernel's limit", () => {
    expect(countNamedThreads(PS_OUTPUT, "gc-rum-engine")).toBe(1);
  });

  /**
   * `comm` is TASK_COMM_LEN (16) including the NUL, so the kernel stores only the
   * first 15 characters. Matching the full name finds nothing, which reads as
   * "the thread was never started" and fails a leak test at its baseline — before
   * it has measured anything at all.
   */
  test("matches the truncated name the kernel actually stores", () => {
    expect("gc-rum-snapshot-flush".length).toBeGreaterThan(15);
    expect(countNamedThreads(PS_OUTPUT, "gc-rum-snapshot-flush")).toBe(1);
  });

  test("reports zero for a thread that is genuinely absent", () => {
    expect(countNamedThreads(PS_OUTPUT, "gc-rum-nonexistent")).toBe(0);
  });
});

describe("androidThreadCount", () => {
  test("returns the count when adb answers", async () => {
    const count = await androidThreadCount(4242, "gc-rum-engine", async () => PS_OUTPUT);
    expect(count).toBe(1);
  });

  /**
   * The reason this file exists. Were `androidThreadCount` to answer `-1` when adb fails,
   * `engine-teardown.spec.ts`'s `toBeLessThanOrEqual(1)` leak bound would be satisfied, so a
   * query that never ran would pass the check meant to catch the leak. The suite's other
   * assertions reject the sentinel by construction, so this bound (whose baseline is
   * deliberately unasserted, the thread being lazy) is the only hiding place.
   */
  test("raises rather than reporting a count adb never produced", async () => {
    await expect(
      androidThreadCount(4242, "gc-rum-snapshot-flush", async () => {
        throw new Error("adb: device offline");
      })
    ).rejects.toThrow(/device offline/);
  });

  /** The raised error has to name the thread, or a red run says only "adb failed". */
  test("names the thread it could not count", async () => {
    await expect(
      androidThreadCount(4242, "gc-rum-engine", async () => {
        throw new Error("adb: device offline");
      })
    ).rejects.toThrow(/gc-rum-engine/);
  });
});
