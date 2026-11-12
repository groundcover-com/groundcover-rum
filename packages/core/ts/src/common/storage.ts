import { handleError } from "./error-handler";

// The single storage contract a host platform must provide. Synchronous by
// design: session state (id, start time, activity clock) is read during
// construction and on hot paths. An async-only backend must hydrate into a
// synchronous write-through cache BEFORE the SDK's composition root constructs
// anything that touches storage.
export interface PlatformStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Never-throwing wrapper around a PlatformStorage. Storage can fail in normal
// operation (disabled storage, privacy mode, quota) — reads degrade to null /
// fallback and writes are dropped, never surfaced to the host app.
export class SafeStorage {
  constructor(private readonly storage: PlatformStorage | null) {}

  getItem(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch (error) {
      handleError(error);
      return null;
    }
  }

  setItem(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value);
    } catch (error) {
      handleError(error);
    }
  }

  removeItem(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch (error) {
      handleError(error);
    }
  }

  getNumericItem(key: string, fallback: number = 0): number {
    const raw = this.getItem(key);
    if (raw === null) return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  }
}
