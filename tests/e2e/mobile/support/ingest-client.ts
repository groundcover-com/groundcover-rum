import { INGEST_PORT, type EchoedRequest } from "./ingest-server";

export type { EchoedRequest };

// Spec-side client for the mock ingest server. Specs run in Mobilewright's
// (Playwright) worker processes, so they read recorded events over HTTP from the
// server started in global-setup rather than sharing memory.
const BASE = `http://127.0.0.1:${INGEST_PORT}`;

export type RumEvent = Record<string, unknown> & {
  type: string;
  attributes?: Record<string, unknown>;
  __sessionAttributes?: Record<string, unknown>;
};

/**
 * The screen an event belongs to, from the ambient `screen` block the enricher stamps on every
 * event.
 *
 * A helper rather than an inline `attributes.screen.name`, because `screen` is the SOLE nested
 * attribute on an otherwise dot-flattened payload (enrichAttributes is merged after flattening),
 * so it is the one place a spec cannot use the flat-key idiom the rest of the suite reads by. It
 * is also how navigation events identify themselves: there is no separate
 * `screen_name`/`screen_key` attribute duplicating this value.
 */
export function screenName(event: RumEvent): string {
  const screen = event.attributes?.screen as { name?: unknown } | undefined;
  return typeof screen?.name === "string" ? screen.name : "";
}

/** Route key (per-instance id) from the same block; `""` when unknown, as on the manual API. */
export function screenKey(event: RumEvent): string {
  const screen = event.attributes?.screen as { key?: unknown } | undefined;
  return typeof screen?.key === "string" ? screen.key : "";
}

export type IngestStats = {
  batches: number;
  rejectedBatches: number;
  events: number;
  requests: number;
  /** Bytes on the wire across every batch POST, accepted or not. */
  bytes: number;
  firstAtMs: number;
  lastAtMs: number;
  failRemaining: number;
};

export type IngestRequest = {
  seq: number;
  receivedAtMs: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bytes: number;
  status: number;
};

export async function clearEvents(): Promise<void> {
  await fetch(`${BASE}/__e2e/events`, { method: "DELETE" });
}

export async function getEvents(): Promise<RumEvent[]> {
  const res = await fetch(`${BASE}/__e2e/events`);
  const body = (await res.json()) as { events: RumEvent[] };
  return body.events ?? [];
}

export async function getStats(): Promise<IngestStats> {
  const res = await fetch(`${BASE}/__e2e/stats`);
  return (await res.json()) as IngestStats;
}

/** Per-batch request metadata: headers, url, wire bytes, answered status. */
export async function getRequests(): Promise<IngestRequest[]> {
  const res = await fetch(`${BASE}/__e2e/requests`);
  const body = (await res.json()) as { requests: IngestRequest[] };
  return body.requests ?? [];
}

/** Every request the echo received since the last clear, as it arrived: the server's view. */
export async function getEchoes(): Promise<EchoedRequest[]> {
  const res = await fetch(`${BASE}/__e2e/echoes`);
  const body = (await res.json()) as { echoes: EchoedRequest[] };
  return body.echoes ?? [];
}

/**
 * Answer the next `count` batch POSTs with `status` instead of 200.
 *
 * The only way to test the delivery guarantees from outside the SDK: the drain
 * treats a non-2xx as undelivered and keeps the record, so a rejected crash has
 * to come back on the following launch. Pass `count: 0` to disarm.
 */
export async function failNextBatches(count: number, status = 500): Promise<IngestStats> {
  const res = await fetch(`${BASE}/__e2e/fail-next?count=${count}&status=${status}`, {
    method: "POST",
  });
  return (await res.json()) as IngestStats;
}

export type SettleOutcome = {
  /** Whether the ingest actually went quiet before the deadline. */
  settled: boolean;
  /** The last request count observed. */
  requests: number;
  /** How long the wait took. */
  waitedMs: number;
};

/** How often the settle loop asks the ingest for its request count. */
const SETTLE_POLL_MS = 250;

/**
 * The settle loop, over an injected counter and clock.
 *
 * Extracted so its OUTCOME can be tested: the interesting behaviour is what it
 * concludes when the ingest never goes quiet, and reaching that against a real
 * socket would mean holding a test open for the full timeout.
 */
