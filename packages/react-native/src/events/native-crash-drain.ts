import {
  EventEnricher,
  msToNs,
  isUsableEvent,
  redactObject,
  redactText,
  Transporter,
  truncate,
  type ConfigManager,
  type BaseEvent,
  type ErrorEventAttributes,
  type IdGenerator,
} from "@groundcover/rum-core";

import type { RNEventType } from "./rn-event-types";
import type { GroundcoverNativeModule, PendingCrashRecord, PendingJsFatal } from "../platform/native-types";
import { clearPendingCrashReports, readPendingCrashReports } from "../platform/native-bridge";
import type { SessionSnapshot } from "../platform/session-snapshot";
import { createRnBatchSender, RN_SEND_TIMEOUT_MS } from "../internal/rn-batch-sender";
// The shared reporter, not a private copy. Every one of this module's three catch sites is
// somewhere a second throw costs records — the loop abandons the ones queued behind it, the outer
// `.catch` becomes an unhandled rejection. Uniform on purpose: one wrapped site and two bare ones
// is how the next reader concludes the bare ones are safe.
import { reportSafely } from "../internal/report-safely";

// Reports crashes that killed a PREVIOUS run. Deliberately not a listener: a crashed
// session is over, and its sessionAttributes are not the ones this run would stamp — so
// the drain bypasses EventsPool and sends each report as its own batch, built from the
// snapshot native persisted at crash time. The current session's id never touches these.
//
// At-least-once: native keeps a record until JS confirms the POST, and `crash_report_id`
// is stable across redeliveries, so a duplicate can be recognised. Losing a fatal is far
// worse than reporting it twice.

// Upper bound on waiting for one report's delivery verdict. Transporter.send
// returns WITHOUT calling sendBatch when config or the API key is missing, so
// the delivery promise would otherwise never settle and stall the whole drain.
// DERIVED from the request timeout rather than restated, so the ordering holds by construction.
// It has to stay LONGER: if this fires first, `sendUnderSnapshot` resolves `false` while the
// request is still in flight, the record is left un-acked, and the abort's real `onOutcome(false)`
// lands on an already-settled promise — so a report that actually succeeded is redelivered on the
// next launch. As a literal that invariant would live only in this comment, and break silently the
// first time somebody raised the timeout for slow networks.
const DELIVERY_DEADLINE_MS = RN_SEND_TIMEOUT_MS + 5_000;

// One drain per JS runtime. A re-init (fast refresh constructs a replacement
// manager) must not start a second pass while the first's requests are still in
// flight — both would read the same un-acked records and send them twice.
let drainInFlight: Promise<void> | null = null;

export interface DrainDeps {
  config: ConfigManager;
  idGenerator: IdGenerator;
  native: GroundcoverNativeModule;
}

export function drainNativeCrashReports(deps: DrainDeps): Promise<void> {
  if (drainInFlight) return drainInFlight;

  const run = runDrain(deps)
    .catch(reportSafely)
    .finally(() => {
      drainInFlight = null;
    });
  drainInFlight = run;
  return run;
}

/** Test seam — the mutex is module state, so a suite that drains twice needs to
 *  be able to reset it between cases. */
export function __resetDrainStateForTest(): void {
  drainInFlight = null;
}

async function runDrain(deps: DrainDeps): Promise<void> {
  const records = await readPendingCrashReports(deps.native);
  if (!records.length) return;

  for (const record of records) {
    try {
      const acked = await reportOne(record, deps);
      if (acked) {
        const id = "jsFatalId" in record ? record.jsFatalId : record.id;
        await clearPendingCrashReports(deps.native, [id]);
      }
    } catch (error) {
      // Leave the record un-acked: whatever went wrong here, the next launch
      // gets another attempt.
      //
      // `reportSafely`, not `handleError`: a throw from the reporter here would break the LOOP,
      // abandoning every record still queued behind this one — the drain is the only place in the
      // SDK where reporting an error can cost unrelated data.
      reportSafely(error);
    }
  }
}

