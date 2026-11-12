// The JS side of the contract with the native engines. Everything crosses the bridge as
// JSON STRINGS rather than ReadableMap/NSDictionary: one codec per side, no per-field
// marshalling drift, and the same bytes can be persisted natively and replayed in a test.
// Every call is init-time or fire-and-forget, so stringify never lands on a hot path.
//
// WHAT ACTUALLY ENFORCES THIS CONTRACT:
//
// Nothing compares the three declarations of this shape to each other. Each side asserts its own
// idea of it, in its own language — `GcRumCrashRecordMapperTest` on the JVM,
// `GCRumCrashReportMapperTests` under `swift test`, `native-bridge.test.ts` in vitest — so all
// three can agree with themselves while disagreeing with one another.
//
// The one tier that crosses the bridge for real is the device suite:
// `tests/e2e/mobile/crashes/native-crash.spec.ts` pins `id`, `stacktrace` (with its frame
// fields), `metadata`, `sessionSnapshotJson` and `screen`, plus the error type, message and crash
// timestamp — those last three because every fallback in [toCrashRecord] converts a renamed field
// into a plausible value rather than an error, so nothing else would notice them going missing.
//
// So a rename IS caught, but only on a device shard, and only for asserted fields.
// packages/core/NATIVE_TESTING.md records which native units are twins — and which only look
// like it.

/** A stack frame, identical to core's `error_stacktrace` element shape. */
export type NativeStackFrame = {
  /** Native: the binary image name (iOS) or class name (Android JVM). */
  filename: string;
  /** Where in the image: "<symbol> + 0x<offset>", else "<image> + 0x<offset>" (a stripped
   *  build's own frames, which its dSYM resolves), else "0x<address>". */
  function: string;
  /** 0 for native frames — line info needs server-side symbolication. */
  lineno: number;
  colno: number;
};

/**
 * A crash captured and persisted by native code at CRASH TIME, drained by JS on
 * the next launch. Self-contained on purpose: it carries the session envelope
 * that was live when the process died, so the drainer can report it under the
 * session it actually belongs to rather than the fresh one.
 */
export type PendingCrashRecord = {
  /** Stable native report id — the ack key, and `error_metadata.crash_report_id`. */
  id: string;
  /** Crash time (epoch ms). Becomes the event timestamp — never the drain time. */
  crashEpochMs: number;
  /** Signal/mach exception name, NSException name, or JVM throwable class. */
  errorType: string;
  errorMessage: string;
  stacktrace: NativeStackFrame[];
  /** Native specifics (signal, thread, image UUID…) → `error_metadata`. */
  metadata: Record<string, unknown>;
  /** The `sessionAttributes` envelope JS last pushed; null when never pushed. */
  sessionSnapshotJson: string | null;
  /** Screen the user was on when the process died. Optional because the drain
   *  already treats it that way — absent falls back to the crashed session
   *  snapshot's screen, which is a better answer than an empty one. */
  screen?: { name: string; key: string };
};

/** Live main-thread stall, emitted on RECOVERY (a stall that killed the process
 *  arrives post-mortem via ApplicationExitInfo instead). */
export type NativeHangPayload = {
  kind: "anr" | "app_hang";
  startedAtMs: number;
  durationMs: number;
  /** Android captures the main-thread stack at threshold-crossing; iOS does not. */
  mainThreadStack?: NativeStackFrame[];
};

export type NativeAppStartPayload = {
  /**
   * NOT passed through blind — `resolveAppStartType` rejects anything else, because this string
   * selects which metric SERIES the value lands in rather than labelling it. `hot` is a foreground
   * return with the UI intact; `warm` is a rebuild of it.
   */
  type: "cold" | "warm" | "cold_prewarmed" | "hot";
  /**
   * Per-type anchor: cold = process start, warm = activity restart /
   * willEnterForeground, cold_prewarmed = module load. A warm start hours into a
   * live process must NOT be measured from process start.
   */
  startMs: number;
  firstFrameMs: number;
};

/**
 * Why native closed a frame segment. Mirrors Swift's `SegmentReason` and Kotlin's
 * `SegmentReason.wireValue`, checked by a native test on each side.
 *
 * The `(string & {})` arm makes the type HONEST: `isFrameSegment` only checks for a string, and
 * an OTA ships JS alone so the binary can be NEWER. Tightening the guard would return null and
 * make the caller discard the counts, refresh rate and both timestamps over one label.
 */
export type NativeFrameSegmentReason = "navigation" | "background" | "safety" | (string & {});

/**
 * One closed frame segment: every frame native counted between two screen
 * boundaries. NOT a fixed window — see the aggregators.
 *
 * Timestamps are epoch MILLISECONDS here (both platforms measure in ms) and are
 * converted to nanoseconds on the way to the wire.
 */
