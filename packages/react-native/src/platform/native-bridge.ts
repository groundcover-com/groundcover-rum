import { NativeEventEmitter, NativeModules } from "react-native";
import { handleError } from "@groundcover/rum-core";

import { warnOnce } from "../internal/safe-warn";

import {
  NATIVE_EVENT_CHANNEL,
  NATIVE_MODULE_NAME,
  type GroundcoverNativeModule,
  type NativeFrameSegment,
  type NativeInitConfig,
  type NativeInitResult,
  type NativeSignal,
  type NativeStackFrame,
  type PendingCrashRecord,
  type PendingJsFatal,
} from "./native-types";

// The single seam to the native engines: nothing else touches NativeModules or
// NativeEventEmitter, so "no native module" is handled in one place — every JS feature
// keeps working and the four native listeners simply never arm (the Expo Go story).
//
// Unlike the optional PEER modules in optional-modules.ts this one is autolinked from
// inside this package, so there is no require() to guard — only a lookup that comes
// back undefined on an Expo Go binary or one built before the native module existed.

const NO_FEATURES: NativeInitResult = {
  crashes: false,
  hangs: false,
  appStart: false,
  vitals: false,
  gestures: false,
  gesturesAttached: false,
};

export function loadNativeModule(): GroundcoverNativeModule | null {
  try {
    const modules = NativeModules as Record<string, unknown> | undefined;
    const mod = modules?.[NATIVE_MODULE_NAME];
    return mod ? (mod as GroundcoverNativeModule) : null;
  } catch (error) {
    handleError(error);
    return null;
  }
}

/**
 * Arms the native engines and reports back WHICH features actually attached.
 * The result is not cosmetic: gesture suppression keys on it, so a tracker that
 * failed to attach (OS gate, hostile Window.Callback, no key window) leaves the
 * JS classifier in charge instead of silently losing the signal.
 */
export async function initNative(
  mod: GroundcoverNativeModule,
  config: NativeInitConfig
): Promise<NativeInitResult> {
  try {
    const raw = await mod.nativeInit(JSON.stringify(config));
    const parsed = JSON.parse(raw) as Partial<NativeInitResult> | null;
    if (!parsed || typeof parsed !== "object") return NO_FEATURES;
    // A non-empty STRING or nothing. The value reaches a console warning and a
    // template string, so a number or an object from a binary one version ahead
    // would render as "[object Object]" in the customer's log — noise that reads
    // like an SDK bug. An empty string is treated as absent for the same reason:
    // it would produce a warning that names no cause.
    const reason = parsed.crashesUnavailable;
    const crashesUnavailable = typeof reason === "string" && reason.length > 0 ? reason : undefined;

    return {
      crashes: parsed.crashes === true,
      hangs: parsed.hangs === true,
      appStart: parsed.appStart === true,
      vitals: parsed.vitals === true,
      gestures: parsed.gestures === true,
      // Absent from a binary one version behind, which is the same as "not attached yet" —
      // that build only ever announces an attach through the signal, so falling back to
      // false leaves JS in charge rather than suppressing a gesture nobody measures.
      gesturesAttached: parsed.gesturesAttached === true,
      // Same fallback, same reason: a binary that predates the field cannot promise coverage it
      // was never asked about, and guessing yes there would stop JS capturing modal gestures
      // that nothing native measures.
      gesturesCoverAllSurfaces: parsed.gesturesCoverAllSurfaces === true,
      ...(crashesUnavailable ? { crashesUnavailable } : {}),
    };
  } catch (error) {
    handleError(error);
    return NO_FEATURES;
  }
}

/** Reads persisted crash reports WITHOUT clearing them — native keeps each
 *  record until JS acks delivery, which is what makes redelivery on the next
 *  launch the failure mode instead of data loss. */
export async function readPendingCrashReports(
  mod: GroundcoverNativeModule
): Promise<Array<PendingCrashRecord | PendingJsFatal>> {
  try {
    const raw = await mod.getPendingCrashReports();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap<PendingCrashRecord | PendingJsFatal>(raw => {
      if (isRecord(raw) && typeof raw.jsFatalId === "string" && raw.jsFatalId.length > 0) {
        return [{
          jsFatalId: raw.jsFatalId,
          event: raw.event,
          sessionSnapshotJson: typeof raw.sessionSnapshotJson === "string" ? raw.sessionSnapshotJson : null,
        }];
      }
      return isAckableRecord(raw) ? [toCrashRecord(raw)] : [];
    });
  } catch (error) {
    handleError(error);
    return [];
  }
}

