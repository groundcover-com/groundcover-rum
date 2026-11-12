import { handleError } from "./error-handler";

/**
 * One host slot the SDK wraps — a global, a prototype method, a handler
 * registry. `get`/`set` read and write the slot; `wrap` builds our wrapper
 * around whatever is in it at install time.
 */
export interface PatchSpec<T> {
  get(): T;
  set(value: T): void;
  wrap(original: T): T;
}

type Installed = { spec: PatchSpec<unknown>; original: unknown; wrapped: unknown };

/**
 * The patch discipline every interceptor needs, in one place:
 *
 * - The original is captured at install time and recorded together with the
 *   wrapper, so teardown undoes exactly our layer.
 * - A group installs all-or-nothing: if any slot throws (a frozen prototype,
 *   a non-writable global), the slots already written are rolled back and
 *   the group is skipped. Separate groups fail independently — a frozen
 *   XMLHttpRequest must not cost the fetch capture.
 * - restore() puts an original back only where the slot still holds OUR
 *   wrapper. A host that wrapped on top of us keeps its wrapper; ours stays
 *   reachable through it, so a wrapper must also go inert on its own (the
 *   listeners' `active` flag) — restore alone can't retire it.
 * - Nothing here throws into the host.
 */
export class PatchSet {
  private installed: Installed[] = [];

  /** Install a group of patches atomically. Returns whether it was installed. */
  install<T extends unknown[]>(group: { [K in keyof T]: PatchSpec<T[K]> }): boolean {
    // Each slot keeps its own type at the call site; stored type-erased.
    const specs = group as unknown as ReadonlyArray<PatchSpec<unknown>>;
    const done: Installed[] = [];
    const originals: Array<{ spec: PatchSpec<unknown>; original: unknown }> = [];
    try {
      for (const spec of specs) {
        const original = spec.get();
        originals.push({ spec, original });
        const wrapped = spec.wrap(original);
        spec.set(wrapped);
        done.push({ spec, original, wrapped });
      }
      this.installed.push(...done);
      return true;
    } catch (error) {
      // Roll back every slot we touched — the one that threw included, since a
      // throwing setter may still have written. Each guarded: the write that
      // failed was probably to a slot that rejects writes alike.
      for (const { spec, original } of originals.reverse()) {
        try {
          if (spec.get() !== original) spec.set(original);
        } catch {
          /* nothing we can undo */
        }
      }
      handleError(error);
      return false;
    }
  }

  /** Stand every patch down, where the slot is still ours. Never throws. */
  restore(): void {
    // Cleared first: a restore that throws part-way must not be retried
    // against slots it already handed back.
    const installed = this.installed;
    this.installed = [];
    for (const { spec, original, wrapped } of installed.reverse()) {
      try {
        if (spec.get() === wrapped) spec.set(original);
      } catch (error) {
        handleError(error);
      }
    }
  }

  get isEmpty(): boolean {
    return this.installed.length === 0;
  }
}
