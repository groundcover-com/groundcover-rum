import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionState } from './session-state';
import { msToNs } from '../common/global';
import { PlatformStorage, SafeStorage } from '../common/storage';
import { MemoryStorage } from '../test-utils/memory-storage';

const hostStorage = new MemoryStorage();

// Session identity/activity state belongs to SessionState, not ConfigManager.
// Config-only suites are in src/config/config-manager.test.ts.
describe('SessionState', () => {
  let sessionState: SessionState;

  beforeEach(() => {
    hostStorage.clear();
    sessionState = new SessionState({ storage: new SafeStorage(hostStorage) });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getSessionId', () => {
    let storageMock: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      storageMock = {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      // Inject the spy-able backend via DI instead of patching hostStorage.
      sessionState = new SessionState({
        storage: new SafeStorage(storageMock as PlatformStorage),
      });
    });

    it('should return the in-memory session id when set', () => {
      sessionState.setSessionId('memory-session-id');
      storageMock.getItem.mockReturnValue('storage-session-id');

      expect(sessionState.getSessionId()).toBe('memory-session-id');
      expect(storageMock.getItem).not.toHaveBeenCalled();
    });

    it('should fall back to storage gcId when no in-memory value', () => {
      storageMock.getItem.mockReturnValue('storage-session-id');

      expect(sessionState.getSessionId()).toBe('storage-session-id');
      expect(storageMock.getItem).toHaveBeenCalledWith('gcId');
    });

    it('should return empty string when both in-memory and storage are empty', () => {
      storageMock.getItem.mockReturnValue(null);

      expect(sessionState.getSessionId()).toBe('');
    });
  });

  describe('getSessionMaxDuration', () => {
    // The cap is not read from config directly: SessionState receives an
    // injected getMaxDurationMs provider, which the composition root wires to
    // the live config. A provider closing over a mutable value stands in for
    // that wiring here.
    let maxDurationMs: number | undefined;

    beforeEach(() => {
      maxDurationMs = undefined;
      sessionState = new SessionState({
        storage: new SafeStorage(hostStorage),
        getMaxDurationMs: () => maxDurationMs,
      });
    });

    it('returns the configured value after initialize', () => {
      maxDurationMs = 5 * 60 * 60 * 1000;
      expect(sessionState.getSessionMaxDuration()).toBe(5 * 60 * 60 * 1000);
    });

    it('returns the 4-hour default when no config is initialized', () => {
      // No provider at all — the composition root hasn't wired config yet.
      const bare = new SessionState({ storage: new SafeStorage(hostStorage) });
      expect(bare.getSessionMaxDuration()).toBe(4 * 60 * 60 * 1000);
    });

    it('returns the 4-hour default when the option is omitted at init', () => {
      // Provider is wired but the config option is unset (undefined).
      expect(sessionState.getSessionMaxDuration()).toBe(4 * 60 * 60 * 1000);
    });
  });

  describe('getSessionElapsedMs', () => {
    const START_MS = 1_700_000_000_000;

    it('returns 0 when no start time is recorded', () => {
      expect(sessionState.getSessionElapsedMs(START_MS)).toBe(0);
    });

    it('returns elapsed ms since the recorded start', () => {
      sessionState.setSessionStartTime(msToNs(START_MS));
      expect(sessionState.getSessionElapsedMs(START_MS + 45_000)).toBe(45_000);
    });
  });

  describe('isSessionExpired', () => {
    const START_MS = 1_700_000_000_000;
    // Injected cap provider — wired to config by the composition root; a
    // mutable closure stands in for it here.
    let maxDurationMs: number | undefined;

    beforeEach(() => {
      maxDurationMs = undefined;
      sessionState = new SessionState({
        storage: new SafeStorage(hostStorage),
        getMaxDurationMs: () => maxDurationMs,
      });
    });

    it('returns false when no start time is recorded', () => {
      expect(sessionState.isSessionExpired(START_MS)).toBe(false);
    });

    it('returns false within the cap', () => {
      maxDurationMs = 60_000;
      sessionState.setSessionStartTime(msToNs(START_MS));
      expect(sessionState.isSessionExpired(START_MS + 30_000)).toBe(false);
    });

    it('returns true once the cap is reached', () => {
      maxDurationMs = 60_000;
      sessionState.setSessionStartTime(msToNs(START_MS));
      expect(sessionState.isSessionExpired(START_MS + 61_000)).toBe(true);
    });

    it('uses the 4-hour default when sessionMaxDuration is omitted', () => {
      sessionState.setSessionStartTime(msToNs(START_MS));
      expect(sessionState.isSessionExpired(START_MS + 3 * 60 * 60 * 1000)).toBe(false);
      expect(sessionState.isSessionExpired(START_MS + 5 * 60 * 60 * 1000)).toBe(true);
    });
  });

  describe('lastActivity tracking', () => {
    const NOW_MS = 1_700_000_000_000;
    let storageMock: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      storageMock = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      sessionState = new SessionState({
        storage: new SafeStorage(storageMock as PlatformStorage),
      });
    });

    it('returns 0 when no activity was ever recorded', () => {
      expect(sessionState.getLastActivityMs()).toBe(0);
    });

    it('falls back to storage gcLastActivity when no in-memory value', () => {
      storageMock.getItem.mockReturnValue(String(NOW_MS));
      expect(sessionState.getLastActivityMs()).toBe(NOW_MS);
      expect(storageMock.getItem).toHaveBeenCalledWith('gcLastActivity');
    });

    it('prefers the in-memory value over storage', () => {
      sessionState.setLastActivityMs(NOW_MS);
      storageMock.getItem.mockReturnValue(String(NOW_MS - 999));
      expect(sessionState.getLastActivityMs()).toBe(NOW_MS);
    });

    it('persists the first stamp, then throttles writes to once per minute', () => {
      sessionState.setLastActivityMs(NOW_MS);
      expect(storageMock.setItem).toHaveBeenCalledWith('gcLastActivity', String(NOW_MS));

      // Within the throttle window: memory updates, storage does not.
      storageMock.setItem.mockClear();
      sessionState.setLastActivityMs(NOW_MS + 30_000);
      expect(sessionState.getLastActivityMs()).toBe(NOW_MS + 30_000);
      expect(storageMock.setItem).not.toHaveBeenCalled();

      // Past the throttle window: persisted again.
      sessionState.setLastActivityMs(NOW_MS + 61_000);
      expect(storageMock.setItem).toHaveBeenCalledWith('gcLastActivity', String(NOW_MS + 61_000));
    });

    it('setSessionStartTime leaves the session unconfirmed and clears the stored clock', () => {
      sessionState.setLastActivityMs(NOW_MS); // a prior stamp
      sessionState.setSessionStartTime(msToNs(NOW_MS));
      // Birth does NOT stamp the clock — it stays 0 (unconfirmed) until real presence.
      expect(sessionState.getLastActivityMs()).toBe(0);
      expect(storageMock.removeItem).toHaveBeenCalledWith('gcLastActivity');
    });

    // The host-suspend hook does not live at this layer: the platform's
    // session wiring owns lifecycle events and calls persistLastActivity()
    // itself. The tests below cover the PUBLIC persistLastActivity() contract;
    // suspend-event registration/teardown is tested by the platform package.
    it('persistLastActivity() persists the exact timestamp so a restart never reads a stale clock', () => {
      sessionState.setLastActivityMs(NOW_MS); // persisted (first write)
      sessionState.setLastActivityMs(NOW_MS + 30_000); // throttled: memory only
      storageMock.setItem.mockClear();

      // The host's hide wiring calls this to flush the exact in-memory value.
      sessionState.persistLastActivity();

      expect(storageMock.setItem).toHaveBeenCalledWith('gcLastActivity', String(NOW_MS + 30_000));
    });

    it('persistLastActivity() does not resurrect gcLastActivity after clearSessionState', () => {
      sessionState.setLastActivityMs(NOW_MS);
      sessionState.clearSessionState();
      storageMock.setItem.mockClear();

      // The null guard: a stray flush after teardown must not re-create the key.
      sessionState.persistLastActivity();

      expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it('persistLastActivity() does not resurrect gcLastActivity after setSessionStartTime (session birth)', () => {
      sessionState.setLastActivityMs(NOW_MS);
      sessionState.setSessionStartTime(msToNs(NOW_MS)); // birth removes gcLastActivity
      storageMock.setItem.mockClear();

      // The null guard again: an unconfirmed newborn has no clock to flush.
      sessionState.persistLastActivity();

      expect(storageMock.setItem).not.toHaveBeenCalledWith('gcLastActivity', expect.anything());
    });
  });

  describe('clearSessionState', () => {
    let storageMock: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      storageMock = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      sessionState = new SessionState({
        storage: new SafeStorage(storageMock as PlatformStorage),
      });
    });

    it('removes all session-scoped storage keys', () => {
      sessionState.clearSessionState();

      expect(storageMock.removeItem).toHaveBeenCalledWith('gcId');
      expect(storageMock.removeItem).toHaveBeenCalledWith('gcStartTime');
      expect(storageMock.removeItem).toHaveBeenCalledWith('gcLastActivity');
    });

    it('resets the in-memory mirrors so a re-init starts clean', () => {
      sessionState.setSessionId('old-id');
      sessionState.setSessionStartTime(1_700_000_000_000 * 1_000_000);
      sessionState.setLastActivityMs(1_700_000_000_000);

      sessionState.clearSessionState();

      expect(sessionState.getSessionId()).toBe('');
      expect(sessionState.getSessionStartTime()).toBe(0);
      expect(sessionState.getLastActivityMs()).toBe(0);
      // The persist throttle also resets: the next stamp writes immediately.
      storageMock.setItem.mockClear();
      sessionState.setLastActivityMs(1_700_000_000_001);
      expect(storageMock.setItem).toHaveBeenCalledWith('gcLastActivity', String(1_700_000_000_001));
    });
  });

  describe('isSessionInactive', () => {
    const NOW_MS = 1_700_000_000_000;
    const THIRTY_MIN_MS = 30 * 60 * 1000;

    beforeEach(() => {
      sessionState = new SessionState({
        storage: new SafeStorage({
          getItem: vi.fn().mockReturnValue(null),
          setItem: vi.fn(),
          removeItem: vi.fn(),
        } as PlatformStorage),
      });
    });

    it('returns false when no activity was ever recorded', () => {
      expect(sessionState.isSessionInactive(NOW_MS)).toBe(false);
    });

    it('returns false within the idle window', () => {
      sessionState.setLastActivityMs(NOW_MS);
      expect(sessionState.isSessionInactive(NOW_MS + THIRTY_MIN_MS - 1)).toBe(false);
    });

    it('returns true once the idle window has elapsed', () => {
      sessionState.setLastActivityMs(NOW_MS);
      expect(sessionState.isSessionInactive(NOW_MS + THIRTY_MIN_MS)).toBe(true);
    });

    it('is inactive from birth when unstamped and past the window (sessionStartTime fallback)', () => {
      // No genuine activity yet (clock unstamped, 0); the gap is measured from the
      // session start, so a newborn born past the idle window reads as inactive.
      sessionState.setSessionStartTime(msToNs(NOW_MS - THIRTY_MIN_MS - 60_000));
      expect(sessionState.getLastActivityMs()).toBe(0);
      expect(sessionState.isSessionInactive(NOW_MS)).toBe(true);
    });

    it('is not inactive when unstamped but born within the window', () => {
      sessionState.setSessionStartTime(msToNs(NOW_MS - THIRTY_MIN_MS + 60_000));
      expect(sessionState.getLastActivityMs()).toBe(0);
      expect(sessionState.isSessionInactive(NOW_MS)).toBe(false);
    });
  });

  describe('user activity gate (single lastActivity signal)', () => {
    let store: Record<string, string>;
    let storageMock: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      store = {};
      storageMock = {
        getItem: vi.fn((k: string) => (k in store ? store[k] : null)),
        setItem: vi.fn((k: string, v: string) => {
          store[k] = v;
        }),
        removeItem: vi.fn((k: string) => {
          delete store[k];
        }),
      };
      sessionState = new SessionState({
        storage: new SafeStorage(storageMock as PlatformStorage),
      });
    });

    it('is unconfirmed (false) for a fresh session', () => {
      expect(sessionState.hasUserActivity()).toBe(false);
    });

    it('a genuine-activity stamp confirms the session and persists it', () => {
      sessionState.setLastActivityMs(1_700_000_000_000);
      expect(sessionState.hasUserActivity()).toBe(true);
      expect(store.gcLastActivity).toBe(String(1_700_000_000_000));
    });

    it('setSessionStartTime (session birth) resets to unconfirmed and clears the stored clock', () => {
      sessionState.setLastActivityMs(1_700_000_000_000);
      expect(sessionState.hasUserActivity()).toBe(true);

      sessionState.setSessionStartTime(msToNs(1_700_000_000_000));

      expect(sessionState.hasUserActivity()).toBe(false);
      expect('gcLastActivity' in store).toBe(false);
    });

    it('reads a persisted stamp from storage (restart of a confirmed session)', () => {
      // A prior process life stamped the clock; a fresh in-memory mirror reads
      // it back from storage so the restart keeps flushing.
      store.gcLastActivity = String(1_700_000_000_000);
      expect(sessionState.hasUserActivity()).toBe(true);
    });

    it('clearSessionState clears the stamp and resets the mirror', () => {
      sessionState.setLastActivityMs(1_700_000_000_000);

      sessionState.clearSessionState();

      expect(storageMock.removeItem).toHaveBeenCalledWith('gcLastActivity');
      expect(sessionState.hasUserActivity()).toBe(false);
    });
  });
});