/** A record as it comes off disk: the ack key is verified, everything else is
 *  whatever the JSON happened to hold. */
type RawCrashRecord = { id: string } & Partial<Record<keyof PendingCrashRecord, unknown>>;

/**
 * Whether a record can be acknowledged — the only property worth FILTERING on;
 * everything else is coerced by [toCrashRecord]. `id` is the ack key, so a record
 * without one is reported and then acked as `clearPendingCrashReports([undefined])`,
 * which deletes nothing: the same crash is redelivered on every launch for the life of
 * the install, holding a pending slot against real reports.
 */
function isAckableRecord(record: unknown): record is RawCrashRecord {
  if (typeof record !== "object" || record === null) return false;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
}

/**
 * Coerce a parsed record to the shape its type promises — a trust boundary, since the JSON comes
 * off the device's disk possibly written by another SDK version. An `id` check alone would let a
 * non-string `errorMessage` ship as an `error_message` the schema calls a string, fingerprinted
 * from a stringified object.
 *
 * COERCED, never dropped: each fallback is what the drain would use for an absent field, so a
 * malformed one costs exactly what a missing one does. `screen` stays absent when unusable, or
 * the drain's snapshot-screen fallback is silently lost.
 */
function toCrashRecord(raw: RawCrashRecord): PendingCrashRecord {
  return {
    id: raw.id,
    // NaN, not 0: `msToNs` yields NaN and the enricher's `timestamp || now` treats it
    // as absent. `Number.isFinite` rather than `typeof`, so the invariant is local —
    // Infinity would survive `|| now` and reach the wire as a null timestamp.
    crashEpochMs: Number.isFinite(raw.crashEpochMs) ? (raw.crashEpochMs as number) : NaN,
    // Empty, so the drain's own "NativeCrash" / "Native crash" defaults apply.
    errorType: typeof raw.errorType === "string" ? raw.errorType : "",
    errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : "",
    stacktrace: normalizeStackFrames(raw.stacktrace),
    // Spread into `error_metadata`, so a non-object decomposes rather than
    // throwing — a string becomes one attribute per character, burying the
    // native markers.
    metadata: capCauseChain(isRecord(raw.metadata) ? (raw.metadata as Record<string, unknown>) : {}),
    sessionSnapshotJson: typeof raw.sessionSnapshotJson === "string" ? raw.sessionSnapshotJson : null,
    // Both members must be strings, not just present: the drain PREFERS record.screen over
    // the snapshot's, so a half-typed `{ name: 5 }` off a corrupt or cross-version disk record
    // would otherwise ship a stringified non-string in place of a valid screen. Absent (not
    // empty) on failure, so the snapshot-screen fallback still applies.
    ...(isValidScreen(raw.screen) ? { screen: raw.screen } : {}),
  };
}

/**
 * Upper bound on the `caused by` chain a record may carry.
 *
 * Deliberately ABOVE the producers' own limit (Kotlin's `MAX_CAUSE_DEPTH = 5`; iOS writes no
 * chain at all) because this is a resource guard, not a restatement of that contract — if the
 * native cap is ever raised, this must not silently truncate chains a producer legitimately
 * wrote. Anything past 20 could only come from a corrupt or hand-written file.
 */
const MAX_CAUSE_ENTRIES = 20;

/**
 * Bounds the cause chain a record off disk can carry.
 *
 * Nothing else enforces the producers' cap on this side, so a corrupt record can carry an
 * arbitrarily long chain — mapped over by the drain's redaction step and then spread into
 * `error_metadata`, reaching the wire in full and delaying every crash queued behind it.
 *
 * Enforced HERE, at the trust boundary, and not in the drain's `redactCauseMessages`: that step
 * only runs when `shouldMaskErrors` is set, so privacy level `allow` would keep the hole open.
 * Truncated from the TAIL — the head of the chain is the exception the app actually threw, and
 * the deepest causes are the ones a reader needs least.
 */
