import { test, expect } from "@mobilewright/test";
import { getEvents, screenKey, screenName, settleAndClear, waitForEvents } from "../support/ingest-client";
import { expectTapped, tapScrolling } from "../support/ui";

// The public methods no other spec calls: identifyUser, sendCustomEvent,
// captureException, logger.* and startNavigationTracking are covered elsewhere,
// and the browser suite verifies its own window-object API surface.
test.describe("rn-playground — public API", () => {
  test("setSessionId adopts the id it was given, and getSessionId reports it", async ({
    screen,
  }) => {
    test.setTimeout(150_000);

    await settleAndClear();
    // Confirm the session first: an unconfirmed session sends nothing, and this
    // spec reads the id off the wire.
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction", { timeout: 30_000 });

    await screen.getByLabel("Config tab").tap();
    await tapScrolling(screen, "setSessionId fixed");

    // No expectTapped here, deliberately: this is the one button whose own action
    // perturbs what expectTapped reads. setSessionId rotates the session, and the
    // interaction event for the tap that triggered it does not arrive: the buffer
    // belongs to the session being replaced, so the last interaction before a
    // setSessionId call is dropped. So the tap is confirmed by its EFFECT below
    // instead: the fixed id appearing on the wire is impossible unless the button
    // was pressed.

    // A FIXED id, so this asserts adoption rather than mere rotation — the
    // difference between "the SDK used the id I gave it" (what a host integrating
    // with its own analytics needs) and "the SDK changed its id", which any
    // rotation bug also satisfies.
    await settleAndClear();
    await screen.getByLabel("Taps tab").tap();
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction", { timeout: 30_000 });

    const events = await getEvents();
    const ids = new Set(
      events.map((e) => (e.__sessionAttributes as { session_id?: string } | undefined)?.session_id)
    );
    expect([...ids]).toContain("e2e-fixed-session-id");

    // ...and the getter agrees with the wire. A getter reading a different field
    // than the transport does is a silent inconsistency for anyone correlating
    // RUM with their own logs.
    await screen.getByLabel("Config tab").tap();
    await tapScrolling(screen, "show session id");
    await expect(screen.getByText(/Session: e2e-fixed-session-id/)).toBeVisible();
  });

  test("updateConfig({ user: null }) clears an identity that was already stamped", async ({
    screen,
  }) => {
    test.setTimeout(150_000);

    await settleAndClear();

    // Establish an identity, and prove it reached the envelope — otherwise the
    // clear below is asserting against nothing.
    await screen.getByLabel("Custom tab").tap();
    await tapScrolling(screen, "identifyUser");
    await tapScrolling(screen, "sendCustomEvent");
    await waitForEvents("custom", { timeout: 30_000 });
    const identified = (await getEvents()).some(
      (e) => ((e.__sessionAttributes as { user?: { id?: string } })?.user)?.id === "user-123"
    );
    expect(identified).toBe(true);

    // Act: clear it. `user: null` is the documented clear — distinct from omitting
    // the key, which leaves the identity in place. A logout that does not actually
    // clear attributes the next user's session to the previous one, which is a
    // privacy problem rather than a cosmetic one.
    await screen.getByLabel("Config tab").tap();
    await tapScrolling(screen, "clear identity");
    await expectTapped("clear identity");

    await settleAndClear();
    await screen.getByLabel("Custom tab").tap();
    await tapScrolling(screen, "sendCustomEvent");
    await waitForEvents("custom", { timeout: 30_000 });

    const after = await getEvents();
    expect(after.length).toBeGreaterThan(0);
    for (const event of after) {
      const user = (event.__sessionAttributes as { user?: { id?: string } } | undefined)?.user;
      expect(user?.id ?? "").not.toBe("user-123");
    }
  });

  test("the manual navigation API emits a named navigation, and drops an unnamed one", async ({
    screen,
  }) => {
    test.setTimeout(150_000);

    await settleAndClear();
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction", { timeout: 30_000 });

    await screen.getByLabel("Config tab").tap();
    await settleAndClear();
    await tapScrolling(screen, "manual navigation");

    // start + end are the API a host without React Navigation uses, so they have
    // to work independently of the automatic tracker every other navigation
    // assertion in this suite goes through. Keyed on the screen NAME the call
    // supplied, so a stray tab-switch navigation cannot satisfy it.
    const [manual] = await waitForEvents("navigation", {
      timeout: 30_000,
      where: (e) => screenName(e) === "ManualScreen",
    });
    expect(manual).toBeTruthy();
    const attrs = manual!.attributes as Record<string, unknown>;
    expect(screenKey(manual!)).toBe("manual-1");
    // A real measured duration, and the caller's metadata merged from both halves
    // of the call — the reason the manual API exists is to carry that context.
    expect(Number(attrs["duration_ms"] ?? -1)).toBeGreaterThanOrEqual(0);
    expect(attrs["metadata.e2e_manual"]).toBe("end");

    // The other half of the contract, and the one worth protecting: a manual
    // navigation with NO screen name emits nothing at all. The tracker drops it
    // deliberately ("never ship an empty-screen record") because a screenless
    // navigation is unattributable and would still count towards every
    // per-screen metric. Easy to "fix" into existence by someone
    // who reads the drop as a bug.
    await settleAndClear();
    await tapScrolling(screen, "manual navigation unnamed");

    // Long enough that an unnamed navigation would have flushed (10x the batch
    // timer) — this button's OWN interaction event is not a usable signal, because
    // it does not reliably arrive on iOS, so waiting for it would test the harness
    // rather than the SDK.
    await new Promise((r) => setTimeout(r, 5_000));
    const unnamed = (await getEvents()).filter((e) => e.type === "navigation");
    expect(unnamed).toHaveLength(0);

    // The control that stops the above being vacuous: press the NAMED button again,
    // on the same screen, moments later. If a navigation arrives now then onPress
    // handlers on this screen plainly work and the tracker is live — so the silence
    // above was the empty-name guard doing its job, not a dead app or a tap that
    // never landed. Deliberately not a tab switch, which would itself emit a
    // navigation and destroy the assertion it is meant to support.
    await tapScrolling(screen, "manual navigation");
    const [again] = await waitForEvents("navigation", {
      timeout: 30_000,
      where: (e) => screenName(e) === "ManualScreen",
    });
    expect(again).toBeTruthy();
  });

  test("stopNavigationTracking really stops it", async ({ screen }) => {
    test.setTimeout(150_000);

    await settleAndClear();
    await screen.getByLabel("Config tab").tap();
    await tapScrolling(screen, "stopNavigationTracking");
    await expectTapped("stopNavigationTracking");

    await settleAndClear();

    // Navigate for real. Tab switches are the automatic tracker's bread and
    // butter, and every one of them produced a navigation event in
    // navigation.spec.ts.
    await screen.getByLabel("Taps tab").tap();
    await screen.getByText("Go to Detail screen").tap();
    await expect(screen.getByText("Detail")).toBeVisible();
    await screen.getByText("Back").tap();

    // The negative control: something else must still be reporting, or this passes
    // on an SDK that stopped doing anything at all.
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction", { timeout: 30_000 });

    const navs = (await getEvents()).filter((e) => e.type === "navigation");
    expect(navs).toHaveLength(0);
  });
});
