// @groundcover/rum-core — the platform-agnostic core. Every class takes its dependencies through
// its constructor, and every platform touchpoint comes from the platform package; Logger and
// handleError are ambient by deliberate exception.
//
// This barrel is the intended surface for platform packages. A platform may import deep subpaths
// instead (`@groundcover/rum-core/<module>`) when its tests module-mock individual core modules
// and need 1:1 specifiers.
// config/, events/, session/ and privacy/ are a PEER CLUSTER, not layered.

// Event model + wire format
export * from "./events/types";

// Configuration
export * from "./config/types";
export * from "./config/constants";
export { SDKConfig, type ConfigExtension } from "./config/sdk-config";
export { ConfigManager } from "./config/config-manager";

// Session policy (state, rotation lifecycle, bootstrap, sampling)
export { SessionState, type SessionStateDeps } from "./session/session-state";
export {
  SessionLifecycle,
  type SessionLifecycleDeps,
  type SessionLifecycleHooks,
} from "./session/session-lifecycle";
export {
  bootstrapSession,
  resolveSamplingDecision,
  SAMPLING_STORAGE_KEY,
} from "./session/bootstrap";

// Event pipeline
export { EventEnricher, type EventEnricherDeps, type EnrichInput } from "./events/event-enricher";
export {
  EventsPool,
  MAX_GATED_BUFFER_EVENTS,
  isUsableEvent,
  type EventsPoolDeps,
  type DeviceAttributesProvider,
} from "./events/events-pool";
export { ManualEventEmitter, type ManualEventEmitterDeps } from "./events/manual-event-emitter";
export { BaseListener, type ListenerDeps } from "./events/listeners/base-listener";
export { LogEventsListener } from "./events/listeners/logs-events-listener";

// Shared listener logic: each platform intercepts, core shapes
export {
  generateTraceIds,
  isValidHeaderName,
  buildTraceHeaders,
  matchesPropagationUrl,
  extractTraceIds,
  type TraceIds,
} from "./events/network/trace";
export {
  NETWORK_BODY_PLACEHOLDER,
  mimeEssence,
  isTextualContentType,
  binaryLabel,
  classifyBody,
  isEventStream,
  isKnownEmptyResponse,
  capBody,
  utf8ByteLength,
} from "./events/network/body";
export { shouldIgnoreUrl, type IgnoreUrlOptions } from "./events/network/url-filter";
export { shapeNetworkEvent, formatNetworkHeaders, type NetworkShapeContext } from "./events/network/shape";
export {
  shapeErrorEvent,
  parseErrorStack,
  type StackFrame,
  type ErrorCaptureOptions,
} from "./events/errors/shape-error";
export { coerceToError, capturedError, className } from "./events/errors/coerce-error";

// Transport
export {
  Transporter,
  encodeInline,
  type TransporterDeps,
  type AsyncEncoder,
  type EncodedPayload,
  type BatchSender,
  type BatchRequest,
} from "./transporter/transporter";

// Privacy / redaction
export { resolvePrivacy, normalizeStringList, type EffectivePrivacy } from "./privacy/config";
export * from "./privacy/redaction";

// Platform contracts + utilities
export { SafeStorage, type PlatformStorage } from "./common/storage";
export { RandomIdGenerator, type IdGenerator } from "./common/id-generator";
export { Logger } from "./common/logger";
export { handleError } from "./common/error-handler";
export { PatchSet, type PatchSpec } from "./common/patch";
export { msToNs, nsToMs, MS_TO_NANOSECONDS } from "./common/global";
export { truncate, normalizeWhitespace } from "./common/text";
export { formatBody } from "./common/body-formatter";