export type NativeFrameSegment = {
  segmentStartMs: number;
  segmentEndMs: number;
  total: number;
  slow: number;
  frozen: number;
  /** The display's NOMINAL rate — what the panel can do, not what was achieved. */
  refreshRate: number;
  /**
   * Milliseconds lost across every slow frame, summed — each frame's duration beyond the frame
   * budget. Becomes the `frames_delay_total` metric (the `_total` says it is the segment sum).
   *
   * OPTIONAL because a native binary one version behind does not send it. Absent means the frame
   * metric cannot be computed at all, which the listener says out loud rather than going quiet —
   * a silent gap would look exactly like a smooth app.
   */
  delayMs?: number;
  /**
   * The budget `slow` and `delayMs` were judged against, in milliseconds. Optional, as above.
   *
   * Not derivable from `refreshRate`: on an adaptive (ProMotion) panel iOS judges against the
   * ESTIMATED cadence, ~16.7ms on an idle 120Hz display against a nominal 8.33ms. Without this a
   * consumer recomputing our arithmetic from the wire gets a different answer.
   */
  budgetMs?: number;
  reason: NativeFrameSegmentReason;
};

export type NativeGestureDirection = "up" | "down" | "left" | "right";

/** A gesture the native tracker saw end. Coordinates are already converted to
 *  device-independent pixels natively so JS never guesses at density. */
export type NativeGesturePayload = {
  kind: "scroll" | "swipe";
  /**
   * TOUCH-DOWN time, not recognition time — the correlation window matches this
   * against the JS touch-start ring buffer, and recognizers fire well after the
   * finger lands (slop, pauses).
   */
  startedAtMs: number;
  endedAtMs: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  direction: NativeGestureDirection;
  distanceDp: number;
  velocityDpS: number;
  pointerCount: number;
};

/** Which native features actually armed. `nativeInit` reports this back so JS
 *  never suppresses its own capture in favour of a tracker that failed to
 *  attach (an OS version gate, a hostile Window.Callback, a missing window). */
export type NativeInitResult = {
  crashes: boolean;
  hangs: boolean;
  appStart: boolean;
  vitals: boolean;
  gestures: boolean;
  /**
   * Whether the gesture tracker is hooked to a window RIGHT NOW — as opposed to `gestures`,
   * which only says it was created. False on a first init, where the attach is still queued on
   * the main thread; the `gestures_attached` signal reports that one.
   *
   * This exists because that signal is edge-triggered and a fresh JS context misses an edge that
   * already passed: both engines return their cached status from a second `nativeInit` without
   * re-arming, so `attach()` never runs again and nothing is re-announced. Metro's fast-refresh
   * re-runs `init()` on every reload, so without this JS would come back suppressing nothing while
   * the tracker is still attached and measuring — two events per swipe, for the rest of the
   * session.
   */
  gesturesAttached: boolean;
  /**
   * Whether that tracker reaches EVERY surface the app can present, modals included — the same
   * claim the `gestures_attached` signal carries as `coversAllSurfaces`, repeated here for the
   * same reason `gesturesAttached` is.
   *
   * A re-init never sees the signal: the edge fired in a JS context that no longer exists. So
   * restoration reads coverage from this status; without it the replacement manager would assume
   * "attached, covers nothing" — wrong on iOS, where it would stop suppressing modal gestures
   * that native is still measuring. Two events per modal drag, after every fast refresh.
   *
   * Optional so an older binary still parses; absent reads as `false`, the conservative answer.
   */
  gesturesCoverAllSurfaces?: boolean;
  /**
   * Why crash capture is not running when it was asked for — another KSCrash owner
   * holding the iOS singleton, or a stranded handler owning the Android chain.
   * `crashes: false` alone reads identically to "the host never asked", so an app
   * would silently report nothing. Absent when nothing is wrong: presence IS the signal.
   */
  crashesUnavailable?: string;
};

export type NativeFeatureFlags = {
  crashes: boolean;
  hangs: boolean;
  appStart: boolean;
  vitals: boolean;
  gestures: boolean;
};

export type NativeInitConfig = {
  features: NativeFeatureFlags;
  thresholds: {
    hangThresholdMs: number;
    vitalsMaxSegmentMs: number;
  };
  /** Session envelope to attribute a crash to, when one is already available. */
  snapshotJson?: string | null;
  /**
   * Clear the stored envelope as the LAST step of this same `nativeInit` call, after the crash
   * harvest that reads it has run. For the unsampled path, which must harvest (a fatal from an
   * earlier sampled session is already on disk) and must then leave no envelope behind (a crash in
   * an unsampled session has to be unattributable, so the drain acks-and-drops it).
   *
   * A flag rather than the more obvious "an explicit `snapshotJson: null` means clear". Both
   * engines decode this from JSON, and "the key is present and null" is a signal any serializer
   * that omits null-valued keys silently downgrades to "the key is absent" — i.e. to "leave the
   * previous run's envelope on disk", which is the misattribution this exists to prevent. A boolean
   * cannot fail that way.
   *
   * `snapshotJson` wins if both are set: an envelope to install is a positive instruction, and
   * sending both is a caller bug rather than a state worth inventing semantics for.
   *
   * NOT a replacement for the JS-side clear that follows it — see `clearNativeSnapshot`. An
   * installed binary older than this JS bundle ignores the flag entirely, and the SDK ships JS
   * updates (Metro, OTA) independently of the app binary.
   */
  clearSnapshotAfterHarvest?: boolean;
};

