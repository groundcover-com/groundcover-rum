import { AppState, type NativeEventSubscription } from "react-native";
import { handleError, type SessionLifecycle } from "@groundcover/rum-core";
import type { RNEventType } from "./rn-event-types";

// Presence signal source for React Native. The browser watches raw DOM input;
// RN watches AppState "active" transitions (taps are the other source, fed via
// the touch bridge). A return to "active" drives reconcile(now, true), which
// gap-rotates a session when the user comes back after 30+ min and confirms it
// (opening the send gate) for a genuinely-foregrounded app.
//
// No idle timer: the browser's exists only to pause replay recording, which RN
// does not ship; gap rotation is already lazy.
export class RNPresenceMonitor {
  private sub: NativeEventSubscription | null = null;

  constructor(private readonly lifecycle: SessionLifecycle<void, RNEventType>) {}

  initialize(): void {
    if (this.sub) return;
    try {
      let previousState = AppState.currentState;

      this.sub = AppState.addEventListener("change", (state) => {
        const returnedToForeground =
          state === "active" &&
          (previousState === "background" || previousState === "inactive");

        previousState = state;

        if (returnedToForeground) {
          this.lifecycle.reconcile(Date.now(), true);
        }
      });
    } catch (error) {
      handleError(error);
    }
  }

  destroy(): void {
    try {
      this.sub?.remove();
    } catch (error) {
      handleError(error);
    }
    this.sub = null;
  }
}
