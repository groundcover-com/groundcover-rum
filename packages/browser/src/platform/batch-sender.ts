import type { BatchSender } from "@groundcover/rum-core/transporter/transporter";

// Browsers cap what keepalive requests may carry: 64 KiB of body in flight per
// page, all keepalive requests together (the Fetch spec's limit). A keepalive
// fetch past it is refused outright, so a bigger batch goes without it.
export const KEEPALIVE_BODY_LIMIT_BYTES = 64 * 1024;

// The browser's network primitive. `fetch` is resolved at call time rather than
// captured, so a host that installs its own fetch after init still sees it (and
// so our own network listener can instrument around it).
//
// A lifecycle send (the page is being hidden or left) asks for `keepalive`: the
// page may be torn down right after the call, and the browser cancels an
// ordinary request with it, after the CORS preflight and before the batch is
// sent. A keepalive request outlives the page. Every other send stays an
// ordinary fetch: the keepalive budget is shared with the app's own requests
// (its `sendBeacon` calls too), so the SDK spends it only on the send that
// needs it.
//
// That shared budget can also be in use when the page hides, so the browser can
// refuse a keepalive request that fits by itself. A refused one is sent again
// once without keepalive, which still arrives if the page stays open (a tab
// switch). Any rejection is retried, since fetch doesn't say why it failed; an
// HTTP error status resolves and is not retried.
export function createWebBatchSender(): BatchSender {
  return (endpoint, request, options) => {
    if (options?.lifecycle && request.body.byteLength <= KEEPALIVE_BODY_LIMIT_BYTES) {
      return fetch(endpoint, { ...request, keepalive: true }).catch(() => fetch(endpoint, request));
    }
    return fetch(endpoint, request);
  };
}
