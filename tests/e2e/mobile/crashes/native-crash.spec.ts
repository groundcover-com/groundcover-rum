import { test, expect } from "@mobilewright/test";
import {
  clearEvents,
  expectEvents,
  failNextBatches,
  getEvents,
  getStats,
  settleAndClear,
  waitForEvents,
} from "../support/ingest-client";
import { BUNDLE_ID } from "../support/app";


async function currentSessionId(): Promise<string> {
  const events = await getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const id = (events[i]!.__sessionAttributes as { session_id?: string } | undefined)?.session_id;
    if (id) return id;
  }
  return "";
}

// The claim that cannot be verified any other way: a crash is reported on the
// NEXT launch, under the session it actually happened in.
//
// Everything about that flow is cross-process — the handler writes a record
// while the app is dying, the snapshot on disk has to survive, and the next
// launch has to send it under an envelope that is NOT the fresh session's. Unit
// tests stub the native module, so only a real crash and relaunch proves it.
test.describe("rn-playground — native crash reporting", { tag: "@native" }, () => {
  // Disarm the ingest's failure injector no matter how the redelivery test below
  // exits. Without this, a test that fails between arming and disarming leaves the
  // ingest rejecting up to five more batches — which lands on whatever spec runs
  // next, whose events then never arrive and which fails for a reason that has
  // nothing to do with it.
  test.afterEach(async () => {
    await failNextBatches(0);
  });

  test("a native crash is reported on the next launch, under the crashed session", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(180_000); // a crash plus a cold relaunch of the JS bundle

    // Arrange: clear BEFORE the crash. Clearing after the relaunch would race
    // the drain, which fires immediately at init and would be deleted.
    await clearEvents();

    // Identify a user BEFORE the crash. The snapshot exists to carry the crashed
    // session's identity across the process death, and this is the one attribute
    // it exists to carry that session_id and screen alone cannot prove: both
    // survive a drain that rebuilds a bare envelope. Identity change re-pushes the
    // snapshot (onSessionIdentityChanged), so a crash drained on the next launch
    // must come back attributed to this user. Done on the Custom tab, then we
    // return to Native so the screen assertion below still pins the crash to where
    // it happened.
    await screen.getByLabel("Custom tab").tap();
    await screen.getByText("identifyUser").tap();

    await screen.getByLabel("Native tab").tap();
    // A tap both confirms the session (opening the send gate) and gets a batch
    // out so its id is readable.
    await screen.getByLabel("Block main thread").tap();
    await waitForEvents("interaction");

    // The blocked main thread above is a hang, and the watchdog reports it on
    // recovery. Asserted here rather than in a spec of its own because this is
    // the only place that already triggers one — and because it shares the
    // development-build gate with the crash trigger below, so if both go
    // silent, the gate is the suspect rather than the crash pipeline.
    const [hang] = await waitForEvents("exception", {
      timeout: 30_000,
      where: (e) => {
        const type = String((e.attributes as Record<string, unknown>)["error_type"] ?? "");
        return type === "ANR" || type === "AppHang";
      },
    });
    expect(hang).toBeTruthy();
    const hangAttrs = hang!.attributes as Record<string, unknown>;
    expect(hangAttrs["error_handled"]).toBe(false);
    expect(hangAttrs["error_metadata.native"]).toBe(true);
    // Recovered: the app came back, which is what separates this from an ANR
    // that killed the process and is only visible post-mortem.
    expect(hangAttrs["error_metadata.recovered"]).toBe(true);

    // A UNITS assertion: "> 0" would be satisfied by seconds, a tick count or a
    // garbage monotonic delta, and the two platforms convert independently.
    //
    // Bounded by the configured `hangThresholdMs` (1s) rather than the trigger's 3s
    // sleep, because the reported duration is not the block's — iOS anchors on the
    // last heartbeat, Android on when its watchdog posted the probe, so the same 3s
    // block legitimately reports ~1000-3500ms, and a bound guessed from the sleep
    // would sit inside that range. Both platforms DO guarantee the threshold, and a
    // seconds-valued reading would be 3, so it separates the units.
    const hangMs = Number(hangAttrs["error_metadata.hang_duration_ms"] ?? 0);
    expect(hangMs).toBeGreaterThanOrEqual(1_000);
    expect(hangMs).toBeLessThan(30_000);

    // Epoch milliseconds, and recent — not uptime, not seconds.
    const hangStart = Number(hangAttrs["error_metadata.hang_started_at"] ?? 0);
    expect(hangStart).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect(hangStart).toBeLessThanOrEqual(Date.now());

    const crashedSessionId = await currentSessionId();
    expect(crashedSessionId).not.toBe("");

    // Let the snapshot's debounced disk write land before killing the process.
    await new Promise((r) => setTimeout(r, 2_000));

    // Act: crash for real, then relaunch.
    await screen.getByLabel("Crash natively").tap();
    await new Promise((r) => setTimeout(r, 3_000)); // the process dies
    // Everything the drain does happens after this instant, which is what makes it a usable
    // boundary for the timestamp assertion below.
    const relaunchedAtMs = Date.now();
    await device.launchApp(BUNDLE_ID);

    // Assert: the exception arrives stamped with the PREVIOUS session.
    // Key on `fatal`, not on `native`: the hang this test triggers above is also
    // a native exception, and matching on `native` alone finds the ANR and
    // declares victory while the crash pipeline is entirely broken.
    const nativeCrash = (
      await waitForEvents("exception", {
        timeout: 60_000,
        where: (e) => (e.attributes as Record<string, unknown>)["error_metadata.fatal"] === true,
      })
    )[0];
    expect(nativeCrash).toBeTruthy();

    const attrs = nativeCrash!.attributes as Record<string, unknown>;
    expect(attrs["error_handled"]).toBe(false);
    expect(attrs["error_metadata.native"]).toBe(true);
    expect(attrs["error_metadata.fatal"]).toBe(true);
    // Stable across redeliveries, so a duplicate can be recognised.
    expect(String(attrs["error_metadata.crash_report_id"] ?? "")).not.toBe("");
    // Which capture produced it: KSCrash, the JVM handler, or a post-mortem
    // ApplicationExitInfo reconstruction. They carry different fidelity, and a
    // crash that silently downgraded from one to another is worth seeing.
    expect(String(attrs["error_metadata.crash_source"] ?? "")).not.toBe("");

    // A STACK. If the mapper cannot find the crashed thread — a renamed KSCrash
    // key, an empty thread list — the event still arrives with the right session,
    // the right timestamp and the right crash report id, and is useless on
    // arrival. Every other assertion here passes on a zero-frame crash.
    //
    // Wire shape is an array whose object elements carry PREFIXED dotted keys
    // (see wire-format-golden.test.ts) — that is the de-facto backend contract,
    // not a bug to normalize away.
    const frames = attrs["error_stacktrace"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(frames)).toBe(true);
    expect(frames!.length).toBeGreaterThanOrEqual(3);
    // Frame 0 is a symbol plus offset or, on a stripped iOS build, the image plus
    // offset — both are real frames, so assert it is not empty rather than pinning one.
    expect(String(frames![0]!["error_stacktrace[0].function"] ?? "")).not.toBe("");
    expect(String(frames![0]!["error_stacktrace[0].filename"] ?? "")).not.toBe("");

    const envelope = nativeCrash!.__sessionAttributes as
      | { session_id?: string; user?: { id?: string } }
      | undefined;
    expect(envelope?.session_id).toBe(crashedSessionId);

    // The user identified before the crash, carried across the process death by
    // the same snapshot. This is why the snapshot stores the whole session
    // envelope and not just the id: a drain that reassembled a bare envelope
    // would still pass session_id and screen while silently dropping the user,
    // and every crash in the product would arrive anonymous.
    expect(envelope?.user?.id).toBe("user-123");

    // Attributed to the screen the user was ON when it crashed, not to the
    // screen the drain happened to open on. The snapshot is re-pushed on every
    // screen change precisely so this survives the process dying, and nothing
    // else asserts it: a snapshot that stopped being re-pushed would attribute every
    // crash in the product to whatever screen the app launches into, which reads
    // as a plausible bug report rather than as missing data.
    //
    // Nested, like every other event's screen stamp (the drain builds a local
    // enricher for exactly this reason), so read the object.
    const crashScreen = attrs["screen"] as { name?: string } | undefined;
    expect(crashScreen?.name).toBe("Native");

    // WHEN IT CRASHED, not when it was drained — and in the right units.
    // A units error here is invisible to every other assertion: the event still
    // arrives, still carries the right session, and is simply stamped in the
    // wrong millennium. iOS reads a microsecond field from KSCrash and Android
    // an epoch-milli one, so only an absolute check catches either side
    // drifting. The crash happened seconds ago, within this test.
    const crashMs = Number(nativeCrash!.timestamp) / 1e6;
    expect(crashMs).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect(crashMs).toBeLessThan(Date.now() + 60_000);
    // STRICTLY BEFORE THE RELAUNCH, which is the part an absolute window cannot check. Every
    // coercion at the bridge's trust boundary turns a broken field into a plausible value rather
    // than an error: rename `crashEpochMs` on either platform and `toCrashRecord` yields NaN,
    // `timestamp || now` substitutes the DRAIN time, and a "recent" assertion still passes because
    // the drain is recent. Only a boundary the drain cannot be on the right side of separates the
    // two.
    expect(crashMs).toBeLessThan(relaunchedAtMs);

    // NOT THE FALLBACKS. `buildAttributes` substitutes "NativeCrash" / "Native crash" for a
    // missing type or message — correct behaviour for a record written by an older SDK version,
    // and indistinguishable from a field the native mapper renamed. Asserting the negative rather
    // than an exact string keeps this honest across platforms, where the values legitimately
    // differ: a JVM throwable class on Android, an NSException name or mach exception on iOS.
    expect(String(attrs["error_type"] ?? "")).not.toBe("");
    expect(String(attrs["error_type"] ?? "")).not.toBe("NativeCrash");
    expect(String(attrs["error_message"] ?? "")).not.toBe("");
    expect(String(attrs["error_message"] ?? "")).not.toBe("Native crash");

    // Android can go further, because its side is deterministic: `triggerTestCrash` throws
    // `IllegalStateException("groundcover test crash (native)")`, so the throwable's class and
    // message must both survive the mapper. iOS crashes on a bad pointer write, where KSCrash
    // reports a signal rather than an exception — there is no author-supplied message to match, and
    // the negatives above are the strongest portable form.
    if (platform === "android") {
      expect(String(attrs["error_type"])).toContain("IllegalStateException");
      expect(String(attrs["error_message"])).toContain("groundcover test crash");
    }
  });

  // The delivery GUARANTEE, which the test above cannot touch — it only sees the happy
  // path. The drain is at-least-once: it observes the real POST outcome and keeps the
  // record until one is confirmed. Unit tests cover that against a stubbed sender; only
  // a real crash, rejection and three real launches prove the record survived on disk.
  //
  // Both halves fail in opposite directions: losing the retry loses crashes silently,
  // losing the ACK re-reports the same crash forever and inflates the
  // crash-free-session denominator.
  test("a rejected crash is redelivered on the next launch, and only once", async ({
    screen,
    device,
  }) => {
    test.setTimeout(300_000); // a crash plus three cold relaunches

    await settleAndClear();
    // Leave no armed injector behind from an earlier failed run.
    await failNextBatches(0);

    await screen.getByLabel("Native tab").tap();
    // Confirm the session so the pre-crash envelope is real, and get its id out.
    await screen.getByText("Row 3").tap();
    await waitForEvents("interaction", { timeout: 30_000 });
    const crashedSessionId = await currentSessionId();
    expect(crashedSessionId).not.toBe("");

    // Let the snapshot's debounced disk write land before killing the process.
    await new Promise((r) => setTimeout(r, 2_000));

    // Arm the ingest to REJECT everything until this test disarms it. The count is far
    // larger than the batches expected because the injector counts down on EVERY POST,
    // not the drain's — ordinary traffic (a tap, a vitals batch) otherwise consumes the
    // rejections and the drain's POST arrives as the first ACCEPTED one; a small count
    // is used up by a couple of extra vitals batches.
    //
    // Clear again HERE, so "nothing was accepted" means since the rejecting began. The
    // window between is tens of seconds on a slow device, and the app is running its
    // crash drain in it — a fatal delivered there is legitimately accepted and would
    // read as a crash that escaped. `DELETE /__e2e/events` resets the counters while
    // leaving fail-next armed.
    await settleAndClear();

    // Safe because the afterEach disarms unconditionally.
    const armed = await failNextBatches(200, 500);
    expect(armed.failRemaining).toBe(200);

    // Act I: crash, then relaunch into a rejecting ingest.
    await screen.getByLabel("Crash natively").tap();
    await new Promise((r) => setTimeout(r, 3_000));
    await device.launchApp(BUNDLE_ID);

    // Assert I: the drain TRIED and was refused. Waiting on the rejection
    // (rather than sleeping) keeps this honest — a drain that never fired would
    // leave rejectedBatches at 0 and fail here rather than pass by silence.
    const deadline = Date.now() + 60_000;
    let rejectedSeen = 0;
    while (Date.now() < deadline) {
      rejectedSeen = (await getStats()).rejectedBatches;
      if (rejectedSeen > 0) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // > 0 means the drain fired and was refused. A drain that never ran at all
    // leaves this at 0 and fails here, rather than passing by silence.
    expect(rejectedSeen).toBeGreaterThan(0);

    // ...and nothing was ACCEPTED, so the backend has not seen this crash.
    const acceptedWhileFailing = (await getEvents()).filter(
      (e) =>
        e.type === "exception" &&
        (e.attributes as Record<string, unknown>)["error_metadata.fatal"] === true
    );
    expect(acceptedWhileFailing).toHaveLength(0);

    // Act II: heal the ingest and relaunch. The record must still be on disk.
    await failNextBatches(0);
    await device.terminateApp(BUNDLE_ID);
    await device.launchApp(BUNDLE_ID);

    const [redelivered] = await expectEvents("exception", {
      timeout: 90_000,
      where: (e) => (e.attributes as Record<string, unknown>)["error_metadata.fatal"] === true,
      describe: "the crash redelivered after the rejection",
    });
    expect(redelivered).toBeTruthy();

    // Still the crashed session's envelope, two launches later — the snapshot has
    // to survive the failed attempt, not just the crash.
    const envelope = redelivered!.__sessionAttributes as { session_id?: string } | undefined;
    expect(envelope?.session_id).toBe(crashedSessionId);

    const redeliveredId = String(
      (redelivered!.attributes as Record<string, unknown>)["error_metadata.crash_report_id"] ?? ""
    );
    expect(redeliveredId).not.toBe("");

    // Act III: a third launch. Now that a POST was confirmed, the record must be
    // gone. This is the assertion that fails if `clearPendingCrashReports` is
    // never reached — and the one no other spec can make, because it needs a
    // launch AFTER a successful drain.
    // settleAndClear, NOT clearEvents: the drain that just succeeded is
    // at-least-once, so a duplicate of ITS OWN batch can still be in flight. A
    // bare clear would let that straggler land after the clear and be counted as
    // a third-launch re-report — accusing the SDK of a bug the harness invented.
    // Waiting for quiet first makes anything seen below genuinely new.
    await settleAndClear();
    await device.terminateApp(BUNDLE_ID);
    await device.launchApp(BUNDLE_ID);
    // Long enough for a drain to have happened: the redelivery above landed
    // within this budget from a cold start, so silence here is meaningful.
    await new Promise((r) => setTimeout(r, 30_000));

    const repeats = (await getEvents()).filter(
      (e) =>
        e.type === "exception" &&
        String((e.attributes as Record<string, unknown>)["error_metadata.crash_report_id"] ?? "") ===
          redeliveredId
    );
    // An acked crash must never be reported again.
    expect(repeats).toHaveLength(0);
  });

  // NOTE: there is no e2e for "a crash after the session snapshot is cleared". On
  // device a crash with no snapshot is not reported at all (it belongs to no
  // session), so there is no attribution to assert. The clear-then-resurrect race the
  // snapshot store's write lock guards is only provable at the unit tier, via the
  // injected clock and writer the store tests use — which is where it lives.
});
