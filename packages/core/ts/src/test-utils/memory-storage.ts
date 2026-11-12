import type { PlatformStorage } from "../common/storage";

// In-memory PlatformStorage for tests: the shape every platform's backing
// store is adapted to, with no host storage behind it.
export class MemoryStorage implements PlatformStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
