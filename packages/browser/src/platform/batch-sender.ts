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
// ordinary fetch, leaving the small keepalive budget to the sends that need it.
export function createWebBatchSender(): BatchSender {
  return (endpoint, request, options) => {
    if (options?.lifecycle && request.body.byteLength <= KEEPALIVE_BODY_LIMIT_BYTES) {
      return fetch(endpoint, { ...request, keepalive: true });
    }
    return fetch(endpoint, request);
  };
}
