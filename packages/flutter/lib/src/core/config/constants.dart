const defaultSessionMaxDuration = Duration(hours: 4);
const minSessionMaxDuration = Duration(minutes: 1);
const maxSessionMaxDuration = Duration(hours: 8);

/// One idle window, two consumers: the lazy gap check rotates the session when
/// user activity resumes after a gap this long, and platform idle policies key
/// off it.
const sessionInactivityTimeout = Duration(minutes: 30);

/// The activity clock is stamped on every user interaction; it is persisted
/// at most this often. The gap check runs at 30-minute resolution, so a value
/// up to a minute stale across a restart is harmless.
const activityPersistThrottle = Duration(minutes: 1);

/// The persisted sampling verdict. Here rather than in the session bootstrap
/// so SessionState can clear it with the other session keys.
const samplingStorageKey = 'gcSample';

const defaultSessionSampleRate = 1.0;
const defaultBatchSize = 10;
const defaultBatchTimeout = Duration(seconds: 10);
const defaultCompression = true;
