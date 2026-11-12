import { test, expect } from "@mobilewright/test";
import { getEvents, settleAndClear, waitForEvents, type RumEvent } from "../support/ingest-client";
import { tapScrolling } from "../support/ui";

// The properties that must hold for EVERY event of EVERY type, checked in one
// place against a run that produced several types.
//
// Each feature spec verifies its own event and, reasonably, only its own. That
// leaves the cross-cutting guarantees — the ones the enricher and the pool are
// responsible for — asserted for a couple of types and assumed for the rest. An
// enricher regression that dropped the screen stamp from, say, log events only
// would pass the entire suite as it stands.
const attrs = (event: RumEvent): Record<string, unknown> =>
  (event.attributes ?? {}) as Record<string, unknown>;

test.describe("rn-playground — envelope invariants", () => {
  test("every event carries a screen, one session, ns timestamps, and span_name only on network", async ({
    screen,
  }) => {
    test.setTimeout(180_000);

    await settleAndClear();

    // Produce a deliberately WIDE mix: interaction, navigation, log, custom,
    // exception and network, plus whatever performance events the native trackers
    // publish while this runs. The assertions below are only as good as the set of
    // types they get to see.
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction");

    await screen.getByText("Go to Detail screen").tap();
    await waitForEvents("navigation", { timeout: 30_000 });
    await screen.getByText("Back").tap();

    await screen.getByLabel("Logs tab").tap();
    await tapScrolling(screen, "logger.info");
    await waitForEvents("log", { timeout: 30_000 });
    await tapScrolling(screen, "captureException");
    await waitForEvents("exception", { timeout: 30_000 });

    await screen.getByLabel("Custom tab").tap();
    await tapScrolling(screen, "sendCustomEvent");
    await waitForEvents("custom", { timeout: 30_000 });

    await screen.getByLabel("Network tab").tap();
    await tapScrolling(screen, "fetch GET");
    await waitForEvents("network", { timeout: 30_000 });

    const events = await getEvents();
    const types = new Set(events.map((e) => e.type));

    // Guard the guard: if the arrange step above silently stopped producing
    // variety, every invariant below would still "hold" over a narrow sample and
    // this spec would quietly stop testing what it claims to.
    for (const required of ["interaction", "navigation", "log", "exception", "custom", "network"]) {
      expect(types.has(required)).toBe(true);
    }

    // Collect violations rather than asserting per event: mobilewright's `expect`
    // takes no message argument, so a bare failure deep in this loop would not say
    // WHICH event type broke the invariant — and that is the only fact worth
    // having. Each list is asserted empty below, so the failure prints the
    // offenders.
    const missingScreen: string[] = [];
    const badTimestamp: string[] = [];
    const badSpanName: string[] = [];
    const badNumber: string[] = [];

    for (const event of events) {
      // 1. The screen stamp is on EVERYTHING. The RN event type declares it
      //    required (the enricher injects it unconditionally, defaulting to an
      //    empty screen), so a missing one means the enrichment path was skipped
      //    for that type — and a nested object, not a dot-flattened key, because
      //    it is merged after flattening.
      //    BOTH members are checked because `ScreenAttributes` declares both required and
      //    `createScreenHolder` seeds them to `""`, so `key` is a string on every event the
      //    tracker ever stamped. Checking `name` alone would let an envelope through with no
      //    `key` at all — the per-instance id that tells two live copies of one screen apart,
      //    and the one member a hand-built stamp is most likely to omit.
      const stamped = attrs(event)["screen"] as { name?: unknown; key?: unknown } | undefined;
      if (!stamped || typeof stamped.name !== "string" || typeof stamped.key !== "string") {
        missingScreen.push(event.type);
      }

      // 2. A nanosecond time anchor on every event — but the field depends on the
      //    SHAPE of the event, which is worth stating because it is not obvious
      //    from the types. Most events are a point in time and carry `timestamp`;
      //    a network event is a span and carries `start_timestamp` +
      //    `end_timestamp` instead, with no `timestamp` at all.
      //
      //    Units are otherwise checked only on crashes and hangs. A ms-valued
      //    time is ~1e12 and a ns one ~1e18, so this floor separates them with a
      //    billion to spare and needs no clock sync with the device.
      //    Checked with `typeof`, not `Number(...)`: the envelope contract is a JSON NUMBER,
      //    and coercion would accept the numeric-looking STRING that a serializer added to
      //    dodge float64 precision loss would produce — the one regression this invariant
      //    should be loudest about, since every value still reads correctly downstream until
      //    something does arithmetic on it.
      const rawAnchor = event.timestamp ?? (event as Record<string, unknown>)["start_timestamp"];
      if (typeof rawAnchor !== "number" || !Number.isFinite(rawAnchor) || rawAnchor <= 1e15) {
        badTimestamp.push(`${event.type}=${JSON.stringify(rawAnchor)}`);
      }

      // A span's end cannot precede its start. Nothing else in the suite compares
      // the two, and a swapped pair yields negative durations on every network
      // chart while each field on its own looks perfectly well-formed.
      if (event.type === "network") {
        // Same `typeof` gate as the anchor above, and for the same reason: `Number("...")`
        // would let a stringified pair satisfy the ordering check.
        const start = (event as Record<string, unknown>)["start_timestamp"];
        const end = (event as Record<string, unknown>)["end_timestamp"];
        if (
          typeof start !== "number" ||
          typeof end !== "number" ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end < start
        ) {
          badTimestamp.push(`network span ${JSON.stringify(start)}..${JSON.stringify(end)}`);
        }
      }

      // 3. `span_name` belongs to network events alone — browser parity, and the
      //    thing the interaction specs assert for their own type and no other.
      const hasSpanName = String(event.span_name ?? "") !== "";
      if (event.type === "network" ? !hasSpanName : hasSpanName) {
        badSpanName.push(`${event.type}=${String(event.span_name)}`);
      }

      // 4. Every numeric attribute arrives FINITE and non-null, on every type and
      //    every path. `Infinity`/`NaN` both serialize through `JSON.stringify` to
      //    `null`, and a schema-declared number arriving `null` is indistinguishable
      //    from a field native never sent, on the pull AND the push path. The SDK
      //    OMITS an absent attribute rather than nulling it, so a null value here is
      //    that bug — caught in one place, for
      //    every current and future numeric attribute, without caring which path
      //    produced it. `screen` is the sole legitimate nested object (merged after
      //    flattening); everything else on `attributes` is a flat scalar.
      for (const [key, value] of Object.entries(attrs(event))) {
        if (key === "screen") continue;
        if (value === null) badNumber.push(`${event.type}.${key}=null`);
        else if (typeof value === "number" && !Number.isFinite(value)) {
          badNumber.push(`${event.type}.${key}=${value}`);
        }
      }
    }

    expect([...new Set(missingScreen)]).toEqual([]);
    expect([...new Set(badTimestamp)]).toEqual([]);
    expect([...new Set(badSpanName)]).toEqual([]);
    expect([...new Set(badNumber)]).toEqual([]);

    // 4. ONE session across the whole run, for every type. Two ids here means
    //    something rotated mid-run (or a second reporter is present — see
    //    02-foreign-reporter), and events split across two sessions are events
    //    that do not join up in the product.
    const sessionIds = new Set(
      events.map((e) => (e.__sessionAttributes as { session_id?: string } | undefined)?.session_id)
    );
    expect(sessionIds.size).toBe(1);

    // 5. The component path stays inside its documented caps (MAX_PATH_SEGMENTS
    //    10, 200 chars). Truncation bugs corrupt rather than drop, so the backend
    //    stores them happily and nothing complains.
    for (const event of events.filter((e) => e.type === "interaction")) {
      const path = String(attrs(event)["interaction_component_path"] ?? "");
      expect(path.length).toBeLessThanOrEqual(200);
      expect(path.split(">").length).toBeLessThanOrEqual(10);
    }
  });
});