/** @returns whether the record should be acked (delivered, or unsalvageable). */
async function reportOne(record: PendingCrashRecord | PendingJsFatal, deps: DrainDeps): Promise<boolean> {
  const snapshot = parseSnapshot(record.sessionSnapshotJson);
  if (!snapshot) {
    // No envelope means no session to attribute this to. Sending it under the
    // CURRENT session would be worse than dropping it: it would corrupt an
    // unrelated session with another one's fatal.
    return true;
  }

  const { screen, ...sessionAttributes } = snapshot;

  if ("jsFatalId" in record) {
    if (!isUsableEvent(record.event)) return true;
    return sendUnderSnapshot({ deps, sessionAttributes, event: record.event as BaseEvent });
  }

  // A local enricher so the crash-time screen is stamped nested (like every
  // other event's `screen`), rather than dot-flattened as a plain attribute.
  const enricher = new EventEnricher({
    enrichAttributes: () => ({ screen: record.screen ?? screen ?? { name: "", key: "" } }),
    idGenerator: deps.idGenerator,
  });

  let event = enricher.enrich<RNEventType>({
    type: "exception",
    // WHEN IT CRASHED, not when we got around to reporting it.
    timestamp: msToNs(record.crashEpochMs),
    attributes: buildAttributes(record, deps.config.getPrivacy()),
  });

  // The pool applies these on addEvent; this path bypasses the pool, so it has
  // to apply them itself or a host's beforeSend/enrichEvent would silently not
  // run for crashes.
  //
  // Both are CONTAINED, and the two failures get different answers on purpose. A throw that
  // propagated out of this function would leave the record un-acked — so it would be retried on
  // every launch forever, because a broken callback keeps being broken. The pending directory is
  // capped, so one permanently stuck record also crowds out the crashes that follow it.
  const options = deps.config.getConfig()?.options;
  const verdict = runCallback(() => options?.beforeSend?.(event as never) ?? true);
  if (!verdict.ok) {
    // A broken `beforeSend` is unsalvageable: we cannot know whether the host wanted this event,
    // and the live path makes the same call — EventsPool drops an event whose beforeSend throws.
    // Ack, for the same reason the explicit `false` below acks: not doing so retries forever.
    return true;
  }
  if (!verdict.value) {
    // The host chose to drop it. Ack anyway — leaving it would retry forever.
    return true;
  }
  // Recoverable, unlike the above: the event is already built and valid, so a broken enricher
  // costs its added attributes rather than the crash report.
  //
  // The result is VALIDATED before it is adopted. The pool drops an unusable enrichEvent
  // return; this path must not drop — a fatal is the most valuable event the SDK sends, and
  // the built event is already redacted, so there is nothing unscrubbed to protect against.
  // It falls back to the built event instead. Without the check a hook returning a truthy
  // non-event (`{}` from an untyped JS caller, or an implicit-return arrow) is adopted
  // wholesale and a typeless husk goes on the wire in place of the crash report.
  //
  // The hook gets a COPY. Falling back to the built event only helps if the hook could not
  // touch it: one that changes the timestamp or the report id and then throws would otherwise
  // ship its half-done edits, and the record is acked after the send, so the original is gone.
  // A JSON copy is enough (the event is about to be sent as JSON) and works on every engine,
  // which `structuredClone` does not.
  const enrichEvent = options?.enrichEvent;
  if (enrichEvent) {
    const built = event;
    const enriched = runCallback(() => {
      const copy = JSON.parse(JSON.stringify(built)) as typeof built;
      return enrichEvent(copy as never) ?? copy;
    });
    if (enriched.ok && isUsableEvent(enriched.value)) event = enriched.value as typeof event;
  }

  return sendUnderSnapshot({ deps, sessionAttributes, event });
}

/**
 * Runs a HOST-SUPPLIED callback without letting it decide the fate of the drain.
 *
 * `ok: false` means the callback threw; the caller decides what that costs, because the answer
 * differs per callback (see the two call sites). `handleError` is itself wrapped, since a host's
 * logger can throw too — and a throw from the reporter would reject the drain promise and abandon
 * every record still queued behind this one.
 */
function runCallback<T>(run: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    reportSafely(error);
    return { ok: false };
  }
}

/**
 * Scrubs the cause chain's free text.
 *
 * `redactObject` is key-based (core `redactValueAt`): a leaf survives untouched unless its KEY
 * looks sensitive. `causes[].message` is exception free text the Android mapper copied in
 * (`GcRumCrashRecordMapper.buildMetadata`), under a key no heuristic calls sensitive — so without
 * this the very string `redactText` strips out of `error_message` would ship verbatim one level
 * down, with `maskErrors` ON. Scanned as text rather than blanked by key because the SDK is what
 * put it there: the `caused by` message is usually where the real failure is described, and
 * losing it wholesale would cost more than it protects.
 *
 * Deliberately narrow. This does NOT turn metadata redaction into a free-text scan — host-supplied
 * keys keep the key-based contract the JS `captureException` path gives them.
 */
