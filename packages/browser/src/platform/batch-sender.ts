import type { BatchSender } from "@groundcover/rum-core/transporter/transporter";

// Browsers cap what keepalive requests may carry: 64 KiB of body in flight per
// page, all keepalive requests together (the Fetch spec's limit). A keepalive
// fetch past it is refused outright, so a bigger batch goes without it.
export const KEEPALIVE_BODY_LIMIT_BYTES = 64 * 1024;

// The browser's network primitive. `fetch` is resolved at call time rather than
// captured, so a host that installs its own fetch after init still sees it (and
// so our own network listener can instrument around it).
//
// Every batch that fits the limit is a `keepalive` request, so it outlives the
// page: the visitor may leave while it is in flight, and the browser cancels an
// ordinary request with the page, after the CORS preflight and before the batch
// is sent. A bigger batch goes as an ordinary request.
//
// The limit counts every keepalive request in flight on the page, the app's own
// (`sendBeacon` too) as well as ours, so the browser can still refuse one that
// fits by itself. A refused request is sent again once without keepalive.
// (Any rejection is retried: fetch doesn't say why it failed.)
export function createWebBatchSender(): BatchSender {
  return (endpoint, request) => {
    if (request.body.byteLength > KEEPALIVE_BODY_LIMIT_BYTES) {
      return fetch(endpoint, request);
    }
    return fetch(endpoint, { ...request, keepalive: true }).catch(() => fetch(endpoint, request));
  };
}
