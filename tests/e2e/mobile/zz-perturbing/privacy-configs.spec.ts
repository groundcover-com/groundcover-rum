import { test, expect } from "@mobilewright/test";
import { expectEvents, settleAndClear, type RumEvent } from "../support/ingest-client";
import { activatePreset, restoreDefaultPreset, type PresetName } from "../support/preset";
import { tapScrolling } from "../support/ui";
import { app } from "../support/app";

// The privacy config surface on device: the wire carries the same redaction contract as the
// browser's for network bodies, query params, headers, logs and errors.
//
// Driven by ONE request and ONE log/error pair, each carrying a secret in every place the SDK
// redacts independently, plus survivors that must come through untouched — without those, every
// assertion is equally satisfied by redaction gone total, which is just as broken and harder to spot.
const REDACTED = "[REDACTED]";
const CUSTOM_REDACTION = "e2e-custom-redaction";

// The raw secrets the playground sends, per carrier. Each spec asserts none of the
// relevant set appears ANYWHERE on the event, which is what catches a leak through a
// field nobody thought to check.
//
// Split by carrier rather than kept as one list because the three paths redact through
// DIFFERENT code — a URL/header/body pass for network, a key=value message scrub plus an
// attribute walk for logs and exceptions — so a whole-event scan is only meaningful
// against the secrets that carrier actually sends. One merged list would make each scan
// mostly vacuous, passing on literals that were never there to leak.
const SECRETS = ["e2e-query-token", "e2e-bearer-secret", "e2e-body-password"];
const LOG_SECRETS = ["e2e-log-password", "e2e-log-apikey"];
const ERROR_SECRETS = ["e2e-error-token", "e2e-error-password"];

const attrs = (event: RumEvent): Record<string, unknown> =>
  (event.attributes ?? {}) as Record<string, unknown>;

const str = (event: RumEvent, key: string): string => String(attrs(event)[key] ?? "");

async function sendSensitiveRequest(screen: Parameters<typeof tapScrolling>[0]): Promise<RumEvent> {
  await screen.getByLabel("Network tab").tap();
  await tapScrolling(screen, "sensitive request");
  const [event] = await expectEvents("network", {
    timeout: 30_000,
    where: (e) => String((e.attributes as Record<string, unknown>)["resource_name"] ?? "").includes("sensitive"),
    describe: "the sensitive request",
  });
  return event!;
}

async function boot(ctx: Parameters<typeof activatePreset>[0], preset: PresetName): Promise<void> {
  // No settleAndClear before the relaunch: it discards nothing the relaunch would
  // not, and the clear AFTER activation is the one the assertions rely on.
  await activatePreset(ctx, preset);
  await settleAndClear();
}