export async function waitForQuiet(
  readRequests: () => Promise<number>,
  opts: {
    quietMs: number;
    timeout: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<SettleOutcome> {
  const {
    quietMs,
    timeout,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  const started = now();
  const deadline = started + timeout;
  let seen = -1;
  let quietSince = started;
  let requests = 0;

  while (now() < deadline) {
    requests = await readRequests();
    if (requests !== seen) {
      seen = requests;
      quietSince = now();
    } else if (now() - quietSince >= quietMs) {
      return { settled: true, requests, waitedMs: now() - started };
    }
    await sleep(SETTLE_POLL_MS);
  }

  return { settled: false, requests, waitedMs: now() - started };
}

/**
 * Wait until the ingest has been QUIET for `quietMs`, then clear. `clearEvents()` alone races
 * the previous test's flush, so a batch from the last test lands just after it and becomes what
 * the next test asserts on.
 *
 * RAISES rather than clearing on the deadline as though it had gone quiet: that would hand the
 * caller a window it never established, and a spec such as `native-crash.spec.ts` would then
 * assert on a batch from before the clear.
 */
export async function settleAndClear(
  opts: { quietMs?: number; timeout?: number } = {}
): Promise<void> {
  const { quietMs = 1_200, timeout = 15_000 } = opts;

  const outcome = await waitForQuiet(async () => (await getStats()).requests, {
    quietMs,
    timeout,
  });

  if (!outcome.settled) {
    throw new Error(
      `the mock ingest never went quiet: still taking batches after ${outcome.waitedMs}ms ` +
        `(needed ${quietMs}ms of silence; last count ${outcome.requests} requests).\n` +
        `  NOT clearing — a clear here would hand the test a window it never had, and ` +
        `whatever it asserts next would be measuring something else.\n` +
        `  Usual causes: another device POSTing to :9393 (see 02-foreign-reporter), or ` +
        `the app under test stuck emitting.`
    );
  }

  await clearEvents();
}

/**
 * Poll until at least one event of `type` (optionally matching a predicate) is recorded, or the
 * timeout elapses. `min` IS NOT A SELECTOR — it counts whatever `where` admitted, so `min: 2` over
 * "any frame vital" is satisfied by earlier screens' segments and the read then finds nothing for
 * the screen under test. Put the identity in `where`; use `min` only for "at least N of those".
 */
export async function waitForEvents(
  type: string,
  opts: { timeout?: number; where?: (e: RumEvent) => boolean; min?: number } = {}
): Promise<RumEvent[]> {
  const { timeout = 20_000, where, min = 1 } = opts;
  const deadline = Date.now() + timeout;
  let last: RumEvent[] = [];
  while (Date.now() < deadline) {
    const events = await getEvents();
    last = events.filter((e) => e.type === type && (!where || where(e)));
    if (last.length >= min) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/**
 * `waitForEvents`, but a timeout is a failure with a diagnosis attached. A native signal
 * going quiet — never attached, wrong module name, feature gated off — looks identical
 * through `waitForEvents`: an empty array and `expect(undefined).toBeTruthy()`. Prefer
 * this wherever a missing event means a bug rather than a legitimately absent signal.
 */
export async function expectEvents(
  type: string,
  opts: { timeout?: number; where?: (e: RumEvent) => boolean; min?: number; describe?: string } = {}
): Promise<RumEvent[]> {
  const found = await waitForEvents(type, opts);
  if (found.length >= (opts.min ?? 1)) return found;

  const all = await getEvents();
  const tally = [...new Set(all.map((e) => e.type))]
    .map((t) => `${t}×${all.filter((e) => e.type === t).length}`)
    .sort()
    .join(", ");
  // The discriminator within a type matters as much as the type itself: eight
  // `performance` events tell you nothing until you know they were all frame
  // vitals and no app-start metric ever arrived.
  const detail = (key: string) =>
    [
      ...new Set(
        all
          .filter((e) => e.type === type)
          .map((e) => String((e.attributes as Record<string, unknown>)?.[key] ?? ""))
          .filter(Boolean)
      ),
    ].join(", ");
  const seen =
    type === "performance"
      ? detail("performance_metric_name")
      : type === "exception"
        ? detail("error_type")
        : type === "interaction"
          ? detail("interaction_type")
          : "";

  // Which control was hit, not just which kind of gesture: a wait for a tap on a
  // named button fails identically whether the touch never landed or landed on
  // the neighbour, and only the target labels tell those apart. A mis-tap costs a
  // full run to diagnose without them — see `tapScrolling`, where a control
  // resting behind the tab bar can swallow the touch.
  const targets = type === "interaction" ? detail("interaction_target.label") : "";

  throw new Error(
    `Timed out after ${opts.timeout ?? 20_000}ms waiting for ${opts.min ?? 1}× ${type}` +
      `${opts.describe ? ` (${opts.describe})` : ""}.\n` +
      `  recorded: ${tally || "nothing at all"}` +
      `${seen ? `\n  ${type} seen: ${seen}` : ""}` +
      `${targets ? `\n  targets tapped: ${targets}` : ""}` +
      `${type === "interaction" ? gestureLines(all) : ""}`
  );
}

/**
 * The kinematics of every gesture recorded, for a failure that wanted a particular KIND.
 * `interaction seen: tap, scroll` names what arrived but not why it was that kind, and
 * the two differ purely by numbers — so without these a "wanted swipe, got scroll"
 * failure cannot be diagnosed from CI, the spec's own [gesture] line printing only on
 * the success path.
 */
function gestureLines(all: RumEvent[]): string {
  const rows = all
    .filter((e) => e.type === "interaction")
    .map((e) => (e.attributes ?? {}) as Record<string, unknown>)
    .filter((a) => a["interaction_gesture.distance_dp"] !== undefined)
    .map(
      (a) =>
        `    ${String(a["interaction_type"])}` +
        ` distance_dp=${a["interaction_gesture.distance_dp"]}` +
        ` velocity_dp_s=${a["interaction_gesture.velocity_dp_s"]}` +
        ` duration_ms=${a["interaction_gesture.duration_ms"]}` +
        ` direction=${a["interaction_gesture.direction"]}` +
        ` source=${a["interaction_gesture.capture_source"]}` +
        `${a["interaction_gesture.partial"] === undefined ? "" : ` partial=${a["interaction_gesture.partial"]}`}`
    );
  return rows.length ? `\n  gestures recorded:\n${rows.join("\n")}` : "";
}

export async function sessionAttributes(): Promise<Record<string, unknown> | undefined> {
  const events = await getEvents();
  return events[0]?.__sessionAttributes;
}
