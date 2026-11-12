import type { ConfigExtension } from "@groundcover/rum-core";
import { isReactFiber } from "../react/opaque-node";

// React Native's additions to core's option schema: the option 0.0.1-rc.1
// removed, and the fibers privacy redaction must never walk into.
export const RN_CONFIG_EXTENSION: ConfigExtension = {
  isOpaqueNode: isReactFiber,
  removedOptions: {
    eventSampleRate:
      "[groundcover] `options.eventSampleRate` was removed and is ignored. "
      + "Events are no longer randomly sampled; event volume may increase. "
      + "Use `options.sessionSampleRate` to select whole sessions; rates are not automatically converted. "
      + "See \"Migrating from 0.0.1-rc.0\" in the README: "
      + "https://www.npmjs.com/package/@groundcover/react-native",
  },
};