function capCauseChain(metadata: Record<string, unknown>): Record<string, unknown> {
  const causes = metadata.causes;
  if (!Array.isArray(causes) || causes.length <= MAX_CAUSE_ENTRIES) return metadata;
  return { ...metadata, causes: causes.slice(0, MAX_CAUSE_ENTRIES) };
}

/**
 * Keeps only frames a consumer can actually render — present, with a string `filename` — and
 * makes the other three fields match the type this returns.
 *
 * Shared with the live hang path (`hangs-listener`) on purpose. Both build an
 * `error_stacktrace` from a `NativeStackFrame[]` that native produced, and the two must not
 * disagree — least of all by trusting the record more, since it is the LESS trustworthy source of
 * the two: it comes off the device's disk, possibly written by a different SDK version. One
 * predicate, both callers.
 *
 * `filename` gates, the rest COERCE — the same split `toCrashRecord` makes, and for the same
 * reason: a frame without a filename symbolicates to nothing and is worth dropping, while one
 * whose `function` came across as a number is still a real frame at a real address. Checking
 * `filename` alone while asserting the full four-field type would let a cross-version record ship
 * `function`/`lineno`/`colno` absent or wrongly typed under a predicate that promises otherwise.
 * The fallbacks are the documented values: no symbol is `""`, and `lineno` is 0 for native frames
 * regardless, since line info needs server-side symbolication.
 */
export function normalizeStackFrames(frames: unknown): NativeStackFrame[] {
  if (!Array.isArray(frames)) return [];
  return frames
    .filter((frame): frame is Record<string, unknown> => !!frame && typeof frame.filename === "string")
    .map((frame) => ({
      filename: frame.filename as string,
      function: typeof frame.function === "string" ? frame.function : "",
      lineno: typeof frame.lineno === "number" && Number.isFinite(frame.lineno) ? frame.lineno : 0,
      colno: typeof frame.colno === "number" && Number.isFinite(frame.colno) ? frame.colno : 0,
    }));
}

/**
 * A screen the drain can attribute a crash to: both members strings, and not the
 * "I could not read one" sentinel.
 *
 * The emptiness half is load-bearing. BOTH native mappers write `screen` unconditionally and
 * fall back to `{name:"", key:""}` when they cannot lift one out of the snapshot
 * (`GcRumScreenSnapshot.screenFrom`, and Swift's `screen["name"] as? String ?? ""`), so a
 * types-only check would make `record.screen` always truthy and the drain's `?? snapshot.screen`
 * fallback unreachable: a crash whose screen native failed to read would ship with no screen,
 * even though JS's own read of the same snapshot string would succeed.
 *
 * Only the FULLY empty sentinel is rejected: one populated member is real information, and
 * discarding it would fall back to a snapshot screen that may be staler.
 */
function isValidScreen(value: unknown): value is { name: string; key: string } {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.key !== "string") {
    return false;
  }
  return value.name !== "" || value.key !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function clearPendingCrashReports(
  mod: GroundcoverNativeModule,
  ids: string[]
): Promise<void> {
  if (!ids.length) return;
  try {
    await mod.clearPendingCrashReports(ids);
  } catch (error) {
    handleError(error);
  }
}

/**
 * Asks native to close the open frame segment and hand it over. Resolves to `null` for
 * every kind of "nothing to report" — no frames, a malformed payload, a rejection, an
 * old binary — because the caller is a screen change and must never depend on native.
 */
export async function flushFrameSegment(
  mod: GroundcoverNativeModule
): Promise<NativeFrameSegment | null> {
  try {
    // Absent on a binary without this method — Metro serves fresh JS against the INSTALLED
    // engine, and an OTA bundle can outrun the app in the store. Going quiet is the right
    // degradation; going quiet SILENTLY is not. On such a binary every other native signal
    // still works, so frame vitals alone would read as a dead feature. One line here says why.
    if (typeof mod.flushFrameSegment !== "function") {
      warnOnce(
        `[groundcover] this build's native engine has no frame-segment support, so frame vitals ` +
          `will not be reported. The installed app predates the JavaScript bundle — rebuild the ` +
          `app (a Metro reload updates JS only). (groundcoverIgnore)`
      );
      return null;
    }
    const raw = await mod.flushFrameSegment();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isFrameSegment(parsed)) return null;
    return withoutNonFiniteOptionals(parsed, OPTIONAL_NUMERIC_PAYLOAD_FIELDS.frame_segment ?? []);
  } catch (error) {
    handleError(error);
    return null;
  }
}

