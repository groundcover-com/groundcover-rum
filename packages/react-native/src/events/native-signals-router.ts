import { handleError } from "@groundcover/rum-core";

import { subscribeNativeSignals, type NativeSubscription } from "../platform/native-bridge";
import type { GroundcoverNativeModule, NativeSignal } from "../platform/native-types";

// Owns the ONE emitter subscription and fans signals out by kind.
//
// One subscription rather than one per listener: the native side emits on a
// single channel, and a subscription per feature would mean N teardowns to get
// right instead of one. A duplicated subscription after a re-init is the
// classic way this leaks — every hang then reports twice — so the router is the
// single place that owns add and remove.

export type NativeSignalHandlers = {
  [K in NativeSignal["kind"]]?: (payload: Extract<NativeSignal, { kind: K }>["payload"]) => void;
};

export class NativeSignalsRouter {
  private subscription: NativeSubscription | null = null;
  private handlers: NativeSignalHandlers = {};

  constructor(private readonly native: GroundcoverNativeModule) {}

  initialize(handlers: NativeSignalHandlers): void {
    // Idempotent: a second initialize() must not stack a second subscription.
    if (this.subscription) return;

    this.handlers = handlers;
    this.subscription = subscribeNativeSignals(this.native, (signal) => this.dispatch(signal));
  }

  /**
   * Detaches the one subscription. Returns whether it actually detached: if the emitter's
   * `remove()` failed (already reported by the bridge), the subscription is KEPT rather than
   * nulled, so a later `initialize()` no-ops on the guard above instead of stacking a second
   * listener — the caller decides whether to drop this router based on the return. Dispatch still
   * routes harmlessly in the meantime, since the owner nulls its listeners on teardown.
   */
  destroy(): boolean {
    const detached = this.subscription ? this.subscription.remove() : true;
    if (detached) {
      this.subscription = null;
      this.handlers = {};
    }
    return detached;
  }

  private dispatch(signal: NativeSignal): void {
    try {
      // `NativeSignalHandlers` is a mapped type over `NativeSignal["kind"]`, so the handler
      // for a kind takes exactly that kind's payload — but TS can't prove that correlation
      // through a dynamic index (handler and payload widen to their unions independently), so
      // the payload is cast at this one boundary. Registration in `initialize` is still fully
      // type-checked. An unregistered kind (e.g. `ping`, which only proves the emitter is wired
      // end to end) has no handler and is a no-op — a switch with explicit cases would add nothing.
      const handler = this.handlers[signal.kind] as ((payload: unknown) => void) | undefined;
      handler?.(signal.payload);
    } catch (error) {
      handleError(error);
    }
  }
}
