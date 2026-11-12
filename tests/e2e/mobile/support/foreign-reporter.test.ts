import { describe, expect, test } from "vitest";
import { findForeignReporters, type ReporterIdentity } from "./foreign-reporter";

/** One batch's session envelope, as the mock ingest records it. */
const from = (
  os: string,
  sessionId: string,
  model = "iPhone 15"
): { __sessionAttributes: Record<string, unknown> } => ({
  __sessionAttributes: { os: { name: os }, device: { model }, session_id: sessionId },
});

describe("findForeignReporters", () => {
  test("accepts a run in which only the device under test reported", () => {
    const events = [from("ios", "session-a"), from("ios", "session-a"), from("ios", "session-a")];

    expect(findForeignReporters(events, "ios")).toEqual([]);
  });

  test("accepts an idle window in which nothing was reported at all", () => {
    expect(findForeignReporters([], "android")).toEqual([]);
  });

  /**
   * The cross-platform case: a simulator's `localhost` IS the host's, so an iOS
   * playground left running reaches the ingest of an Android run too.
   */
  test("flags a reporter on the other platform", () => {
    const events = [from("android", "session-a", "Pixel 7"), from("ios", "session-b")];

    const foreign = findForeignReporters(events, "android");
    expect(foreign).toHaveLength(1);
    expect(foreign[0]!.os).toBe("ios");
  });

  /**
   * A second SAME-PLATFORM device does identical damage but matches on
   * `os.name`, so the platform comparison waves it through — and `device.model` cannot
   * separate two simulators of one model either. What distinguishes them is that the
   * window is IDLE and post-clear, so the device under test owns exactly one session.
   */
  test("flags a second reporter on the SAME platform", () => {
    const events = [
      from("ios", "session-a"),
      from("ios", "session-a"),
      // A spare simulator, same OS and same model — indistinguishable except here.
      from("ios", "session-b"),
    ];

    const foreign = findForeignReporters(events, "ios");
    expect(foreign).toHaveLength(1);
    expect(foreign[0]!.sessionId).toBe("session-b");
  });

  /**
   * Which session is "ours" is decided by first arrival, so the report names the
   * intruder rather than accusing the device under test.
   */
  test("treats the session that reported first as the device under test", () => {
    const events = [from("ios", "ours"), from("ios", "theirs"), from("ios", "ours")];

    expect(findForeignReporters(events, "ios").map((r) => r.sessionId)).toEqual(["theirs"]);
  });

  test("reports each foreign session once, however many batches it sent", () => {
    const events = [
      from("ios", "ours"),
      from("ios", "theirs"),
      from("ios", "theirs"),
      from("ios", "theirs"),
    ];

    expect(findForeignReporters(events, "ios")).toHaveLength(1);
  });

  test("reports two intruders separately", () => {
    const events = [
      from("ios", "ours"),
      from("ios", "one"),
      from("android", "two", "Pixel 7"),
    ];

    const foreign: ReporterIdentity[] = findForeignReporters(events, "ios");
    expect(foreign.map((r) => r.sessionId).sort()).toEqual(["one", "two"]);
  });

  /**
   * Mobilewright types the driver's platform `'ios' | 'android' | undefined`. Comparing
   * anyway would mark EVERY batch foreign and fail the run on the gate's own ignorance, so
   * the platform half stands down and the session half carries on.
   */
  test("keeps checking sessions when the driver reports no platform", () => {
    const events = [from("ios", "ours"), from("android", "ours", "Pixel 7")];

    // Two platforms, one session: unjudgeable without a platform, so not flagged.
    expect(findForeignReporters(events, undefined)).toEqual([]);

    // A second session is still someone else, platform or no platform.
    expect(findForeignReporters([...events, from("ios", "theirs")], undefined)).toHaveLength(1);
  });

  test("ignores a batch that carries no session id", () => {
    const events = [from("ios", "ours"), { __sessionAttributes: { os: { name: "ios" } } }];

    expect(findForeignReporters(events, "ios")).toEqual([]);
  });
});