/**
 * Valid JSON of the WRONG SHAPE is the dangerous case: an undefined `slow` or `total`
 * reaching the listener ships empty counts that look like real measurements.
 *
 * `Number.isFinite`, not `typeof === "number"`, which is what the paragraph above
 * actually requires: `JSON.parse('{"total":1e999}')` yields `Infinity`, which passes a
 * `typeof` check and then reaches the wire as `null` after `JSON.stringify` — a
 * schema-declared number arriving null. NaN does the same. The PUSH path (`normalizeSignal`)
 * uses `Number.isFinite` for these same fields, and the two paths must agree.
 */
function isFrameSegment(value: unknown): value is NativeFrameSegment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isFinite(candidate.segmentStartMs) &&
    Number.isFinite(candidate.segmentEndMs) &&
    Number.isFinite(candidate.total) &&
    Number.isFinite(candidate.slow) &&
    Number.isFinite(candidate.frozen) &&
    Number.isFinite(candidate.refreshRate) &&
    typeof candidate.reason === "string"
  );
}

/**
 * Fields that may legitimately be ABSENT but must be finite when present.
 *
 * Kept as a table beside [NUMERIC_PAYLOAD_FIELDS] and used by BOTH directions, because the two
 * have to agree: the pull path (`flushFrameSegment`) and the push path (`normalizeSignal`)
 * deliver the same payload type to the same consumer, so a value one of them strips and the
 * other forwards is a difference the consumer cannot see coming. Frame segments arrive both
 * ways — pulled on a screen change, pushed on the background and safety caps.
 */
/**
 * Payload fields that must arrive as STRINGS, per kind. Separate from the numeric table
 * because the rule is different: the numeric fields are checked for a finite VALUE, these
 * only for the type.
 *
 * Both paths require `reason` to be a string — the pull path in `isFrameSegment`, the push
 * path through this table. Checking it on one side only would let a `reason: 7` cross one
 * way and not the other, although both directions hand the same payload type to the same
 * consumer. Same argument as the numeric fields.
 *
 * TYPE only, deliberately. An unexpected string VALUE still passes — a binary one version
 * ahead may have a reason this bundle has never heard of, and dropping the segment would
 * lose a real measurement over a label.
 */
const REQUIRED_STRING_PAYLOAD_FIELDS: Partial<Record<NativeSignal["kind"], readonly string[]>> = {
  frame_segment: ["reason"],
};

const OPTIONAL_NUMERIC_PAYLOAD_FIELDS: Partial<Record<NativeSignal["kind"], readonly string[]>> = {
  frame_segment: ["delayMs", "budgetMs"],
};

/**
 * Drops the fields named above when they arrive non-finite, rather than rejecting the payload
 * that carries them.
 *
 * The asymmetry with the REQUIRED fields is deliberate, and it is the same judgement
 * `NativeFrameSegmentReason` already documents: absent is a case these optionals ALREADY have
 * to handle, because a native binary one version behind does not send them — the listener says
 * so out loud instead of going quiet. So treating a garbage value as absent costs exactly what
 * a missing one costs. Rejecting the whole segment instead would throw away the counts, the
 * refresh rate and both timestamps over one spoiled metric.
 *
 * Copies only when it has to, since this runs on the push path for every segment.
 */
function withoutNonFiniteOptionals<T extends Record<string, unknown>>(
  payload: T,
  optionalFields: readonly string[]
): T {
  // `in`, not a truthiness check: an explicit `delayMs: null` or `: undefined` IS present and
  // is exactly the case worth stripping, while an absent field must stay absent.
  const spoiled = optionalFields.filter(
    (field) => field in payload && !Number.isFinite(payload[field])
  );
  if (!spoiled.length) return payload;

  const clean: Record<string, unknown> = { ...payload };
  for (const field of spoiled) delete clean[field];
  return clean as T;
}

export type NativeSignalHandler = (signal: NativeSignal) => void;

export type NativeSubscription = {
  /**
   * Detaches the emitter listener. Returns `true` on success, `false` if removal threw (already
   * reported via handleError). The caller MUST treat `false` as "still attached" and keep its
   * reference — dropping it and re-subscribing would stack a second listener, so every native
   * signal would then fire twice.
   */
  remove(): boolean;
};

