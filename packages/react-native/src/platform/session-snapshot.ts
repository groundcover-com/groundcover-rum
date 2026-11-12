import { handleError, type SessionAttributes } from "@groundcover/rum-core";

import type { ScreenAttributes } from "../events/rn-event-types";
import type { GroundcoverNativeModule } from "./native-types";

// Keeps native's copy of the session envelope current. A crash kills the JS runtime, so native
// must already hold everything needed to attribute the report: the exact `sessionAttributes` a
// live batch would carry, plus the screen. Native persists it, pairs it with whatever crash it
// captures, and the next launch reports that crash under the session it happened in.
//
// The envelope comes from `EventsPool.getSessionAttributes()` rather than being reassembled here,
// so a drained crash batch is byte-identical to a live one.

export type SessionSnapshot = SessionAttributes & {
  /** The screen at snapshot time — stamped as `screen` on the drained event. */
  screen: ScreenAttributes;
};

export interface NativeSnapshotPusherDeps {
  native: GroundcoverNativeModule | null;
  getSessionAttributes: () => SessionAttributes;
  getScreen: () => ScreenAttributes;
}

export class NativeSnapshotPusher {
  constructor(private readonly deps: NativeSnapshotPusherDeps) {}

  /**
   * Fire-and-forget. A failed push leaves native holding the PREVIOUS envelope,
   * so a crash lands with slightly stale attributes (a pre-identifyUser user,
   * say) — strictly better than losing the report, and never a reason to
   * interrupt the JS pipeline.
   */
  push(): void {
    const native = this.deps.native;
    if (!native) return;

    try {
      const snapshot: SessionSnapshot = {
        ...this.deps.getSessionAttributes(),
        screen: this.deps.getScreen(),
      };
      native.updateSessionSnapshot(JSON.stringify(snapshot));
    } catch (error) {
      handleError(error);
    }
  }

  /**
   * Drops native's copy. Called on teardown: once the SDK is destroyed a later
   * crash belongs to no session, and attributing it to the dead one would
   * silently extend a session past its end.
   */
  clear(): void {
    const native = this.deps.native;
    if (!native) return;

    try {
      native.updateSessionSnapshot(null);
    } catch (error) {
      handleError(error);
    }
  }
}
