import type { ConfigExtension } from "@groundcover/rum-core/config/sdk-config";
import { isDomNode } from "../common/dom-node";

// The browser's additions to core's option schema: the rrweb replay slots,
// the options the browser SDK removed in its 1.x/2.x migrations, and the DOM
// nodes privacy redaction must never walk into.
export const BROWSER_CONFIG_EXTENSION: ConfigExtension = {
  isOpaqueNode: isDomNode,
  // `replay` is its own group; `replay.canvas` and `privacy.replay`
  // (`{maskTextFn,maskInputFn}`) merge a level deeper so a partial update keeps
  // the sibling fields — e.g. an fps-only canvas update must not drop `enabled`.
  nestedOptions: {
    replay: ["canvas"],
    privacy: ["replay"],
  },
  defaults: { replay: {} },
  removedOptions: {
    enableMasking:
      "[groundcover] `options.enableMasking` was removed in 1.0.0 and is ignored. "
      + "Configure masking via `options.privacy` instead — see \"Migrating to 1.0.0\" in the README: "
      + "https://www.npmjs.com/package/@groundcover/browser",
    maskFields:
      "[groundcover] `options.maskFields` was removed in 1.0.0 and is ignored. "
      + "Configure masking via `options.privacy` instead — see \"Migrating to 1.0.0\" in the README: "
      + "https://www.npmjs.com/package/@groundcover/browser",
    eventSampleRate:
      "[groundcover] `options.eventSampleRate` was removed and is ignored. "
      + "Events are no longer randomly sampled; event volume may increase. "
      + "Use `options.sessionSampleRate` to select whole sessions; rates are not automatically converted. "
      + "See \"Migrating from 1.x to 2.0.0\" in the README: "
      + "https://www.npmjs.com/package/@groundcover/browser",
  },
};