/**
 * Announced when the tracker actually hooks something, and it carries WHAT it can hook.
 *
 * The two platforms cover different amounts of the app, and JavaScript cannot infer which:
 *  - iOS attaches per `UIWindow`, so a `Modal` — which renders into its own window — is covered.
 *  - Android attaches per ACTIVITY, and a `Modal` renders into a `Dialog`, which is not an
 *    Activity and never raises a lifecycle callback. That surface is invisible to it.
 *
 * Flattening this into "attached: yes" would silently drop every modal gesture on Android: JS
 * would stand down app-wide on the strength of the main activity being hooked, with nothing
 * watching the modal. Each tracker states its own reach instead, because it is the only thing
 * that knows.
 *
 * Optional so an OLD binary under a new JS bundle still parses; absent is read as `false`, the
 * conservative answer — JS keeps capturing rather than trusting coverage nobody claimed.
 */
export type NativeGesturesAttachedPayload = {
  /** True when the tracker hooks every surface the app can present, modals included. */
  coversAllSurfaces?: boolean;
};

/** Discriminated envelope on the single emitter channel. A `kind` JS does not
 *  know is IGNORED, not an error: an OTA JS update can be older than the
 *  installed binary. */
export type NativeSignal =
  | { kind: "hang"; payload: NativeHangPayload }
  | { kind: "app_start"; payload: NativeAppStartPayload }
  // A JS bundle that does not know a kind DROPS it, so a bundle and binary that
  // disagree degrade to no vitals rather than reading one payload's fields as another's.
  | { kind: "frame_segment"; payload: NativeFrameSegment }
  | { kind: "gesture"; payload: NativeGesturePayload }
  | { kind: "gestures_attached"; payload: NativeGesturesAttachedPayload }
  | { kind: "ping"; payload: Record<string, never> };

export type NativeSignalKind = NativeSignal["kind"];

/**
 * The bridge surface. Deliberately small, and deliberately ignorant of the DSN
 * and API key: native captures and persists, JS enriches and transports. The one
 * exception is the session snapshot, which native needs on disk to attribute a
 * crash after the JS runtime is gone.
 */
export type GroundcoverNativeModule = {
  nativeInit(configJson: string): Promise<string>;
  updateSessionSnapshot(snapshotJson: string | null): void;
  /** JSON array of `PendingCrashRecord`. Read-only — records survive until acked. */
  getPendingCrashReports(): Promise<string>;
  clearPendingCrashReports(ids: string[]): Promise<void>;
  /**
   * Closes the open frame segment and returns it as JSON, or `"null"`. A PULL rather than
   * a push because only JS knows the screen is about to change: a push crosses the bridge
   * asynchronously, so the segment would be attributed to the destination screen.
   */
  flushFrameSegment(): Promise<string>;
  /** Stops watchdogs/display links. The crash handler deliberately stays armed. */
  stop(): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  /**
   * The hardware model, e.g. `"iPhone17,1"` — an exported CONSTANT, not a method, so it is
   * readable synchronously on the very first event rather than after `nativeInit` resolves.
   *
   * Optional because a binary one version behind does not export it, and because Android does not
   * need it: RN's Android `Platform.constants` already carries `Model`, while its iOS counterpart
   * carries no model at all. See `nativeDeviceModel` in rn-platform.ts.
   */
  deviceModel?: string;
  /**
   * Android's `Build.DEVICE` codename (e.g. `"o1s"`), exported as a CONSTANT for the same
   * synchronous-first-event reason as `deviceModel`. Android-only: iOS does not set it, since its
   * model identifier already keys the marketing-name lookup. Absent on a binary a version behind.
   */
  deviceCodename?: string;
  /** E2E triggers, development builds only: both return at once unless the host app is debuggable
   *  (Android) or a simulator / provisioned development build (iOS), checked at runtime. */
  triggerTestCrash?(kind: string): void;
  blockMainThread?(ms: number): void;
};

/** Emitter channel name. One channel, `kind`-discriminated, so adding a signal
 *  never needs a new subscription on either side. */
export const NATIVE_EVENT_CHANNEL = "groundcover.rum";

/** Native module name as registered by both platforms. */
export const NATIVE_MODULE_NAME = "GroundcoverRum";
