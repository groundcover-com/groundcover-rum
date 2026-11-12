import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bootstrapSession, resolveSamplingDecision, SAMPLING_STORAGE_KEY } from './bootstrap';
import { SessionState } from './session-state';
import { SafeStorage } from '../common/storage';
import { IdGenerator } from '../common/id-generator';
import { msToNs } from '../common/global';
import { SESSION_INACTIVITY_TIMEOUT_MS } from '../config/constants';
import { MemoryStorage } from '../test-utils/memory-storage';

const hostStorage = new MemoryStorage();

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const makeIdGenerator = (ids: string[]): IdGenerator => {
  let i = 0;
  return {
    generateId: () => ids[i++] ?? 'exhausted',
    generateSpanId: () => 'span',
    generateTraceId: () => 'trace',
  };
};

describe('resolveSamplingDecision', () => {
  let storage: SafeStorage;

  beforeEach(() => {
    hostStorage.clear();
    storage = new SafeStorage(hostStorage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('samples everything when no rate is configured', () => {
    expect(resolveSamplingDecision({ storage })).toBe(true);
    // Nothing persisted — an unconfigured rate is not a decision to remember.
    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBeNull();
  });

  it('samples everything at rate 1 without persisting', () => {
    expect(resolveSamplingDecision({ storage, sessionSampleRate: 1 })).toBe(true);
    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBeNull();
  });

  // A falsy check (`!sessionSampleRate`) would treat an explicit 0 as "unset"
  // and return true, so "sample nothing" would sample everything.
  it('samples NOTHING at rate 0, and persists that verdict', () => {
    expect(resolveSamplingDecision({ storage, sessionSampleRate: 0 })).toBe(false);
    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBe('0');
  });

  it('samples nothing at rate 0 even when Math.random() returns 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(resolveSamplingDecision({ storage, sessionSampleRate: 0 })).toBe(false);
  });

  it('rolls against the rate and persists the verdict', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    expect(resolveSamplingDecision({ storage, sessionSampleRate: 0.5 })).toBe(true);
    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBe('1');
  });

  it('reuses a stored verdict instead of re-rolling mid-session', () => {
    storage.setItem(SAMPLING_STORAGE_KEY, '0');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(resolveSamplingDecision({ storage, sessionSampleRate: 0.5 })).toBe(false);
    expect(random).not.toHaveBeenCalled();
  });

  it('treats a non-finite rate as unset rather than rolling against NaN', () => {
    expect(resolveSamplingDecision({ storage, sessionSampleRate: Number.NaN })).toBe(true);
  });

  it('still returns a verdict when storage throws', () => {
    const hostile = new SafeStorage({
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    expect(resolveSamplingDecision({ storage: hostile, sessionSampleRate: 0.5 })).toBe(false);
  });
});

describe('bootstrapSession', () => {
  let storage: SafeStorage;
  let session: SessionState;

  beforeEach(() => {
    hostStorage.clear();
    storage = new SafeStorage(hostStorage);
    session = new SessionState({ storage });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints an id when there is no session yet', () => {
    bootstrapSession({ session, idGenerator: makeIdGenerator(['fresh-id']) });

    expect(session.getSessionId()).toBe('fresh-id');
  });

  // The sampling verdict is documented as per-session; if nothing removed the
  // key, every post-rotation session would inherit the first roll.
  it('clears the sampling verdict when an init-time rotation mints a new id', () => {
    session.setSessionId('old-id');
    session.setSessionStartTime(msToNs(Date.now() - FOUR_HOURS_MS - 1_000));
    storage.setItem(SAMPLING_STORAGE_KEY, '1');

    bootstrapSession({ session, idGenerator: makeIdGenerator(['rotated-id']) });

    expect(session.getSessionId()).toBe('rotated-id');
    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBeNull();
  });

  it('clears the sampling verdict after an inactivity gap across restart', () => {
    session.setSessionId('old-id');
    session.setSessionStartTime(msToNs(Date.now() - 60_000));
    storage.setItem('gcLastActivity', String(Date.now() - SESSION_INACTIVITY_TIMEOUT_MS - 1_000));
    storage.setItem(SAMPLING_STORAGE_KEY, '1');

    bootstrapSession({ session, idGenerator: makeIdGenerator(['rotated-id']) });

    expect(session.getSessionId()).toBe('rotated-id');
    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBeNull();
  });

  it('clears the sampling verdict when a DIFFERENT session id is provided', () => {
    session.setSessionId('old-id');
    session.setSessionStartTime(msToNs(Date.now()));
    storage.setItem(SAMPLING_STORAGE_KEY, '1');

    bootstrapSession({
      session,
      idGenerator: makeIdGenerator([]),
      providedSessionId: 'synced-id',
    });

    expect(session.getSessionId()).toBe('synced-id');
    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBeNull();
  });

  it('KEEPS the sampling verdict when the same id is re-provided (continuation)', () => {
    session.setSessionId('same-id');
    session.setSessionStartTime(msToNs(Date.now()));
    storage.setItem(SAMPLING_STORAGE_KEY, '1');

    bootstrapSession({
      session,
      idGenerator: makeIdGenerator([]),
      providedSessionId: 'same-id',
    });

    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBe('1');
  });

  it('keeps the sampling verdict when no rotation happens', () => {
    session.setSessionId('current-id');
    session.setSessionStartTime(msToNs(Date.now()));
    storage.setItem(SAMPLING_STORAGE_KEY, '1');

    bootstrapSession({ session, idGenerator: makeIdGenerator([]) });

    expect(storage.getItem(SAMPLING_STORAGE_KEY)).toBe('1');
  });

  // Runs at SDK init: a throw here would take the host's init flow down with it.
  it('contains a throwing id generator instead of propagating to the host', () => {
    const exploding: IdGenerator = {
      generateId: () => {
        throw new Error('entropy source unavailable');
      },
      generateSpanId: () => 'span',
      generateTraceId: () => 'trace',
    };

    expect(() => bootstrapSession({ session, idGenerator: exploding })).not.toThrow();
  });
});