/**
 * Subscribes to the one emitter channel. Signals are dispatched by `kind`, and
 * an UNKNOWN kind is dropped silently — an OTA JS bundle can be older than the
 * installed binary, and a forward-compatible signal must not throw inside the
 * emitter callback.
 */
export function subscribeNativeSignals(
  mod: GroundcoverNativeModule,
  handler: NativeSignalHandler
): NativeSubscription | null {
  try {
    const emitter = new NativeEventEmitter(mod as never);
    const subscription = emitter.addListener(NATIVE_EVENT_CHANNEL, (raw: unknown) => {
      try {
        const signal = normalizeSignal(raw);
        if (signal) handler(signal);
      } catch (error) {
        handleError(error);
      }
    });
    return {
      remove() {
        try {
          subscription.remove();
          return true;
        } catch (error) {
          handleError(error);
          return false;
        }
      },
    };
  } catch (error) {
    handleError(error);
    return null;
  }
}

/**
 * Every kind this bundle understands, and the payload fields that must arrive as finite
 * numbers. One table, so `Record<NativeSignal["kind"], …>` makes the compiler demand an
 * entry when a kind is added. Union-typed strings are deliberately unchecked: an
 * unexpected string is still valid telemetry, and dropping the signal loses a real
 * measurement.
 */
const NUMERIC_PAYLOAD_FIELDS: Record<NativeSignal["kind"], readonly string[]> = {
  hang: ["startedAtMs", "durationMs"],
  app_start: ["startMs", "firstFrameMs"],
  frame_segment: ["segmentStartMs", "segmentEndMs", "total", "slow", "frozen", "refreshRate"],
  gesture: [
    "startedAtMs",
    "endedAtMs",
    "startX",
    "startY",
    "endX",
    "endY",
    "distanceDp",
    "velocityDpS",
    "pointerCount",
  ],
  gestures_attached: [],
  ping: [],
};

/**
 * Both halves of the version-skew guard. The binary and the bundle ship separately, so
 * a native engine a release ahead can rename a field: `Math.round(undefined)` is NaN,
 * which `JSON.stringify` writes as `null` where the schema promises a number.
 *
 * DROPPED, unlike the crash-record boundary's coercion, and for the opposite reason —
 * these signals are high-volume and interchangeable, while a zero-filled gesture would
 * assert a movement the user never made.
 */
function normalizeSignal(raw: unknown): NativeSignal | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, payload } = raw as { kind?: unknown; payload?: unknown };
  if (typeof kind !== "string") return null;
  const numericFields = NUMERIC_PAYLOAD_FIELDS[kind as NativeSignal["kind"]] as readonly string[] | undefined;
  if (!numericFields) return null;
  // `Array.isArray` as well as the object check, because `typeof [] === "object"`. An array
  // passes every numeric-field test for the two zero-field kinds (`ping`, `gestures_attached`),
  // so it would reach a handler declared to take `Record<string, never>` — and the field reads a
  // handler for any OTHER kind performs would silently be `undefined`.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const fields = payload as Record<string, unknown>;
  // `Number.isFinite` does not coerce, so a numeric STRING is rejected too — the
  // bridge sends JSON numbers, and a string here means the contract already broke.
  if (!numericFields.every((field) => Number.isFinite(fields[field]))) return null;
  const stringFields = REQUIRED_STRING_PAYLOAD_FIELDS[kind as NativeSignal["kind"]] ?? [];
  if (!stringFields.every((field) => typeof fields[field] === "string")) return null;
  // The OPTIONAL metrics get finite-or-absent treatment rather than failing the signal, and
  // they get it HERE as well as on the pull path: both directions hand the same payload type
  // to the same consumer, and a frame segment arrives both ways — pulled on a screen change,
  // pushed on the background and safety caps. Validating them in `numericFields` instead
  // would drop a whole segment over one spoiled metric, which is the opposite of the call
  // [withoutNonFiniteOptionals] documents.
  const optionalFields = OPTIONAL_NUMERIC_PAYLOAD_FIELDS[kind as NativeSignal["kind"]];
  const clean = optionalFields ? withoutNonFiniteOptionals(fields, optionalFields) : payload;
  return { kind, payload: clean } as NativeSignal;
}
