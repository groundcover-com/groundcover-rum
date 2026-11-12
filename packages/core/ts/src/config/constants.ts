import { SDKOptions } from "./types";

export const DEFAULT_SESSION_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
export const MIN_SESSION_MAX_DURATION_MS = 60 * 1000;
export const MAX_SESSION_MAX_DURATION_MS = 8 * 60 * 60 * 1000;

// One idle window, two consumers: platform idle policies key off it (e.g.
// pausing a recording after this much input silence), and the lazy gap check
// rotates the session when user activity resumes after a gap this long.
export const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

// The activity clock is stamped on every user-interaction event; persist to
// the platform's storage at most this often. The gap check runs at 30-minute
// resolution, so a value up to a minute stale across a restart is harmless.
export const ACTIVITY_PERSIST_THROTTLE_MS = 60 * 1000;

// The persisted sampling verdict. Lives here rather than in session/bootstrap
// so SessionState can clear it alongside the other session-scoped keys without
// a circular import.
export const SAMPLING_STORAGE_KEY = "gcSample";

export const DEFAULT_SDK_CONFIG_OPTIONS: SDKOptions = {
  sessionSampleRate: 1,
  debug: false,
  privacy: { level: "mask-sensitive" },
  enabledEvents: [],
  tracing: {
    propagationUrls: [],
    propagationHeaders: [],
    traceIdHeaderName: "",
    spanIdHeaderName: "",
    origin: {
      name: "",
      value: "",
    },
  },
  transport: {
    batchSize: 10,
    batchTimeout: 10_000,
    compression: true,
  },
  sessionMaxDuration: DEFAULT_SESSION_MAX_DURATION_MS,
};