function redactCauseMessages(
  metadata: Record<string, unknown>,
  opts: Parameters<typeof redactText>[1]
): Record<string, unknown> {
  const causes = metadata.causes;
  if (!Array.isArray(causes)) return metadata;
  return {
    ...metadata,
    causes: causes.map((cause) => {
      if (!cause || typeof cause !== "object") return cause;
      const fields = cause as Record<string, unknown>;
      if (typeof fields.message !== "string") return cause;
      return { ...fields, message: redactText(fields.message, opts) };
    }),
  };
}

function buildAttributes(
  record: PendingCrashRecord,
  privacy: ReturnType<ConfigManager["getPrivacy"]>
): ErrorEventAttributes {
  const errorType = record.errorType || "NativeCrash";
  // Mask exactly as the JS error path does (errors-events-listener buildEvent).
  // A crash message routinely carries request context — an NSException raised
  // out of a failed API call, a Kotlin exception whose message embeds the URL
  // and its Authorization header — and `maskErrors` defaults ON, so shipping
  // native fatals unredacted silently breaks the promise the SDK already makes
  // for every other error.
  const opts = { sensitiveKeys: privacy.sensitiveKeys, redact: privacy.redact, kind: "error" as const };
  const rawMessage = record.errorMessage || "Native crash";
  const errorMessage = privacy.shouldMaskErrors ? redactText(rawMessage, opts) : rawMessage;
  // Redact the HOST's metadata only, then add our own markers — `crash_report_id`
  // is what lets an at-least-once redelivery be recognised as a duplicate, so it
  // must not be at the mercy of a key-name heuristic.
  const hostMetadata = record.metadata ?? {};
  const safeMetadata = privacy.shouldMaskErrors
    ? redactCauseMessages(redactObject(hostMetadata, opts), opts)
    : hostMetadata;

  return {
    error_type: errorType,
    error_message: errorMessage,
    // Already normalized at the bridge's trust boundary (`normalizeStackFrames`), which is where
    // a record off disk is coerced — not re-checked here, or the two could drift apart.
    error_stacktrace: record.stacktrace,
    // Same formula as the JS error listener, so native and JS fatals group the
    // same way. Built from the MASKED message, or the fingerprint
    // would leak what the message just redacted.
    error_fingerprint: `${errorType}:${truncate({ text: errorMessage, maxLength: 400 })}`,
    error_handled: false,
    error_metadata: {
      ...safeMetadata,
      native: true,
      fatal: true,
      // Stable across redeliveries, so a duplicate can be recognised.
      crash_report_id: record.id,
    },
  };
}

/**
 * Sends one batch under the CRASHED session's envelope and reports whether it
 * actually landed.
 *
 * The transporter is fire-and-forget by design (a live batch must never block
 * the app), and it treats any resolved fetch as sent. Delivery matters here, so
 * this wraps the sender to observe the real outcome — including a non-2xx,
 * which the transporter would otherwise count as success.
 */
async function sendUnderSnapshot(args: {
  deps: DrainDeps;
  sessionAttributes: Record<string, unknown>;
  event: ReturnType<EventEnricher["enrich"]>;
}): Promise<boolean> {
  const { deps, sessionAttributes, event } = args;

  let settle: (delivered: boolean) => void = () => {};
  const delivered = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  // The live pool sends fire-and-forget; the drain needs the real verdict for its
  // at-least-once ack, which the transporter (any resolved fetch = sent) would hide —
  // so the shared sender reports the outcome back through `settle`.
  const transporter = new Transporter({
    config: deps.config,
    sendBatch: createRnBatchSender(settle),
  });

  await transporter.send(
    {
      // The crashed session's envelope, verbatim — never the current one's.
      sessionAttributes: sessionAttributes as never,
      events: [event],
    },
    // Inline encode: RN has no worker, and this path should not wait on one.
    { lifecycle: true }
  );

  // Clear the deadline the moment delivery wins the race. Left queued, each drained
  // record strands a 35s callback — through teardown and re-init, on a path that runs
  // one report after another — so a sequential drain can hold a dozen live timers.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      delivered,
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), DELIVERY_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

function parseSnapshot(json: string | null | undefined): SessionSnapshot | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<SessionSnapshot> | null;
    if (!parsed || typeof parsed !== "object") return null;
    // Without a session id there is nothing to attribute the crash to.
    if (typeof parsed.session_id !== "string" || !parsed.session_id) return null;
    return parsed as SessionSnapshot;
  } catch {
    return null;
  }
}