test.describe("rn-playground — privacy config matrix", () => {
  test.afterEach(async ({ platform }) => {
    await restoreDefaultPreset({ platform });
  });

  test("the default level redacts query, header and body while keeping the survivors", async ({
    screen,
    device,
  }) => {
    test.setTimeout(180_000);
    // No preset: this is the DEFAULT config every other spec in the suite runs
    // under, which is the one customers get if they configure nothing.
    await settleAndClear();
    const event = await sendSensitiveRequest(screen);

    // Query: the sensitive param is redacted in both places the URL is reported,
    // and the benign one survives.
    expect(str(event, "url.full")).not.toContain("e2e-query-token");
    expect(str(event, "url.full")).toContain("user=demo");
    expect(str(event, "resource_name")).not.toContain("e2e-query-token");

    // Header. `authorization` is on the always-sensitive list, so this holds at
    // every level — see the `allow` test below, which is the one that proves it.
    expect(str(event, "http.request.headers.authorization")).toBe(REDACTED);

    // Body: the sensitive key is redacted, the benign one is not. Both halves in
    // one payload, so a redactor that flattened everything fails the second.
    const body = str(event, "gc.request.body");
    expect(body).not.toContain("e2e-body-password");
    expect(body).toContain(REDACTED);
    expect(body).toContain("A-1");

    // And no secret survives anywhere on the event, under any key.
    for (const secret of SECRETS) {
      expect(JSON.stringify(event)).not.toContain(secret);
    }
  });

  test("level 'allow' stops redacting bodies and query — but never the auth header", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);
    await boot({ screen, device, platform }, "allow");
    const event = await sendSensitiveRequest(screen);

    // `allow` is an explicit opt-out, so the payload comes through intact. Both
    // assertions are needed: only seeing the token proves query redaction is off,
    // only seeing the password proves body redaction is off.
    expect(str(event, "url.full")).toContain("e2e-query-token");
    expect(str(event, "gc.request.body")).toContain("e2e-body-password");

    // THE assertion in this file. Header stripping is unconditional in the
    // listener (formatHeaders always calls redactHeaders and only drops the
    // CUSTOM key list under `allow`), which means "allow" cannot be talked into
    // shipping a bearer token. If that ever changes, the most permissive privacy
    // setting silently starts exfiltrating credentials to the RUM backend — and
    // it is exactly the setting a customer reaches for when they are debugging.
    expect(str(event, "http.request.headers.authorization")).toBe(REDACTED);
    expect(JSON.stringify(event)).not.toContain("e2e-bearer-secret");
  });

  test("maskNetworkBodies:false keeps the body while the query stays redacted", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);
    await boot({ screen, device, platform }, "no-body-mask");
    const event = await sendSensitiveRequest(screen);

    // The toggles are independent. A single `shouldMask` boolean behind both
    // would pass one of these two assertions and fail the other.
    expect(str(event, "gc.request.body")).toContain("e2e-body-password");
    expect(str(event, "url.full")).not.toContain("e2e-query-token");
    expect(str(event, "http.request.headers.authorization")).toBe(REDACTED);
  });

  test("custom sensitiveKeys claim a benign key, and a redact hook overrides one leaf", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);
    await boot({ screen, device, platform }, "custom-redact");

    const event = await sendSensitiveRequest(screen);
    const body = str(event, "gc.request.body");

    // `order_id` is benign to the built-in rules and survives everywhere else in
    // this file — here it is named in sensitiveKeys, so it must not.
    expect(body).not.toContain("A-1");

    // The hook replaces the `email` leaf with its own marker rather than the
    // built-in sentinel, which is the only way to tell a hook that ran from a
    // default that happened to match.
    expect(body).toContain(CUSTOM_REDACTION);

    // ...and DEFERS elsewhere: the hook returns undefined for every other key, so
    // `password` still gets the built-in treatment. A hook that could silently
    // switch masking off for everything it did not name is the failure mode this
    // catches.
    expect(body).not.toContain("e2e-body-password");
    expect(body).toContain(REDACTED);
  });

  test("logs and errors redact both their free text and their structured half", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);
    // Default config again: log/error redaction is on out of the box — but BOOTED onto it
    // explicitly rather than inherited. `afterEach`'s `restoreDefaultPreset()` only rewrites
    // `e2e-preset.ts`; unlike `activatePreset` it does not relaunch, so what the app is
    // actually running here depends on Metro pushing that edit into the live bundle. The
    // preceding test leaves `custom-redact` — whose `sensitiveKeys: ["order_id"]` would
    // redact the very survivor asserted below — so if that refresh ever stopped landing this
    // test would start failing for a reason nowhere near what it checks. `boot` relaunches
    // and confirms `preset: default` on the Config tab before proceeding.
    await boot({ screen, device, platform }, "default");

    // `activatePreset` leaves the app on the Config tab (that readout is how it confirms the
    // preset), so this navigation is required after a boot, not merely after a relaunch.
    await screen.getByLabel("Logs tab").tap();
    await tapScrolling(screen, "log sensitive");
    const [log] = await expectEvents("log", {
      timeout: 30_000,
      where: (e) => String((e.attributes as Record<string, unknown>)["message"] ?? "").includes("user login"),
      describe: "the sensitive log",
    });

    // The message is free text scrubbed by a key=value pass...
    expect(str(log!, "message")).not.toContain("e2e-log-password");
    expect(str(log!, "message")).toContain(REDACTED);
    // ...and the attributes are walked by key. Different code paths, so both.
    expect(str(log!, "api_key")).toBe(REDACTED);
    // The survivor, proving the walk is selective rather than wholesale.
    expect(str(log!, "order_id")).toBe("A-1");
    // ...and nowhere ELSE on the event. The two checks above name the fields redaction is
    // supposed to touch, so together they prove those fields were handled — not that the
    // secret is gone. A copy surviving in any other serialized attribute satisfies both and
    // still ships the password. The network event gets the same scan; the log and exception
    // carriers redact through different code, so each is scanned on its own.
    for (const secret of LOG_SECRETS) {
      expect(JSON.stringify(log)).not.toContain(secret);
    }

    await tapScrolling(screen, "capture sensitive error");
    const [error] = await expectEvents("exception", {
      timeout: 30_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)["error_message"] ?? "").includes("auth failed"),
      describe: "the sensitive error",
    });

    expect(str(error!, "error_message")).not.toContain("e2e-error-token");
    expect(str(error!, "error_message")).toContain(REDACTED);
    expect(str(error!, "error_metadata.password")).toBe(REDACTED);
    expect(str(error!, "error_metadata.order_id")).toBe("A-1");
    // Same whole-event scan as the log above. An exception carries a stack as well as a
    // message, and a token interpolated into a throw site would ride along in it untouched
    // by the metadata walk.
    for (const secret of ERROR_SECRETS) {
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  test("level 'mask-all' also masks the interaction label and the a11y value text", async ({
    screen,
    device,
    platform,
  }) => {
    test.setTimeout(240_000);
    await boot({ screen, device, platform }, "mask-all");

    // maskInteractionLabels defaults ON at this level, so a label that ships in
    // full under every other config must not here.
    await screen.getByLabel("Taps tab").tap();
    await tapScrolling(screen, /A11y annotated/);

    const [tap] = await expectEvents("interaction", {
      timeout: 30_000,
      // Keyed on the a11y VALUE, not on the type or the label: under mask-all the
      // label is "***" on every control, so a type-only predicate would match
      // whichever tap arrives first (the Config tab's) and then assert a11y
      // fields on an element that has none. The profile keys on a structural
      // field, which survives masking and uniquely identifies the annotated button.
      where: (e) => app.isAnnotatedTap(e.attributes as Record<string, unknown>),
      describe: "a tap on the annotated control under mask-all",
    });

    expect(str(tap!, "interaction_target.label")).toBe("***");

    // The split that makes this more than a label test: `value.text` is
    // human-readable and masked like a label, while the STATE flags and the
    // numeric value fields are structural and must survive — masking that also
    // ate them would make masked sessions undebuggable, and masking that spared
    // the text would leak a11y-exposed content.
    expect(str(tap!, "interaction_target.value.text")).toBe("***");
    if (app.annotatedValueNow !== undefined) {
      expect(attrs(tap!)["interaction_target.value.now"]).toBe(app.annotatedValueNow);
    }
    expect(attrs(tap!)["interaction_target.state.selected"]).toBe(true);
    // Structural identity is never masked — it is what a masked session is
    // navigated by.
    if (app.tapComponents) {
      expect(str(tap!, "interaction_target.component")).toBe(app.tapComponents.component);
    }
    expect(str(tap!, "interaction_target.role")).toBe("button");
  });
});
